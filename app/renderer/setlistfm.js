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
import { aggregateSongCountsFromSetlists, normaliseSongTitle } from '../shared/helpers.js';

let API_KEY = '';

const REQUEST_INTERVAL_MS = 600;
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
      'x-api-key':  API_KEY,
      'Accept':     'application/json',
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
    if (cached?.counts) {
      // Rehydrate Map from the persisted plain object.
      const map = new Map();
      for (const [k, v] of Object.entries(cached.counts)) map.set(k, v);
      return map;
    }
  }

  try {
    const setlists = await fetchAllSetlists(mbid, onProgress);
    const counts   = aggregateSongCountsFromSetlists(setlists);
    // Persist as plain object (Map doesn't survive JSON).
    await writeCache(cacheKey, {
      counts:        Object.fromEntries(counts),
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

/** Convenience wrapper — returns the count for ONE specific song by name.
 *  Returns null when data is unavailable. */
export async function getSongPlayCount(artist, songName, opts = {}) {
  const counts = await getArtistSongCounts(artist, opts);
  if (!counts) return null;
  return counts.get(normaliseSongTitle(songName)) ?? 0;
}
