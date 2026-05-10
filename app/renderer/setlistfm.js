/* ── setlistfm.js — setlist.fm API client (stub for v1.12) ──────────────────
 *
 * Loads the API key from config.js (via main-process IPC, same pattern as
 * lastfm.js) on module init. Real API calls land in v1.13 — this stub
 * exists so the v1.12 plumbing is in place and tested.
 *
 * Why stub now: doing the wiring now means v1.13 can focus purely on the
 * data layer + caching strategy without also designing the IPC bridge.
 *
 * Coverage when implemented:
 *   • Authoritative per-song play counts (solves the Bertha undercount)
 *   • Tour groupings (enables a deferred Tour view feature)
 *   • Cross-source attendance enrichment
 *
 * Free-tier rate limit: 2 req/sec, so the real implementation in v1.13
 * will need persistent caching to localforage + a request queue.
 *
 * Public API surface (planned, not yet live):
 *   isAvailable()                 — true if SETLIST_FM_KEY is configured
 *   findArtist(name)              — returns [{ mbid, name, sortName }]
 *   artistSetlists(mbid, page=1)  — paginated, includes setlists & tour
 *   setlistDetail(setlistId)      — full setlist with songs + venue
 *   songPlayCount(mbid, song)     — derived from cached setlists
 * ──────────────────────────────────────────────────────────────────────── */

let API_KEY = '';

/** Initialised at app boot. Returns true once a key is loaded. */
export async function initSetlistFm() {
  try {
    const k = await window.ipc?.getSetlistFmKey?.();
    if (typeof k === 'string' && k.length > 0) {
      API_KEY = k;
      return true;
    }
  } catch (err) {
    console.warn('[setlistfm] init failed:', err.message);
  }
  return false;
}

/** Lightweight check — features that depend on setlist.fm should call this
 *  before doing UI work, and gracefully fall back when it returns false. */
export function isAvailable() {
  return API_KEY.length > 0;
}

/** Internal — wraps `fetch` with the headers setlist.fm requires. Will be
 *  used by every endpoint helper in v1.13. Exposed now so v1.12 can import
 *  the function shape without errors when callers are wired. */
export async function setlistFmFetch(path, params = {}) {
  if (!API_KEY) throw new Error('setlist.fm key not configured');
  const url = new URL(`https://api.setlist.fm/rest/1.0${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const r = await fetch(url, {
    headers: {
      'x-api-key':  API_KEY,
      'Accept':     'application/json',
    },
  });
  if (!r.ok) throw new Error(`setlist.fm ${r.status}`);
  return r.json();
}
