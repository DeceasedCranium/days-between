/* ── lastfm.js — scrobbling, artist bio, radio ─── */
import { esc, safeInnerHTML, showToast } from './utils.js';

// LFM_KEY is injected at boot via IPC — never hardcode
let LFM_KEY = '';
export function setLfmKey(k) { LFM_KEY = k; }
export function getLfmKey()  { return LFM_KEY; }

/* ── Wikipedia artist data ───────────────────────── */
const _wikiCache = new Map();

export async function wikiArtistData(name) {
  if (!name) return null;
  if (_wikiCache.has(name)) return _wikiCache.get(name);
  try {
    const url  = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}`;
    const data = await fetch(url, { headers: { 'Accept': 'application/json' } }).then(r => r.json());
    const result = {
      image:       data?.thumbnail?.source ?? data?.originalimage?.source ?? null,
      bio:         data?.extract            ?? null,
      description: data?.description        ?? null,
      wikiUrl:     data?.content_urls?.desktop?.page ?? null,
    };
    _wikiCache.set(name, result);
    return result;
  } catch (err) {
    console.error('[lastfm] wikiArtistData', err);
    _wikiCache.set(name, null);
    return null;
  }
}

export async function lastfmArtistImage(name) {
  return (await wikiArtistData(name))?.image ?? null;
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

  load() {
    try {
      this.session = JSON.parse(localStorage.getItem('lfm_session') ?? 'null');
    } catch (err) { console.error('[lastfm] lfm.load', err); }
  },

  save() {
    if (this.session) localStorage.setItem('lfm_session', JSON.stringify(this.session));
    else localStorage.removeItem('lfm_session');
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

lfm.load();
