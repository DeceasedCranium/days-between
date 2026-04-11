/* ── state.js — shared mutable state and localStorage stores ─── */
import { $ } from './utils.js';

/* ── Player / nav state ──────────────────────────── */
export const state = {
  artists: [], filteredArtists: [],
  artist: null, year: null, show: null, source: null,
  queue: [], queueIdx: -1,
  shuffleOn: false, repeatMode: 'off', // 'off' | 'one' | 'all'
  originalQueue: [],
  // Stable player state — never cleared by navigation
  playingArtist: null, playingShow: null,
};

/* ── Nugs artist list ────────────────────────────── */
export const nugsArtistStore = {
  KEY: 'db-nugs-artists',
  get()   {
    try { return JSON.parse(localStorage.getItem(nugsArtistStore.KEY) || '[]'); }
    catch { return []; }
  },
  save(v) { localStorage.setItem(nugsArtistStore.KEY, JSON.stringify(v)); },
  add(id, name) {
    const all  = nugsArtistStore.get();
    const slug = `nugs-${id}`;
    if (all.find(a => a.id === String(id))) return false;
    all.push({ id: String(id), name, slug, _nugs: true });
    nugsArtistStore.save(all);
    return true;
  },
  remove(id) { nugsArtistStore.save(nugsArtistStore.get().filter(a => a.id !== String(id))); },
};

export const nugsReleasesCache = {};
export let sidebarSource = localStorage.getItem('db-sidebar-source') ?? 'relisten';
export function setSidebarSource(v) {
  sidebarSource = v;
  localStorage.setItem('db-sidebar-source', v);
}

/* ── Favorites & History ─────────────────────────── */
export const store = {
  getFavs()    { try { return JSON.parse(localStorage.getItem('db-favorites') || '[]'); } catch { return []; } },
  saveFavs(v)  { localStorage.setItem('db-favorites', JSON.stringify(v)); },
  isFav(artistSlug, date) {
    return store.getFavs().some(f => f.artistSlug === artistSlug && f.date === date);
  },
  toggleFav(show, artist) {
    const favs = store.getFavs();
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
    store.saveFavs(favs);
    return idx < 0;
  },

  getArtistFavs()    { try { return JSON.parse(localStorage.getItem('db-artist-favs') || '[]'); } catch { return []; } },
  saveArtistFavs(v)  { localStorage.setItem('db-artist-favs', JSON.stringify(v)); },
  isArtistFav(slug)  { return store.getArtistFavs().includes(slug); },
  toggleArtistFav(slug) {
    const favs = store.getArtistFavs();
    const idx  = favs.indexOf(slug);
    if (idx >= 0) favs.splice(idx, 1); else favs.push(slug);
    store.saveArtistFavs(favs);
    return idx < 0;
  },

  getHistory()  { try { return JSON.parse(localStorage.getItem('db-history') || '[]'); } catch { return []; } },
  pushHistory(track, artist, show) {
    const hist = store.getHistory();
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
    localStorage.setItem('db-history', JSON.stringify(hist));
  },

  // Personal show ratings 1–5
  getRatings()  { try { return JSON.parse(localStorage.getItem('db-ratings') || '{}'); } catch { return {}; } },
  getRating(artistSlug, date)  { return this.getRatings()[`${artistSlug}:${date}`] ?? null; },
  setRating(artistSlug, date, rating) {
    const all = this.getRatings();
    if (rating == null) delete all[`${artistSlug}:${date}`];
    else all[`${artistSlug}:${date}`] = rating;
    localStorage.setItem('db-ratings', JSON.stringify(all));
  },

  // "I was there" attendance
  getAttended() {
    try {
      const raw = JSON.parse(localStorage.getItem('db-attended') || '[]');
      return raw.map(item => {
        if (typeof item === 'string') {
          const colonIdx  = item.indexOf(':');
          const artistSlug = item.slice(0, colonIdx);
          const date       = item.slice(colonIdx + 1);
          return { artistSlug, artistName: artistSlug, date, venueName: '', venueLocation: '', markedAt: '' };
        }
        return item;
      });
    } catch (err) { console.error('[state] getAttended', err); return []; }
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
      all.unshift({
        artistSlug:    artist.slug,
        artistName:    artist.name,
        date:          show.display_date,
        venueName:     show.venue?.name     ?? '',
        venueLocation: show.venue?.location ?? '',
        markedAt:      new Date().toISOString(),
      });
    }
    localStorage.setItem('db-attended', JSON.stringify(all));
    return idx < 0;
  },

  // Bookmarks (timestamp pins)
  getBookmarks()  { try { return JSON.parse(localStorage.getItem('db-bookmarks') || '[]'); } catch { return []; } },
  addBookmark(b) {
    const all = this.getBookmarks();
    all.unshift(b);
    if (all.length > 200) all.length = 200;
    localStorage.setItem('db-bookmarks', JSON.stringify(all));
  },
  removeBookmark(idx) {
    const all = this.getBookmarks();
    all.splice(idx, 1);
    localStorage.setItem('db-bookmarks', JSON.stringify(all));
  },
  removeAttended(idx) {
    const all = this.getAttended();
    all.splice(idx, 1);
    localStorage.setItem('db-attended', JSON.stringify(all));
  },
};

/* ── Settings store ──────────────────────────────── */
export const settings = {
  get()           { try { return JSON.parse(localStorage.getItem('db-settings') || '{}'); } catch { return {}; } },
  set(v)          { localStorage.setItem('db-settings', JSON.stringify(v)); },
  getKey(k, def)  { return settings.get()[k] ?? def; },
  setKey(k, v)    { const s = settings.get(); s[k] = v; settings.set(s); },
};

/* ── Nugs auth store ─────────────────────────────── */
export const nugsAuth = {
  KEY: 'db-nugs-auth',
  get()   { try { return JSON.parse(localStorage.getItem(nugsAuth.KEY) || 'null'); } catch { return null; } },
  set(v)  { localStorage.setItem(nugsAuth.KEY, JSON.stringify(v)); },
  clear() { localStorage.removeItem(nugsAuth.KEY); },
  isValid() {
    const a = nugsAuth.get();
    return !!(a?.access_token && a?.expires_at && Date.now() < a.expires_at);
  },
};

/* ── Tapes (cross-show playlists) ────────────────── */
export const tapes = {
  getAll()  { try { return JSON.parse(localStorage.getItem('db-tapes') || '[]'); } catch { return []; } },
  save(v)   { localStorage.setItem('db-tapes', JSON.stringify(v)); },
  create(name) {
    const all = tapes.getAll();
    const id  = Date.now().toString();
    all.push({ id, name, tracks: [], createdAt: new Date().toISOString() });
    tapes.save(all);
    return id;
  },
  delete(id)  { tapes.save(tapes.getAll().filter(t => t.id !== id)); },
  rename(id, name) {
    const all = tapes.getAll();
    const t   = all.find(t => t.id === id);
    if (t) { t.name = name; tapes.save(all); }
  },
  addTrack(id, track) {
    const all  = tapes.getAll();
    const tape = all.find(t => t.id === id);
    if (tape && !tape.tracks.some(tr => tr.uuid === track.uuid)) {
      tape.tracks.push(track); tapes.save(all); return true;
    }
    return false;
  },
  removeTrack(id, uuid) {
    const all  = tapes.getAll();
    const tape = all.find(t => t.id === id);
    if (tape) { tape.tracks = tape.tracks.filter(tr => tr.uuid !== uuid); tapes.save(all); }
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
