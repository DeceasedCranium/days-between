/* ── state.js — shared mutable state and IndexedDB stores ─────── */
import { $ } from './utils.js';
import localforage from './localforage-esm.js';

/* ── localforage config ──────────────────────────── */
localforage.config({
  name:        'days-between',
  storeName:   'app_store',
  description: 'Days Between v1.1 persistent storage',
});

/* ── In-memory cache — populated at boot by loadAll() ────────────
   Reads are synchronous (from _cache); writes fire-and-forget to
   IndexedDB via _set() so callers need no await at call sites.
   ──────────────────────────────────────────────────────────────── */
const _cache = {};

function _set(key, val) {
  _cache[key] = val;
  localforage.setItem(key, val).catch(err => console.error('[state] persist', key, err));
}

function _remove(key) {
  _cache[key] = null;
  localforage.removeItem(key).catch(err => console.error('[state] remove', key, err));
}

// Load one key from IndexedDB; falls back to localStorage for v1.0→v1.1 migration
async function _load(key, def) {
  try {
    let val = await localforage.getItem(key);
    if (val === null) {
      const raw = localStorage.getItem(key);
      if (raw !== null) {
        try { val = JSON.parse(raw); } catch { val = raw; }
        await localforage.setItem(key, val);
        localStorage.removeItem(key);
        console.info('[state] migrated', key, 'localStorage → IndexedDB');
      }
    }
    _cache[key] = val ?? def;
  } catch (err) {
    console.error('[state] _load', key, err);
    _cache[key] = def;
  }
}

/* ── Boot loader — must complete before any UI renders ──────────── */
export async function loadAll() {
  await Promise.all([
    _load('db-favorites',     []),
    _load('db-artist-favs',   []),
    _load('db-history',       []),
    _load('db-ratings',       {}),
    _load('db-attended',      []),
    _load('db-bookmarks',     []),
    _load('db-settings',      {}),
    _load('db-nugs-auth',     null),
    _load('db-tapes',         []),
    _load('db-sidebar-source', 'relisten'),
    _load('db-nugs-artists',  []),
    _load('db-resume',        null),
    _load('lfm_session',      null),
  ]);
  // Update live-exported let bindings so importers see the persisted value
  sidebarSource = _cache['db-sidebar-source'] ?? 'relisten';
}

/* ── Resume state (read/written by app.js) ───────────────────── */
export function getResume()  { return _cache['db-resume'] ?? null; }
export function setResume(v) { _set('db-resume', v); }

/* ── LFM session (read/written by lastfm.js) ─────────────────── */
export function getLfmSession()  { return _cache['lfm_session'] ?? null; }
export function setLfmSession(v) {
  if (v) _set('lfm_session', v);
  else   _remove('lfm_session');
}

/* ── Player / nav state ──────────────────────────── */
export const state = {
  artists: [], filteredArtists: [],
  artist: null, year: null, show: null, source: null,
  queue: [], queueIdx: -1,
  shuffleOn: false, repeatMode: 'off', // 'off' | 'one' | 'all'
  originalQueue: [],
  // Stable player state — never cleared by navigation
  playingArtist: null, playingShow: null,
  // True when scraper detected a login wall (no active session in ghost window)
  nugsLoginRequired: false,
};

/* ── Nugs artist list ────────────────────────────── */
export const nugsArtistStore = {
  get()   { return _cache['db-nugs-artists'] ?? []; },
  save(v) { _set('db-nugs-artists', v); },
  add(id, name) {
    const all  = this.get();
    const slug = `nugs-${id}`;
    if (all.find(a => a.id === String(id))) return false;
    all.push({ id: String(id), name, slug, _nugs: true });
    this.save(all);
    return true;
  },
  remove(id) { this.save(this.get().filter(a => a.id !== String(id))); },
};

export const nugsReleasesCache = {};
export let sidebarSource = 'relisten'; // overwritten by loadAll()
export function setSidebarSource(v) {
  sidebarSource = v;
  _set('db-sidebar-source', v);
}

/* ── Favorites & History ─────────────────────────── */
export const store = {
  getFavs()    { return _cache['db-favorites'] ?? []; },
  saveFavs(v)  { _set('db-favorites', v); },
  isFav(artistSlug, date) {
    return this.getFavs().some(f => f.artistSlug === artistSlug && f.date === date);
  },
  toggleFav(show, artist) {
    const favs = this.getFavs();
    const idx  = favs.findIndex(f => f.artistSlug === artist.slug && f.date === show.display_date);
    if (idx >= 0) {
      favs.splice(idx, 1);
    } else {
      favs.unshift({
        artistSlug:  artist.slug,
        artistName:  artist.name,
        date:        show.display_date,
        displayDate: show.display_date,
        venueName:   show.venue?.name ?? '',
      });
    }
    this.saveFavs(favs);
    return idx < 0;
  },

  getArtistFavs()    { return _cache['db-artist-favs'] ?? []; },
  saveArtistFavs(v)  { _set('db-artist-favs', v); },
  isArtistFav(slug)  { return this.getArtistFavs().includes(slug); },
  toggleArtistFav(slug) {
    const favs = this.getArtistFavs();
    const idx  = favs.indexOf(slug);
    if (idx >= 0) favs.splice(idx, 1); else favs.push(slug);
    this.saveArtistFavs(favs);
    return idx < 0;
  },

  getHistory()  { return _cache['db-history'] ?? []; },
  pushHistory(track, artist, show) {
    const hist = this.getHistory();
    hist.unshift({
      trackTitle: track.title || 'Unknown',
      artistName: artist?.name ?? '',
      artistSlug: artist?.slug ?? '',
      showDate:   show?.display_date ?? '',
      date:       show?.display_date ?? '',
      playedAt:   new Date().toISOString(),
      duration:   track.duration ?? 0,
    });
    if (hist.length > 100) hist.length = 100;
    _set('db-history', hist);
  },

  // Personal show ratings 1–5
  getRatings()  { return _cache['db-ratings'] ?? {}; },
  getRating(artistSlug, date)  { return this.getRatings()[`${artistSlug}:${date}`] ?? null; },
  setRating(artistSlug, date, rating) {
    const all = this.getRatings();
    if (rating == null) delete all[`${artistSlug}:${date}`];
    else all[`${artistSlug}:${date}`] = rating;
    _set('db-ratings', all);
  },

  // "I was there" attendance
  getAttended() {
    const raw = _cache['db-attended'] ?? [];
    return raw.map(item => {
      if (typeof item === 'string') {
        const colonIdx  = item.indexOf(':');
        const artistSlug = item.slice(0, colonIdx);
        const date       = item.slice(colonIdx + 1);
        return { artistSlug, artistName: artistSlug, date, venueName: '', venueLocation: '', markedAt: '' };
      }
      return item;
    });
  },
  isAttended(artistSlug, date) {
    return this.getAttended().some(a => a.artistSlug === artistSlug && a.date === date);
  },
  toggleAttended(artist, show) {
    const all = this.getAttended();
    const idx = all.findIndex(a => a.artistSlug === artist.slug && a.date === show.display_date);
    if (idx >= 0) {
      all.splice(idx, 1);
    } else {
      const entry = {
        artistSlug:    artist.slug,
        artistName:    artist.name,
        date:          show.display_date,
        venueName:     show.venue?.name     ?? '',
        venueLocation: show.venue?.location ?? '',
        markedAt:      new Date().toISOString(),
      };
      // Nugs entries carry the containerID so the Library router can re-open
      // them via nugsViewRelease(artist, containerID) instead of falling
      // through to the Relisten viewShow path.
      if (show._nugsContainerId) entry.nugsContainerId = String(show._nugsContainerId);
      all.unshift(entry);
    }
    _set('db-attended', all);
    return idx < 0;
  },

  // Bookmarks (timestamp pins)
  getBookmarks()  { return _cache['db-bookmarks'] ?? []; },
  addBookmark(b) {
    const all = this.getBookmarks();
    all.unshift(b);
    if (all.length > 200) all.length = 200;
    _set('db-bookmarks', all);
  },
  removeBookmark(idx) {
    const all = this.getBookmarks();
    all.splice(idx, 1);
    _set('db-bookmarks', all);
  },
  removeAttended(idx) {
    const all = this.getAttended();
    all.splice(idx, 1);
    _set('db-attended', all);
  },
};

/* ── Settings store ──────────────────────────────── */
export const settings = {
  get()           { return _cache['db-settings'] ?? {}; },
  set(v)          { _set('db-settings', v); },
  getKey(k, def)  { return this.get()[k] ?? def; },
  setKey(k, v)    { const s = this.get(); s[k] = v; this.set(s); },
};

/* ── Nugs auth store ─────────────────────────────── */
export const nugsAuth = {
  get()   { return _cache['db-nugs-auth'] ?? null; },
  set(v)  { _set('db-nugs-auth', v); },
  clear() { _remove('db-nugs-auth'); },
  // True if we have *any* access token cached — this is what UI gates use
  // to decide whether to show signed-in or sign-in views. Token-aging is
  // handled separately: a background refresh loop keeps `expires_at` fresh,
  // and on a 4xx from id.nugs.net `nugsApi.refresh()` proactively clears
  // auth and dispatches a `nugs:logged-out` event.
  hasToken() {
    return !!this.get()?.access_token;
  },
  // Stricter check — token present AND not past its JWT `exp` claim. Used
  // by the refresh interval to decide whether to call `nugsApi.refresh()`.
  isValid() {
    const a = this.get();
    return !!(a?.access_token && a?.expires_at && Date.now() < a.expires_at);
  },
};

/* ── Tapes (cross-show playlists) ────────────────── */
export const tapes = {
  getAll()  { return _cache['db-tapes'] ?? []; },
  save(v)   { _set('db-tapes', v); },
  create(name) {
    const all = this.getAll();
    const id  = Date.now().toString();
    all.push({ id, name, tracks: [], createdAt: new Date().toISOString() });
    this.save(all);
    return id;
  },
  delete(id)  { this.save(this.getAll().filter(t => t.id !== id)); },
  rename(id, name) {
    const all = this.getAll();
    const t   = all.find(t => t.id === id);
    if (t) { t.name = name; this.save(all); }
  },
  addTrack(id, track) {
    const all  = this.getAll();
    const tape = all.find(t => t.id === id);
    if (tape && !tape.tracks.some(tr => tr.uuid === track.uuid)) {
      tape.tracks.push(track); this.save(all); return true;
    }
    return false;
  },
  removeTrack(id, uuid) {
    const all  = this.getAll();
    const tape = all.find(t => t.id === id);
    if (tape) { tape.tracks = tape.tracks.filter(tr => tr.uuid !== uuid); this.save(all); }
  },
};

/* ── Navigation history ──────────────────────────── */
export const nav = {
  history:   [],
  cursor:    -1,
  _replaying: false,

  record(fn, args = []) {
    if (nav._replaying) return;
    nav.history = nav.history.slice(0, nav.cursor + 1);
    nav.history.push({ fn, args });
    nav.cursor = nav.history.length - 1;
    nav._updateBtns();
  },

  back() {
    if (nav.cursor <= 0) return;
    nav.cursor--;
    nav._replay();
  },

  forward() {
    if (nav.cursor >= nav.history.length - 1) return;
    nav.cursor++;
    nav._replay();
  },

  _replay() {
    const entry = nav.history[nav.cursor];
    if (!entry) return;
    nav._replaying = true;
    try { entry.fn(...entry.args); } finally { nav._replaying = false; }
    nav._updateBtns();
  },

  _updateBtns() {
    $('btnBack').disabled = nav.cursor <= 0;
    $('btnFwd').disabled  = nav.cursor >= nav.history.length - 1;
  },
};
