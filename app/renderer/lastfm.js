/* ── lastfm.js — scrobbling, artist bio, radio ─── */
import { esc, safeInnerHTML, showToast } from './utils.js';
import { getLfmSession, setLfmSession }  from './state.js';

// LFM_KEY is injected at boot via IPC — never hardcode
let LFM_KEY = '';
export function setLfmKey(k) { LFM_KEY = k; }
export function getLfmKey()  { return LFM_KEY; }

/* ── Wikipedia artist data ─────────────────────────────────────────────────
 * Two-layer cache:
 *   • In-memory `_wikiCache` for the running session.
 *   • localStorage `db-wiki-cache` persists across launches with a 30-day
 *     TTL so subsequent app starts render artist images instantly. Stored
 *     as { name → { v: result, ts: ms } } and JSON-encoded.
 *
 * Concurrency: hits to en.wikipedia.org/api/rest_v1 are limited to 4 at a
 * time. Without this the welcome view bursts 30+ simultaneous requests,
 * Wikipedia returns 429s, and the cascade of retries stretches the
 * "feel-fast" window into many seconds.
 * ──────────────────────────────────────────────────────────────────────── */
const WIKI_CACHE_KEY  = 'db-wiki-cache';
const WIKI_TTL_MS     = 30 * 24 * 60 * 60 * 1000; // 30 days
const _wikiCache      = new Map();
const _wikiInflight   = new Map(); // dedup parallel callers for the same name

// Hydrate the in-memory map from localStorage on first import.
(function hydrateWikiCache() {
  try {
    const raw  = localStorage.getItem(WIKI_CACHE_KEY);
    if (!raw) return;
    const obj  = JSON.parse(raw);
    const now  = Date.now();
    for (const [name, entry] of Object.entries(obj)) {
      if (entry?.ts && now - entry.ts < WIKI_TTL_MS) {
        _wikiCache.set(name, entry.v);
      }
    }
  } catch { /* corrupted cache — ignore */ }
})();

let _wikiPersistTimer = null;
function persistWikiCache() {
  // Debounced — coalesce many writes during a welcome-view burst.
  clearTimeout(_wikiPersistTimer);
  _wikiPersistTimer = setTimeout(() => {
    try {
      const obj = {};
      const now = Date.now();
      for (const [name, v] of _wikiCache.entries()) {
        obj[name] = { v, ts: now };
      }
      localStorage.setItem(WIKI_CACHE_KEY, JSON.stringify(obj));
    } catch { /* quota exceeded — drop silently */ }
  }, 1500);
}

// Tiny semaphore — caps simultaneous Wikipedia fetches.
const WIKI_CONCURRENCY = 4;
let _wikiActive = 0;
const _wikiQueue = [];
function wikiAcquire() {
  return new Promise(resolve => {
    if (_wikiActive < WIKI_CONCURRENCY) {
      _wikiActive++;
      resolve();
    } else {
      _wikiQueue.push(resolve);
    }
  });
}
function wikiRelease() {
  _wikiActive--;
  const next = _wikiQueue.shift();
  if (next) { _wikiActive++; next(); }
}

// Aggregate diagnostic — logs once after a burst of resolves so we can see
// hit/miss/error counts without spamming. Uses inline string so the numbers
// are readable without expanding a console object.
let _wikiStats = { hit: 0, fetched: 0, notFound: 0, transient: 0, error: 0 };
let _wikiStatsTimer = null;
function logWikiStats() {
  clearTimeout(_wikiStatsTimer);
  _wikiStatsTimer = setTimeout(() => {
    const s = _wikiStats;
    console.info(`[wiki] batch — cache hits:${s.hit} fetched:${s.fetched} 404s:${s.notFound} transient:${s.transient} errors:${s.error}`);
    _wikiStats = { hit: 0, fetched: 0, notFound: 0, transient: 0, error: 0 };
  }, 2500);
}

export async function wikiArtistData(name) {
  if (!name) return null;
  if (_wikiCache.has(name)) {
    _wikiStats.hit++; logWikiStats();
    return _wikiCache.get(name);
  }
  if (_wikiInflight.has(name)) return _wikiInflight.get(name);

  const p = (async () => {
    await wikiAcquire();
    try {
      const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}`;
      const r   = await fetch(url, { headers: { 'Accept': 'application/json' } });
      // Only cache DEFINITIVE responses. Transient errors (429 rate limit,
      // 5xx server errors) get returned as null but NOT cached, so the next
      // visit can retry. This avoids poisoning the cache during a burst
      // where Wikipedia rate-limits us.
      if (r.status === 404) {
        _wikiCache.set(name, null);
        persistWikiCache();
        _wikiStats.notFound++; logWikiStats();
        return null;
      }
      if (!r.ok) {
        // 429, 5xx, redirect-loops, etc. — don't cache, try again next time.
        _wikiStats.transient++; logWikiStats();
        return null;
      }
      const data   = await r.json();
      const result = {
        image:       data?.thumbnail?.source ?? data?.originalimage?.source ?? null,
        bio:         data?.extract            ?? null,
        description: data?.description        ?? null,
        wikiUrl:     data?.content_urls?.desktop?.page ?? null,
      };
      _wikiCache.set(name, result);
      persistWikiCache();
      _wikiStats.fetched++; logWikiStats();
      return result;
    } catch (err) {
      // Network blip — don't cache so next visit can retry.
      _wikiStats.error++; logWikiStats();
      return null;
    } finally {
      wikiRelease();
      _wikiInflight.delete(name);
    }
  })();
  _wikiInflight.set(name, p);
  return p;
}

/* ── Last.fm artist.getInfo image fallback ─────────────────────────────────
 * Wikipedia 404s for niche jam/bluegrass/touring acts. Last.fm has a much
 * wider artist database. This calls artist.getInfo and digests the image
 * array. Cached + concurrency-limited via the same Wikipedia infrastructure
 * (separate cache namespace `db-lfm-img-cache`).
 *
 * Last.fm has been deprecating their image URLs over the years — many
 * responses now ship a generic placeholder ("2a96cbd8b46e442fc41c2b86b821562f")
 * which we filter out so we don't show the same gray silhouette to every
 * mystery artist. Returns null if no real image is available.
 * ──────────────────────────────────────────────────────────────────────── */
const LFM_IMG_CACHE_KEY = 'db-lfm-img-cache';
const _lfmImgCache    = new Map();
const _lfmImgInflight = new Map();

(function hydrateLfmImgCache() {
  try {
    const raw = localStorage.getItem(LFM_IMG_CACHE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    const now = Date.now();
    for (const [name, entry] of Object.entries(obj)) {
      if (entry?.ts && now - entry.ts < WIKI_TTL_MS) {
        _lfmImgCache.set(name, entry.v);
      }
    }
  } catch {}
})();

let _lfmImgPersistTimer = null;
function persistLfmImgCache() {
  clearTimeout(_lfmImgPersistTimer);
  _lfmImgPersistTimer = setTimeout(() => {
    try {
      const obj = {};
      const now = Date.now();
      for (const [name, v] of _lfmImgCache.entries()) obj[name] = { v, ts: now };
      localStorage.setItem(LFM_IMG_CACHE_KEY, JSON.stringify(obj));
    } catch {}
  }, 1500);
}

// Last.fm's "no image" placeholder hash — return null if we see this so the
// caller's colored-initial fallback shows instead of a generic gray box.
const LFM_PLACEHOLDER_HASH = '2a96cbd8b46e442fc41c2b86b821562f';

async function lfmArtistImage(name) {
  if (!name) return null;
  if (!LFM_KEY) return null; // user hasn't configured config.js
  if (_lfmImgCache.has(name))    return _lfmImgCache.get(name);
  if (_lfmImgInflight.has(name)) return _lfmImgInflight.get(name);

  const p = (async () => {
    await wikiAcquire(); // share the same concurrency budget as Wikipedia
    try {
      const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getInfo`
        + `&artist=${encodeURIComponent(name)}&api_key=${LFM_KEY}&format=json&autocorrect=1`;
      const r = await fetch(url);
      if (r.status === 404) {
        _lfmImgCache.set(name, null);
        persistLfmImgCache();
        return null;
      }
      if (!r.ok) return null;
      const data = await r.json();
      const images = data?.artist?.image ?? [];
      // Pick the largest non-placeholder image. Sizes: small/medium/large/extralarge/mega.
      const ordered = ['mega', 'extralarge', 'large', 'medium', 'small'];
      let chosen = null;
      for (const size of ordered) {
        const hit = images.find(i => i.size === size && i['#text']);
        if (!hit) continue;
        if (hit['#text'].includes(LFM_PLACEHOLDER_HASH)) continue;
        chosen = hit['#text'];
        break;
      }
      _lfmImgCache.set(name, chosen);
      persistLfmImgCache();
      return chosen;
    } catch {
      return null;
    } finally {
      wikiRelease();
      _lfmImgInflight.delete(name);
    }
  })();
  _lfmImgInflight.set(name, p);
  return p;
}

/** Resolve an artist image URL. Tries Wikipedia first (returns higher-
 *  quality images for major artists), falls back to Last.fm artist.getInfo
 *  for niche / touring / jam artists Wikipedia doesn't have. Returns null
 *  if neither source has a usable image — the caller should use its
 *  colored-initial fallback. */
export async function lastfmArtistImage(name) {
  const fromWiki = (await wikiArtistData(name))?.image ?? null;
  if (fromWiki) return fromWiki;
  return lfmArtistImage(name);
}

export async function injectArtistBio(artistName) {
  const bioEl = document.getElementById('artistBioCard');
  if (!bioEl) return;
  const [wiki, lfmData] = await Promise.all([
    wikiArtistData(artistName),
    fetch(`https://ws.audioscrobbler.com/2.0/?method=artist.getInfo&artist=${encodeURIComponent(artistName)}&api_key=${LFM_KEY}&format=json`)
      .then(r => r.json()).catch(() => null),
  ]);
  const bio     = wiki?.bio     ?? null;
  const desc    = wiki?.description ?? null;
  const wikiUrl = wiki?.wikiUrl  ?? null;
  const lfmUrl  = lfmData?.artist?.url ?? null;
  if (!bio && !wikiUrl && !lfmUrl) { bioEl.remove(); return; }
  bioEl.classList.remove('loading');
  // safeInnerHTML strips any on* attrs from API-sourced content; esc() is primary protection
  safeInnerHTML(bioEl, `
    ${desc ? `<div class="artist-bio-desc">${esc(desc)}</div>` : ''}
    ${bio  ? `<p class="artist-bio-text">${esc(bio)}</p>`       : ''}
    <div class="artist-bio-links">
      ${wikiUrl ? `<button class="bio-link-btn" data-url="${esc(wikiUrl)}">Wikipedia</button>` : ''}
      ${lfmUrl  ? `<button class="bio-link-btn" data-url="${esc(lfmUrl)}">Last.fm</button>`    : ''}
    </div>`);
  bioEl.querySelectorAll('.bio-link-btn').forEach(btn =>
    btn.addEventListener('click', () => window.ipc?.openUrl(btn.dataset.url)));
}

/* ── Similar artists (radio) ─────────────────────── */
const _lfmSimilarCache = new Map();

export async function lastfmSimilarArtists(name) {
  if (_lfmSimilarCache.has(name)) return _lfmSimilarCache.get(name);
  try {
    const url     = `https://ws.audioscrobbler.com/2.0/?method=artist.getSimilar&artist=${encodeURIComponent(name)}&api_key=${LFM_KEY}&limit=30&format=json`;
    const artists = (await fetch(url).then(r => r.json()))
      ?.similarartists?.artist?.map(a => a.name) ?? [];
    _lfmSimilarCache.set(name, artists);
    return artists;
  } catch (err) {
    console.error('[lastfm] lastfmSimilarArtists', err);
    _lfmSimilarCache.set(name, []);
    return [];
  }
}

/* ── Scrobbling ──────────────────────────────────── */
export const lfm = {
  session:   null,   // { name, key }
  scrobbled: false,
  startTime: 0,
  timer:     null,

  // Called by app.js after loadAll() so the IndexedDB cache is ready
  load() {
    this.session = getLfmSession();
  },

  save() {
    setLfmSession(this.session || null);
  },

  get sk() { return this.session?.key ?? null; },

  onTrackStart(track, artist, show) {
    if (!this.sk) return;
    clearTimeout(this.timer);
    this.scrobbled = false;
    this.startTime = Math.floor(Date.now() / 1000);
    const t   = track.title ?? '';
    const a   = artist?.name ?? '';
    const al  = show?.display_date ?? '';
    const dur = track.duration ?? 0;
    window.ipc?.lfmNowPlaying({ track: t, artist: a, album: al, duration: dur, sk: this.sk });
    // Scrobble at 50% of track length, capped at 4 min
    const delay = Math.min(dur > 0 ? dur * 500 : 120000, 240000);
    this.timer = setTimeout(() => {
      if (!this.scrobbled) {
        this.scrobbled = true;
        window.ipc?.lfmScrobble({
          track: t, artist: a, album: al,
          timestamp: this.startTime, duration: dur, sk: this.sk,
        });
        showToast(`Scrobbled: ${t}`);
      }
    }, delay);
  },
};

// lfm.load() is called by app.js after loadAll() completes

/* When the main process detects a Last.fm session-invalid response (codes 4/9)
 * it sends `lfm:session-invalid` back here. Wipe the stored session so we
 * stop firing scrobble requests against a dead `sk`, and toast the user once
 * with clear guidance. The same channel may fire many times before we react,
 * so we no-op on already-cleared sessions. */
window.ipc?.on('lfm:session-invalid', () => {
  if (!lfm.session) return;
  lfm.session = null;
  lfm.save();
  try { showToast('Last.fm session expired — reconnect in Settings'); } catch {}
});
