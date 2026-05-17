/* ── setlistfm.js — setlist.fm API client ──────────────────────────────────
 *
 * Provides authoritative per-song play counts for an artist using
 * setlist.fm's community-curated setlist database. Setlist.fm has wider
 * coverage than Relisten alone for jam bands — it tracks shows that don't
 * have recordings, which is exactly what fixes the "Bertha was played 77
 * times" undercount we saw on Dead & Company.
 *
 * Architecture
 * ─────────────
 * 1. Rate-limited fetch wrapper — 600ms gap between requests (~1.67 req/sec,
 *    safely under setlist.fm's free-tier 2 req/sec cap). Concurrent callers
 *    are serialised through a promise-chain queue so we never burst.
 *
 * 2. Two-tier cache (localforage / IndexedDB):
 *    - `db-setlistfm-mbid:<lowercase artist name>` → { mbid, fetchedAt }
 *      30-day TTL. Artist MBIDs almost never change.
 *    - `db-setlistfm-songs:<mbid>` → { counts, totalSetlists, lastUpdated, name }
 *      7-day TTL. Setlist data updates as new shows are added.
 *
 * 3. Lazy / opportunistic — nothing prefetches at app boot. Calls happen
 *    only when the song-detail page asks for a count. Cached results are
 *    instant; first hit per artist takes ~6-60s depending on catalog size.
 *
 * Public API
 * ──────────
 *   initSetlistFm()                    — load API key from main process
 *   isAvailable()                      — true once a key is configured
 *   getArtistSongCounts(artist, opts)  — Map<normalisedKey, count>
 *
 * `artist` should have at least `{ name }`. If `musicbrainz_id` is present
 * (Relisten artists carry it directly), we skip the search step.
 *
 * `opts.onProgress(scanned, total)` fires per page during the fetch loop
 * so callers can render a progress bar.
 *
 * `opts.forceRefresh` bypasses the cache (for a "Refresh" button later).
 *
 * The function returns null when:
 *   - setlist.fm key not configured
 *   - artist has no setlist.fm presence (search returns 0 hits)
 *   - any unexpected error happens (logged but not thrown)
 * Callers must handle null gracefully — features built on this should
 * stay dormant when setlist.fm data isn't available.
 * ────────────────────────────────────────────────────────────────────── */

import localforage from './localforage-esm.js';
import { aggregateSongCountsFromSetlists, normaliseSongTitle, nugsIsoDate } from '../shared/helpers.js';

let API_KEY = '';

// 850ms gap = ~1.18 req/sec. Documented free-tier ceiling is 2/sec but
// setlist.fm's gateway throttles tighter in practice for sustained
// bursts. 850ms keeps Dead-sized scans (1,000+ shows = 50+ pages) below
// the burst threshold so we hit 429 once or twice at most instead of
// every fourth page.
const REQUEST_INTERVAL_MS = 850;
const SETLIST_API_BASE    = 'https://api.setlist.fm/rest/1.0';
const SETLIST_TTL_MS      = 7  * 24 * 60 * 60 * 1000;   // 7 days
const MBID_TTL_MS         = 30 * 24 * 60 * 60 * 1000;   // 30 days
const PAGE_SIZE           = 20;                          // setlist.fm fixed
const SAFETY_PAGE_LIMIT   = 200;                         // cap total fetches

/* ── Init ───────────────────────────────────────────────────────────────── */

export async function initSetlistFm() {
  try {
    const k = await window.ipc?.getSetlistFmKey?.();
    if (typeof k === 'string' && k.length > 0) {
      API_KEY = k;
      console.info('[setlistfm] key loaded — live integration available');
      return true;
    }
  } catch (err) {
    console.warn('[setlistfm] init failed:', err.message);
  }
  return false;
}

export function isAvailable() {
  return API_KEY.length > 0;
}

/* ── Rate-limited fetch ─────────────────────────────────────────────────── */

let _nextSlot = 0;
async function rateLimitedFetch(url, opts = {}) {
  // Reserve the next available slot atomically — concurrent callers each
  // get a unique slot 600ms apart.
  const slot = Math.max(_nextSlot, Date.now());
  _nextSlot  = slot + REQUEST_INTERVAL_MS;
  const wait = slot - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  return fetch(url, {
    ...opts,
    headers: {
      'x-api-key':       API_KEY,
      'Accept':          'application/json',
      // setlist.fm uses Accept-Language for response internationalisation
      // and started 406-ing on /artist/{mbid}/setlists when it's missing.
      // Pin to English — track titles and venue names are typically
      // English-native anyway, and we want stable strings for matching.
      'Accept-Language': 'en',
      // setlist.fm gateway occasionally rejects fetches with the default
      // Electron / Chromium UA. Pinning to a vanilla browser UA matches
      // what their docs expect from API clients.
      'User-Agent':      'DaysBetween/2.x (+https://github.com/DeceasedCranium/days-between)',
      ...(opts.headers ?? {}),
    },
  });
}

async function setlistFmFetch(path, params = {}) {
  if (!API_KEY) throw new Error('setlist.fm key not configured');
  const url = new URL(`${SETLIST_API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const r = await rateLimitedFetch(url.toString());
  if (r.status === 429) {
    // Hit the rate limit — back off and retry once. Setlist.fm's docs say
    // pause for at least 10s. We're conservative (15s).
    console.warn('[setlistfm] 429 rate-limited — backing off 15s');
    await new Promise(res => setTimeout(res, 15_000));
    const retry = await rateLimitedFetch(url.toString());
    if (!retry.ok) throw new Error(`setlist.fm ${retry.status} after retry`);
    return retry.json();
  }
  if (!r.ok) throw new Error(`setlist.fm ${r.status}`);
  return r.json();
}

/* ── Cache helpers ──────────────────────────────────────────────────────── */

const MBID_CACHE_PREFIX  = 'db-setlistfm-mbid:';
const SONGS_CACHE_PREFIX = 'db-setlistfm-songs:';

async function readCache(key, ttlMs) {
  try {
    const v = await localforage.getItem(key);
    if (!v) return null;
    if (typeof v.fetchedAt === 'number' && Date.now() - v.fetchedAt < ttlMs) {
      return v;
    }
    return null;
  } catch { return null; }
}

async function writeCache(key, value) {
  try {
    await localforage.setItem(key, { ...value, fetchedAt: Date.now() });
  } catch (err) {
    console.warn('[setlistfm] cache write failed:', err.message);
  }
}

/* ── MBID resolution ────────────────────────────────────────────────────── */

/** Find a setlist.fm-recognised MusicBrainz ID for an artist. Relisten
 *  artists already carry `musicbrainz_id`; we only hit the search endpoint
 *  for Nugs / artists without one. Cached for 30 days. Returns null when
 *  setlist.fm has no record of the artist. */
async function resolveArtistMbid(artist) {
  // Relisten artists ship the mbid directly.
  if (artist?.musicbrainz_id) return artist.musicbrainz_id;
  if (!artist?.name) return null;

  const cacheKey = MBID_CACHE_PREFIX + artist.name.toLowerCase();
  const cached   = await readCache(cacheKey, MBID_TTL_MS);
  if (cached) return cached.mbid;

  try {
    const data = await setlistFmFetch('/search/artists', {
      artistName: artist.name,
      p:          1,
      sort:       'relevance',
    });
    const hit = (data?.artist ?? [])[0];
    const mbid = hit?.mbid ?? null;
    await writeCache(cacheKey, { mbid, resolvedName: hit?.name ?? null });
    return mbid;
  } catch (err) {
    console.warn('[setlistfm] mbid search failed for', artist.name, '—', err.message);
    return null;
  }
}

/* ── Setlist pagination + aggregation ──────────────────────────────────── */

/** Fetch every setlist for an artist, paginated. Emits progress callbacks
 *  per page. Returns the full setlist array. Internal — callers should
 *  use `getArtistSongCounts`. */
async function fetchAllSetlists(mbid, onProgress) {
  const all = [];
  let page  = 1;
  let total = 0;

  while (page <= SAFETY_PAGE_LIMIT) {
    const data = await setlistFmFetch(`/artist/${mbid}/setlists`, { p: page });
    const pageSetlists = data?.setlist ?? [];
    if (!pageSetlists.length) break;
    all.push(...pageSetlists);
    total = data?.total ?? all.length;

    if (typeof onProgress === 'function') {
      onProgress(all.length, total);
    }
    if (all.length >= total) break;
    if (pageSetlists.length < PAGE_SIZE) break; // last page
    page++;
  }
  return all;
}

/* ── Public API ─────────────────────────────────────────────────────────── */

/** Returns a Map<normalisedSongKey, playCount> for the artist, sourced
 *  from setlist.fm. Cached per-mbid for 7 days. First call per artist
 *  triggers a paginated fetch (with progress callback). Returns null
 *  when setlist.fm isn't configured / artist isn't on setlist.fm /
 *  any unexpected error happens. */
export async function getArtistSongCounts(artist, opts = {}) {
  if (!isAvailable()) return null;
  if (!artist?.name)  return null;

  const { onProgress, forceRefresh = false } = opts;

  const mbid = await resolveArtistMbid(artist);
  if (!mbid) return null;

  const cacheKey = SONGS_CACHE_PREFIX + mbid;

  if (!forceRefresh) {
    const cached = await readCache(cacheKey, SETLIST_TTL_MS);
    // Pre-v2.2 caches have `counts` but no `setlists` field. Re-fetch so the
    // cache picks up the normalized setlists Advanced Search needs. This is
    // a one-time migration cost per artist per user; subsequent reads hit
    // the upgraded cache and short-circuit normally.
    //
    // `setlists.length > 0` is the important guard: a previous normalize
    // pass that produced ZERO valid setlists (every entry malformed —
    // setlist.fm date-format change, etc.) would otherwise mark the cache
    // permanently "upgraded" with no data, locking Advanced Search out of
    // that artist until the TTL expires or the user runs forceRefresh.
    const isUpgraded = Array.isArray(cached?.setlists) && cached.setlists.length > 0;
    if (cached?.counts && isUpgraded) {
      // Rehydrate Map from the persisted plain object.
      const map = new Map();
      for (const [k, v] of Object.entries(cached.counts)) map.set(k, v);
      return map;
    }
  }

  try {
    const setlists = await fetchAllSetlists(mbid, onProgress);
    const counts   = aggregateSongCountsFromSetlists(setlists);
    // Normalize and persist the raw setlists alongside the counts so the
    // v2.2 Advanced Search feature can run multi-criteria queries (venue,
    // date range, song + position, segue partners) entirely against the
    // local cache without hitting the setlist.fm API again. The
    // aggregateSongCountsFromSetlists pass already walks every setlist
    // we just fetched, so this normalization adds no new network cost.
    const normalized = setlists.map(normalizeSetlistForSearch).filter(Boolean);
    await writeCache(cacheKey, {
      counts:        Object.fromEntries(counts),
      setlists:      normalized,
      totalSetlists: setlists.length,
      mbid,
      artistName:    artist.name,
    });
    return counts;
  } catch (err) {
    console.warn('[setlistfm] fetch failed for', artist.name, '—', err.message);
    return null;
  }
}

/** Returns the normalized cached setlist array for the artist, or null if
 *  setlist.fm data isn't available / cached. Used by Advanced Search. The
 *  setlists are an opt-in side-effect of the song-counts cache flow — if
 *  the user has never opened a song-stats page for this artist, the cache
 *  won't be populated yet, and the caller should trigger a scan first
 *  (typically via getArtistSongCounts with a progress callback). */
export async function getArtistSetlists(artist, opts = {}) {
  if (!isAvailable()) return null;
  if (!artist?.name)  return null;
  const { forceRefresh = false } = opts;

  const mbid = await resolveArtistMbid(artist);
  if (!mbid) return null;
  const cacheKey = SONGS_CACHE_PREFIX + mbid;

  if (!forceRefresh) {
    const cached = await readCache(cacheKey, SETLIST_TTL_MS);
    if (Array.isArray(cached?.setlists)) return cached.setlists;
    // Cache exists but pre-dates v2.2 (only counts, no raw setlists) —
    // fall through so the caller can trigger getArtistSongCounts to
    // refresh the cache and get the full structure.
  }
  return null;
}

/** Convenience wrapper — returns the count for ONE specific song by name.
 *  Returns null when data is unavailable. */
export async function getSongPlayCount(artist, songName, opts = {}) {
  const counts = await getArtistSongCounts(artist, opts);
  if (!counts) return null;
  return counts.get(normaliseSongTitle(songName)) ?? 0;
}

/** Look up the cached setlist.fm setlist for an artist on a specific date
 *  and return a Map<normalised_song_title, set_label> derived from it.
 *  Used by the show-page renderers (Relisten + Nugs) to insert set headers
 *  into flat-or-weak-structure track lists.
 *
 *  Returns null cleanly when:
 *    • setlist.fm key not configured
 *    • no cached setlists for the artist (user hasn't opened a song-stats
 *      card or Advanced Search for them)
 *    • cache exists but no setlist matches the requested date
 *    • date string can't be normalised
 *
 *  Date input is forgiving — accepts ISO YYYY-MM-DD (Relisten format) or
 *  M/D/YYYY (Nugs format) by routing through `nugsIsoDate` for
 *  normalisation. */
export async function buildSetlistFmSongMap(artist, displayDate) {
  if (!isAvailable() || !artist?.name) return null;
  const isoDate = nugsIsoDate(displayDate);
  if (!isoDate) return null;

  let setlists;
  try { setlists = await getArtistSetlists(artist); }
  catch { return null; }
  if (!Array.isArray(setlists) || !setlists.length) return null;

  const setlist = setlists.find(sl => sl.date === isoDate);
  if (!setlist?.sets?.length) return null;

  const map = new Map();
  setlist.sets.forEach(set => {
    // Prefer the cached set label ('Set 1' / 'Set 2' / 'Encore' / 'Acoustic
    // Set' etc., produced by normalizeSetlistForSearch above). Fall back to
    // 'Encore' for encore-flagged sets that lost their label, else 'Set'.
    const label = set.label || (set.encore ? 'Encore' : 'Set');
    set.songs.forEach(song => {
      const k = normaliseSongTitle(song.name);
      if (k && !map.has(k)) map.set(k, label);
    });
  });
  return map;
}

/* ── setlist.fm payload → search-friendly normalized shape ─────────────────
 * setlist.fm ships its setlists in a verbose, partly-internationalised shape
 * with DD-MM-YYYY dates, nested venue/city/country objects, and optional
 * `name` / `encore` flags on each set. We slim this to a flat, predictable
 * structure that the Advanced Search helper can scan quickly without
 * traversing nested objects.
 *
 * Segue detection: setlist.fm doesn't ship a formal "segue" boolean, but the
 * convention in well-curated Dead/Phish setlists is to put a `>` or `->`
 * suffix on songs that segue into the next one. We strip the suffix from
 * the stored song name but preserve a `segue: true` flag so the search
 * helper can match "X → Y" queries.
 *
 * Returns null for malformed entries (no date / no sets) so the caller can
 * filter them out.
 * ─────────────────────────────────────────────────────────────────────── */
function normalizeSetlistForSearch(sl) {
  if (!sl || typeof sl !== 'object') return null;

  // setlist.fm ships eventDate as DD-MM-YYYY. Convert to ISO YYYY-MM-DD
  // so date-range filters and day-of-week derivation work cleanly.
  const raw = sl.eventDate ?? '';
  const m   = /^(\d{2})-(\d{2})-(\d{4})$/.exec(raw);
  const date = m ? `${m[3]}-${m[2]}-${m[1]}` : null;
  if (!date) return null;

  const v = sl.venue ?? {};
  const c = v.city  ?? {};

  // Walk sets, assigning a stable label ("Set 1" / "Set 2" / "Encore") so
  // position queries like "Set 2 opener" have something to match against.
  let nonEncoreCount = 0;
  let encoreCount    = 0;
  const setsIn  = sl.sets?.set ?? [];
  const sets    = [];
  for (const s of setsIn) {
    const isEncore = !!s?.encore;
    const songs    = (s?.song ?? [])
      .map(song => {
        const name = (song?.name ?? '').trim();
        if (!name) return null;
        const segueMatch = /\s*(?:->|>|~)\s*$/.exec(name);
        return {
          name:  segueMatch ? name.slice(0, segueMatch.index).trim() : name,
          segue: !!segueMatch,
          info:  song?.info ? String(song.info).trim() : null,
        };
      })
      .filter(Boolean);
    if (!songs.length) continue;

    let label;
    if (isEncore) {
      encoreCount += 1;
      label = encoreCount === 1 ? 'Encore' : `Encore ${encoreCount}`;
    } else {
      nonEncoreCount += 1;
      label = s?.name?.trim() || `Set ${nonEncoreCount}`;
    }

    sets.push({ label, encore: isEncore, songs });
  }

  if (!sets.length) return null;

  return {
    date,
    venue:   v.name ?? null,
    city:    c.name ?? null,
    state:   c.stateCode ?? c.state ?? null,
    country: c.country?.code ?? null,
    tour:    sl.tour?.name ?? null,
    sets,
  };
}
