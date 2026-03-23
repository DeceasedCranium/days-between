/* ── Constants ─────────────────────────────────── */
const API2 = 'https://api.relisten.net/api/v2';
const API3 = 'https://api.relisten.net/api/v3';
let LFM_KEY = '';
window.ipc?.getLfmKey?.().then(k => { if (k) LFM_KEY = k; }).catch(() => {});

/* ── State ─────────────────────────────────────── */
let nowPlayingOpen = false;
const state = {
  artists: [], filteredArtists: [],
  artist: null, year: null, show: null, source: null,
  queue: [], queueIdx: -1,
  shuffleOn: false, repeatMode: 'off', // off | one | all
  originalQueue: [],
};

/* ── DOM helpers ───────────────────────────────── */
const $ = (id) => document.getElementById(id);
const fmt = (secs) => {
  if (!secs || isNaN(secs)) return '0:00';
  return `${Math.floor(secs/60)}:${String(Math.floor(secs%60)).padStart(2,'0')}`;
};
const stars = (r) => r ? `★ ${r.toFixed(1)}` : '';
const esc = (s) => String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function castContentType(url) {
  const u = (url ?? '').split('?')[0].toLowerCase();
  if (u.endsWith('.m3u8')) return 'application/x-mpegURL';
  if (u.endsWith('.flac')) return 'audio/flac';
  if (u.endsWith('.m4a'))  return 'audio/mp4';
  if (u.endsWith('.mp4') || u.endsWith('.m4v')) return 'video/mp4';
  return 'audio/mpeg';
}

// Deterministic hue from a string — used for art placeholders
function artistColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return `hsl(${Math.abs(h) % 360}, 45%, 28%)`;
}

// Wikipedia artist data — no API key, no auth, free
const _wikiCache = new Map();
async function wikiArtistData(name) {
  if (!name) return null;
  if (_wikiCache.has(name)) return _wikiCache.get(name);
  try {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}`;
    const data = await fetch(url, { headers: { 'Accept': 'application/json' } }).then(r => r.json());
    const result = {
      image:       data?.thumbnail?.source ?? data?.originalimage?.source ?? null,
      bio:         data?.extract ?? null,
      description: data?.description ?? null,
      wikiUrl:     data?.content_urls?.desktop?.page ?? null,
    };
    _wikiCache.set(name, result);
    return result;
  } catch {
    _wikiCache.set(name, null);
    return null;
  }
}
async function lastfmArtistImage(name) {
  return (await wikiArtistData(name))?.image ?? null;
}

async function injectArtistBio(artistName) {
  const bioEl = document.getElementById('artistBioCard');
  if (!bioEl) return;
  const [wiki, lfmData] = await Promise.all([
    wikiArtistData(artistName),
    fetch(`https://ws.audioscrobbler.com/2.0/?method=artist.getInfo&artist=${encodeURIComponent(artistName)}&api_key=f468569623823ed33e83c24c3dcc8b79&format=json`)
      .then(r => r.json()).catch(() => null),
  ]);
  const bio     = wiki?.bio ?? null;
  const desc    = wiki?.description ?? null;
  const wikiUrl = wiki?.wikiUrl ?? null;
  const lfmUrl  = lfmData?.artist?.url ?? null;
  if (!bio && !wikiUrl && !lfmUrl) { bioEl.remove(); return; }
  bioEl.classList.remove('loading');
  bioEl.innerHTML = `
    ${desc ? `<div class="artist-bio-desc">${esc(desc)}</div>` : ''}
    ${bio  ? `<p class="artist-bio-text">${esc(bio)}</p>` : ''}
    <div class="artist-bio-links">
      ${wikiUrl ? `<button class="bio-link-btn" data-url="${esc(wikiUrl)}">Wikipedia</button>` : ''}
      ${lfmUrl  ? `<button class="bio-link-btn" data-url="${esc(lfmUrl)}">Last.fm</button>`   : ''}
    </div>`;
  bioEl.querySelectorAll('.bio-link-btn').forEach(btn =>
    btn.addEventListener('click', () => window.ipc?.openUrl(btn.dataset.url)));
}

function setPlayerArt(artist, artUrl) {
  const el = $('playerArt');
  if (!el) return;
  const url = artUrl ?? artist?.image_url ?? null;
  if (url) {
    const fallbackBg = artistColor(artist?.name ?? '');
    const fallbackInit = esc((artist?.name ?? '?')[0].toUpperCase());
    el.innerHTML = `<img alt="" onerror="this.parentElement.innerHTML='<span class=art-init>${fallbackInit}</span>';this.parentElement.style.background='${fallbackBg}'">`;
    el.querySelector('img').src = url;
    el.style.background = '';
  } else {
    const initial = (artist?.name ?? '?')[0].toUpperCase();
    el.style.background = artistColor(artist?.name ?? '');
    el.innerHTML = `<span class="art-init">${esc(initial)}</span>`;
  }
  if (nowPlayingOpen) syncNowPlayingContent();
}

// Cache search elements — they get re-parented into breadcrumb repeatedly
const searchToggleEl = $('searchToggle');
const searchInlineEl = $('searchInline');

/* ── API ───────────────────────────────────────── */
const api = {
  async get(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`API error ${r.status}`);
    return r.json();
  },
  artists:   ()           => api.get(`${API2}/artists`),
  years:     (slug)       => api.get(`${API2}/artists/${slug}/years`),
  shows:     (slug, year) => api.get(`${API2}/artists/${slug}/years/${year}`),
  show:      (slug, date) => api.get(`${API2}/artists/${slug}/shows/${date}`),
  random:    (slug)       => api.get(`${API2}/artists/${slug}/shows/random`),
  top:       (slug)       => api.get(`${API2}/artists/${slug}/shows/top?limit=30`),
  trending:  ()           => api.get(`${API3}/trending/shows?limit=30`),
  recent:    ()           => api.get(`${API2}/shows/recently-added?limit=30`),
  onDate:    (m, d)       => api.get(`${API2}/shows/on-date?month=${m}&day=${d}`),
  search:    (q)          => api.get(`${API2}/search?q=${encodeURIComponent(q)}`),
  songs:     (slug)       => api.get(`${API2}/artists/${slug}/songs`),
};

/* ── Nugs.net API ──────────────────────────────── */
const NUGS_ID_URL    = 'https://id.nugs.net';
const NUGS_SUBS_URL  = 'https://subscriptions.nugs.net';
const NUGS_STREAM    = 'https://streamapi.nugs.net';
const NUGS_UA        = 'NugsNet/3.26.724 (Android; 7.1.2; Asus; ASUS_Z01QD; Scale/2.0; en)';
const NUGS_UA_PLAYER = 'nugsnetAndroid';
const NUGS_CLIENT_ID = 'Eg7HuH873H65r5rt325UytR5429';

// Parse nugs date strings like "03/19/2026 18:31:47" (MM/DD/YYYY HH:MM:SS) → Unix seconds
function parseNugsDate(s) {
  if (!s) return 0;
  const [datePart, timePart] = s.split(' ');
  const [mm, dd, yyyy] = datePart.split('/');
  return new Date(`${yyyy}-${mm}-${dd}T${timePart}Z`).getTime() / 1000;
}

const nugsApi = {
  async login(email, password) {
    const body = new URLSearchParams({
      client_id:  NUGS_CLIENT_ID,
      grant_type: 'password',
      scope:      'openid profile email nugsnet:api nugsnet:legacyapi offline_access',
      username:   email,
      password:   password,
    });
    const r = await fetch(`${NUGS_ID_URL}/connect/token`, {
      method: 'POST',
      headers: { 'User-Agent': NUGS_UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!r.ok) throw new Error('nugs:login_failed');
    const tokens = await r.json();

    // Decode JWT payload for legacy fields (base64url, no verify needed)
    let jwtPayload = {};
    try {
      const seg = tokens.access_token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
      jwtPayload = JSON.parse(atob(seg.padEnd(seg.length + (4 - seg.length % 4) % 4, '=')));
    } catch { /* ignore */ }

    const [userInfo, subsArr] = await Promise.all([
      fetch(`${NUGS_ID_URL}/connect/userinfo`, {
        headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'User-Agent': NUGS_UA },
      }).then(r2 => r2.json()),
      fetch(`${NUGS_SUBS_URL}/api/v1/me/subscriptions`, {
        headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'User-Agent': NUGS_UA },
      }).then(r2 => r2.json()),
    ]);

    const sub    = Array.isArray(subsArr) ? subsArr[0] : (subsArr?.subscriptions?.[0] ?? subsArr);
    const planId = sub?.plan?.planId ?? sub?.promo?.plan?.planId ?? '';
    if (!sub?.isContentAccessible) throw new Error('nugs:no_subscription');

    nugsAuth.set({
      access_token:    tokens.access_token,
      refresh_token:   tokens.refresh_token,
      expires_at:      Date.now() + 600 * 60 * 1000,
      legacy_token:    jwtPayload.legacyToken  ?? '',
      legacy_uguid:    jwtPayload.legacyUguid  ?? '',
      user_id:         userInfo.sub            ?? '',
      plan_id:         String(planId),
      subscription_id: String(sub?.legacySubscriptionId ?? ''),
      start_stamp:     sub?.startedAt ? Math.floor(parseNugsDate(sub.startedAt)) : 0,
      end_stamp:       sub?.endsAt    ? Math.floor(parseNugsDate(sub.endsAt))    : 0,
    });
  },

  async catalog(artistId, offset = 0) {
    const auth = nugsAuth.get();
    const url  = `${NUGS_STREAM}/api.aspx?method=catalog.containersAll`
      + `&artistList=${artistId}&limit=100&startOffset=${offset}&availType=1&vdisp=1`;
    const r = await fetch(url, { headers: { 'User-Agent': NUGS_UA,
      ...(auth?.access_token ? { 'Authorization': `Bearer ${auth.access_token}` } : {}) } });
    if (!r.ok) throw new Error(`nugs catalog ${r.status}`);
    const text = await r.text();
    if (text.trimStart().startsWith('<')) throw new Error('nugs:unauthenticated');
    return JSON.parse(text);
  },

  async release(containerId) {
    const auth = nugsAuth.get();
    const url  = `${NUGS_STREAM}/api.aspx?method=catalog.container&containerID=${containerId}&vdisp=1`;
    const r = await fetch(url, { headers: { 'User-Agent': NUGS_UA,
      ...(auth?.access_token ? { 'Authorization': `Bearer ${auth.access_token}` } : {}) } });
    if (!r.ok) throw new Error(`nugs release ${r.status}`);
    const text = await r.text();
    if (text.trimStart().startsWith('<')) throw new Error('nugs:unauthenticated');
    return JSON.parse(text);
  },

  async streamUrl(trackId) {
    const auth = nugsAuth.get();
    if (!auth) throw new Error('nugs:unauthenticated');
    const base = {
      app:                     '1',
      subscriptionID:          auth.subscription_id,
      subCostplanIDAccessList: auth.plan_id,
      nn_userID:               auth.user_id,
      startDateStamp:          String(auth.start_stamp),
      endDateStamp:            String(auth.end_stamp),
    };
    let lastData = null;
    for (const platformID of [1, 10, 4, 7]) {
      const params = new URLSearchParams({ platformID, trackID: trackId, ...base });
      const r = await fetch(`${NUGS_STREAM}/bigriver/subPlayer.aspx?${params}`,
        { headers: { 'User-Agent': NUGS_UA_PLAYER } });
      if (!r.ok) throw new Error(`nugs stream ${r.status}`);
      const data = await r.json();
      const url = data.streamLink ?? data.StreamLink ?? null;
      if (url) return url;
      lastData = data;
    }
    // Log the last response to help diagnose why streams are unavailable
    console.warn('[nugs] streamUrl null for trackId', trackId, 'last response:', lastData);
    const policy = lastData?.policyMessage ?? lastData?.PolicyMessage ?? lastData?.message ?? lastData?.Message;
    if (policy) throw new Error(`nugs:policy:${policy}`);
    return null;
  },

  async vidStreamUrl(skuId, containerId) {
    const auth = nugsAuth.get();
    if (!auth) throw new Error('nugs:unauthenticated');
    // Video uses subPlayer.aspx with skuId + containerID + chap=1 (format=0 in Go source)
    const params = new URLSearchParams({
      skuId, containerID: containerId, chap: '1', app: '1',
      subscriptionID:          auth.subscription_id,
      subCostplanIDAccessList: auth.plan_id,
      nn_userID:               auth.user_id,
      startDateStamp:          String(auth.start_stamp),
      endDateStamp:            String(auth.end_stamp),
    });
    const r = await fetch(`${NUGS_STREAM}/bigriver/subPlayer.aspx?${params}`,
      { headers: { 'User-Agent': NUGS_UA_PLAYER } });
    if (!r.ok) throw new Error(`nugs vid ${r.status}`);
    const data = await r.json();
    return data.streamLink ?? data.StreamLink ?? null;
  },

  async allArtists() {
    // catalog.artists returns all nugs artists paginated — searchText does NOT filter
    // Load all pages and cache
    if (nugsApi._artistCache) return nugsApi._artistCache;
    const auth = nugsAuth.get();
    const headers = { 'User-Agent': NUGS_UA,
      ...(auth?.access_token ? { 'Authorization': `Bearer ${auth.access_token}` } : {}) };
    let all = [], offset = 1, batch;
    do {
      const r = await fetch(
        `${NUGS_STREAM}/api.aspx?method=catalog.artists&limit=500&startOffset=${offset}`,
        { headers });
      if (!r.ok) break;
      const data = await r.json();
      batch = data?.Response?.artists ?? [];
      all   = all.concat(batch);
      offset += 500;
    } while (batch.length === 500);
    nugsApi._artistCache = all;
    return all;
  },

  searchArtists(query) {
    const q = query.toLowerCase().trim();
    return (nugsApi._artistCache ?? [])
      .filter(a => a.artistName?.toLowerCase().includes(q))
      .slice(0, 20)
      .map(a => ({ id: String(a.artistID), name: a.artistName, numShows: a.numShows ?? 0 }));
  },

  async refresh() {
    const auth = nugsAuth.get();
    if (!auth?.refresh_token) return;
    const body = new URLSearchParams({
      client_id:     NUGS_CLIENT_ID,
      grant_type:    'refresh_token',
      refresh_token: auth.refresh_token,
    });
    const r = await fetch(`${NUGS_ID_URL}/connect/token`, {
      method: 'POST',
      headers: { 'User-Agent': NUGS_UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (r.ok) {
      const tokens = await r.json();
      nugsAuth.set({ ...auth,
        access_token:  tokens.access_token,
        refresh_token: tokens.refresh_token ?? auth.refresh_token,
        expires_at:    Date.now() + 600 * 60 * 1000,
      });
    } else {
      // Refresh failed — leave existing token rather than logging out
    }
  },
};

// User-managed nugs artist list — stored in localStorage
const nugsArtistStore = {
  KEY: 'db-nugs-artists',
  get()     { try { return JSON.parse(localStorage.getItem(nugsArtistStore.KEY) || '[]'); } catch { return []; } },
  save(v)   { localStorage.setItem(nugsArtistStore.KEY, JSON.stringify(v)); },
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
const nugsReleasesCache = {};
let sidebarSource = localStorage.getItem('db-sidebar-source') ?? 'relisten';

/* ── Favorites & History ───────────────────────── */
const store = {
  getFavs()   { try { return JSON.parse(localStorage.getItem('db-favorites') || '[]'); } catch { return []; } },
  saveFavs(v) { localStorage.setItem('db-favorites', JSON.stringify(v)); },
  isFav(artistSlug, date) { return store.getFavs().some(f => f.artistSlug === artistSlug && f.date === date); },
  toggleFav(show, artist) {
    const favs = store.getFavs();
    const idx  = favs.findIndex(f => f.artistSlug === artist.slug && f.date === show.display_date);
    if (idx >= 0) { favs.splice(idx, 1); }
    else {
      favs.unshift({
        artistSlug: artist.slug, artistName: artist.name,
        date: show.display_date, displayDate: show.display_date,
        venueName: show.venue?.name ?? '',
      });
    }
    store.saveFavs(favs);
    return idx < 0;
  },
  getArtistFavs()   { try { return JSON.parse(localStorage.getItem('db-artist-favs') || '[]'); } catch { return []; } },
  saveArtistFavs(v) { localStorage.setItem('db-artist-favs', JSON.stringify(v)); },
  isArtistFav(slug) { return store.getArtistFavs().includes(slug); },
  toggleArtistFav(slug) {
    const favs = store.getArtistFavs();
    const idx  = favs.indexOf(slug);
    if (idx >= 0) favs.splice(idx, 1); else favs.push(slug);
    store.saveArtistFavs(favs);
    return idx < 0;
  },
  getHistory()   { try { return JSON.parse(localStorage.getItem('db-history') || '[]'); } catch { return []; } },
  pushHistory(track, artist, show) {
    const hist = store.getHistory();
    hist.unshift({
      trackTitle: track.title || 'Unknown', artistName: artist?.name ?? '',
      artistSlug: artist?.slug ?? '', showDate: show?.display_date ?? '',
      date: show?.display_date ?? '', playedAt: new Date().toISOString(),
      duration: track.duration ?? 0,
    });
    if (hist.length > 100) hist.length = 100;
    localStorage.setItem('db-history', JSON.stringify(hist));
  },
  // Personal show ratings 1-5
  getRatings()  { try { return JSON.parse(localStorage.getItem('db-ratings') || '{}'); } catch { return {}; } },
  getRating(artistSlug, date) { return this.getRatings()[`${artistSlug}:${date}`] ?? null; },
  setRating(artistSlug, date, rating) {
    const all = this.getRatings();
    if (rating == null) delete all[`${artistSlug}:${date}`];
    else all[`${artistSlug}:${date}`] = rating;
    localStorage.setItem('db-ratings', JSON.stringify(all));
  },
  // "I was there" attendance — stores rich objects
  getAttended() {
    try {
      const raw = JSON.parse(localStorage.getItem('db-attended') || '[]');
      return raw.map(item => {
        if (typeof item === 'string') {
          const colonIdx = item.indexOf(':');
          const artistSlug = item.slice(0, colonIdx);
          const date = item.slice(colonIdx + 1);
          return { artistSlug, artistName: artistSlug, date, venueName: '', venueLocation: '', markedAt: '' };
        }
        return item;
      });
    } catch { return []; }
  },
  isAttended(artistSlug, date) { return this.getAttended().some(a => a.artistSlug === artistSlug && a.date === date); },
  toggleAttended(artist, show) {
    const all = this.getAttended();
    const idx = all.findIndex(a => a.artistSlug === artist.slug && a.date === show.display_date);
    if (idx >= 0) { all.splice(idx, 1); }
    else {
      all.unshift({
        artistSlug: artist.slug, artistName: artist.name,
        date: show.display_date, venueName: show.venue?.name ?? '',
        venueLocation: show.venue?.location ?? '', markedAt: new Date().toISOString(),
      });
    }
    localStorage.setItem('db-attended', JSON.stringify(all));
    return idx < 0;
  },
  // Bookmarks (timestamp pins)
  getBookmarks()  { try { return JSON.parse(localStorage.getItem('db-bookmarks') || '[]'); } catch { return []; } },
  addBookmark(b)  {
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
};

/* ── Settings store ────────────────────────────── */
const settings = {
  get()          { try { return JSON.parse(localStorage.getItem('db-settings') || '{}'); } catch { return {}; } },
  set(v)         { localStorage.setItem('db-settings', JSON.stringify(v)); },
  getKey(k, def) { return settings.get()[k] ?? def; },
  setKey(k, v)   { const s = settings.get(); s[k] = v; settings.set(s); },
};

/* ── Nugs auth store ───────────────────────────── */
const nugsAuth = {
  KEY: 'db-nugs-auth',
  get()   { try { return JSON.parse(localStorage.getItem(nugsAuth.KEY) || 'null'); } catch { return null; } },
  set(v)  { localStorage.setItem(nugsAuth.KEY, JSON.stringify(v)); },
  clear() { localStorage.removeItem(nugsAuth.KEY); },
  isValid() {
    const a = nugsAuth.get();
    return !!(a?.access_token && a?.expires_at && Date.now() < a.expires_at);
  },
};

/* ── Tapes (playlists) store ───────────────────── */
const tapes = {
  getAll()   { try { return JSON.parse(localStorage.getItem('db-tapes') || '[]'); } catch { return []; } },
  save(v)    { localStorage.setItem('db-tapes', JSON.stringify(v)); },
  create(name) {
    const all = tapes.getAll();
    const id  = Date.now().toString();
    all.push({ id, name, tracks: [], createdAt: new Date().toISOString() });
    tapes.save(all); return id;
  },
  delete(id) { tapes.save(tapes.getAll().filter(t => t.id !== id)); },
  rename(id, name) {
    const all = tapes.getAll(); const t = all.find(t => t.id === id);
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

/* ── Resume state ──────────────────────────────── */
function saveResumeState() {
  const track = state.queue[state.queueIdx];
  const url   = track?.mp3_url ?? track?.stream_url;
  if (!url) return;
  localStorage.setItem('db-resume', JSON.stringify({
    mp3_url:    track.mp3_url    ?? null,
    stream_url: track.stream_url ?? null,
    _nugs:      track._nugs      ?? false,
    title:      track.title || '',
    artistName: state.artist?.name ?? '',
    artistSlug: state.artist?.slug ?? '',
    showDate:   state.show?.display_date ?? '',
    currentTime: audio.currentTime,
    volume:     audio.volume,
  }));
}
// Persist position every 8 seconds while playing
setInterval(() => { if (playing && audio.currentTime > 0) saveResumeState(); }, 8000);

/* ── Navigation history ────────────────────────── */
const nav = {
  history: [],
  cursor: -1,
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

/* ── Toast ─────────────────────────────────────── */
let toastTimer = null;
function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('visible'), 2200);
}

/* ── Audio / Player ────────────────────────────── */
const audio        = $('audioEl');
const preloadAudio = $('preloadEl');
let playing = false;
const cast = { active: false, paused: false, deviceName: null };


// ── Artist Radio ──────────────────────────────────────────────────────────
let radioMode = false;
const _lfmSimilarCache = new Map();

async function lastfmSimilarArtists(name) {
  if (_lfmSimilarCache.has(name)) return _lfmSimilarCache.get(name);
  try {
    const url = `https://ws.audioscrobbler.com/2.0/?method=artist.getSimilar&artist=${encodeURIComponent(name)}&api_key=${LFM_KEY}&limit=30&format=json`;
    const artists = (await fetch(url).then(r => r.json()))?.similarartists?.artist?.map(a => a.name) ?? [];
    _lfmSimilarCache.set(name, artists);
    return artists;
  } catch { _lfmSimilarCache.set(name, []); return []; }
}

async function tryRadio() {
  if (!radioMode || !state.artist?.name) return;
  showToast('Artist Radio: finding related artist…');
  try {
    const similar  = await lastfmSimilarArtists(state.artist.name);
    const lowerSim = new Set(similar.map(n => n.toLowerCase()));
    const matches  = state.artists.filter(a => lowerSim.has(a.name.toLowerCase()));
    if (!matches.length) { showToast('Radio: no similar artists found in library'); return; }
    const pick = matches[Math.floor(Math.random() * Math.min(matches.length, 8))];
    showToast(`Artist Radio → ${pick.name}`);
    state.artist = pick;
    document.querySelectorAll('.artist-item').forEach(i => i.classList.remove('active'));
    document.querySelector(`[data-slug="${CSS.escape(pick.slug)}"]`)?.classList.add('active');
    const show     = await api.random(pick.slug);
    const showData = await api.show(pick.slug, show.display_date);
    const src = (showData.sources ?? []).sort((a, b) =>
      (b.is_soundboard - a.is_soundboard) || ((b.avg_rating ?? 0) - (a.avg_rating ?? 0)))[0];
    if (src?.tracks?.length) { queueAndPlay(src.tracks, pick, showData, 0); viewShow(pick, show.display_date); }
  } catch { showToast('Radio: could not load show'); }
}

// ── Last.fm scrobbling ────────────────────────────────────────────────────
const lfm = {
  session: null,   // { name, key }
  scrobbled: false,
  startTime: 0,
  timer: null,

  load() {
    try { this.session = JSON.parse(localStorage.getItem('lfm_session') ?? 'null'); } catch {}
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
    const t = track.title ?? '';
    const a = artist?.name ?? '';
    const al = show?.display_date ?? '';
    const dur = track.duration ?? 0;
    window.ipc?.lfmNowPlaying({ track: t, artist: a, album: al, duration: dur, sk: this.sk });
    const delay = Math.min(dur > 0 ? dur * 500 : 120000, 240000); // 50% or 4 min cap
    this.timer = setTimeout(() => {
      if (!this.scrobbled) {
        this.scrobbled = true;
        window.ipc?.lfmScrobble({ track: t, artist: a, album: al, timestamp: this.startTime, duration: dur, sk: this.sk });
        showToast(`Scrobbled: ${t}`);
      }
    }, delay);
  },
};
lfm.load();
let hlsInstance = null;
function destroyHls() { if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; } }

function flatTracks(src) {
  return (src.sets ?? []).flatMap(s => (s.tracks ?? []).filter(t => t.mp3_url));
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function syncEq() {
  $('eqBars').classList.toggle('playing', playing);
}

function preloadNext() {
  const nextIdx = state.queueIdx + 1;
  if (nextIdx < state.queue.length) {
    const url = state.queue[nextIdx]?.mp3_url;
    if (url && preloadAudio.src !== url) preloadAudio.src = url;
  } else {
    preloadAudio.src = '';
  }
}

const player = {
  load(track, artist, show) {
    if (cast.active) {
      state.artist = artist; state.show = show;
      $('playerTitle').textContent = track.title || 'Unknown Track';
      $('playerSub').textContent = `${artist?.name ?? ''} · ${show?.display_date ?? ''}`;
      window.ipc?.send('player-update', { title: `${track.title} — ${artist?.name}` });
      setPlayerArt(artist);
      const url = track.stream_url ?? track.mp3_url;
      if (url) window.ipc?.castLoad(url, castContentType(url), track.title ?? '', '').catch(() => {});
      return;
    }
    const url = track?.stream_url ?? track?.mp3_url;
    if (!url) return;
    destroyHls();
    if (url.includes('.m3u8') && typeof Hls !== 'undefined' && Hls.isSupported()) {
      hlsInstance = new Hls({ enableWorker: false });
      hlsInstance.loadSource(url);
      hlsInstance.attachMedia(audio);
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => audio.play().catch(() => {}));
      hlsInstance.on(Hls.Events.ERROR, (_, d) => {
        if (d.fatal) { destroyHls(); showToast('Stream error — try again'); }
      });
    } else {
      audio.src = url;
      audio.play().catch(() => {});
    }
    playing = true;
    syncEq();
    $('btnPlay').innerHTML = '&#9646;&#9646;';
    $('playerTitle').textContent = track.title || 'Unknown Track';
    $('playerTitle').classList.add('clickable');
    $('playerSub').textContent = `${artist?.name ?? ''} · ${show?.display_date ?? ''}`;
    window.ipc?.send('player-update', { title: `${track.title} — ${artist?.name}` });
    store.pushHistory(track, artist, show);
    lfm.onTrackStart(track, artist, show);
    window.ipc?.mprisUpdate({
      status: 'Playing',
      metadata: {
        'mpris:trackid':   `/tracks/${track.id ?? track.slug ?? 0}`,
        'mpris:length':    (track.duration ?? 0) * 1000000,
        'xesam:title':     track.title ?? 'Unknown',
        'xesam:artist':    [artist?.name ?? ''],
        'xesam:album':     show?.display_date ?? '',
      },
    });
    setPlayerArt(artist);
    if (nowPlayingOpen) syncNowPlayingContent();
    if (settings.getKey('notifications', false)) {
      window.ipc?.send('notify-track', {
        title: track.title || 'Unknown Track',
        body:  `${artist?.name ?? ''} · ${show?.display_date ?? ''}`,
      });
    }
    document.querySelectorAll('.track-row').forEach(r => {
      r.classList.remove('playing');
      if (r.querySelector('.track-num')) r.querySelector('.track-num').textContent = r.dataset.trackPos || '?';
    });
    const el = document.querySelector(`[data-track-uuid="${track.uuid}"]`);
    if (el) { el.classList.add('playing'); el.querySelector('.track-num').textContent = '▶'; }
    preloadNext();
    renderQueuePanel();
    // Now-playing indicator in sidebar
    document.querySelectorAll('.artist-item').forEach(el => el.classList.remove('now-playing'));
    if (artist?.slug) {
      const npSel = artist?._nugs
        ? `.artist-item[data-nugs-slug="${CSS.escape(artist.slug)}"]`
        : `.artist-item[data-slug="${CSS.escape(artist.slug)}"]`;
      document.querySelector(npSel)?.classList.add('now-playing');
    }
    // Persist resume state
    saveResumeState();
  },

  toggle() {
    if (cast.active) {
      cast.paused ? window.ipc?.castPlay() : window.ipc?.castPause();
      cast.paused = !cast.paused; updateCastUI(); return;
    }
    if (!audio.src) return;
    if (playing) {
      audio.pause(); playing = false; $('btnPlay').innerHTML = '&#9654;';
    } else {
      audio.play().catch(() => {});
      playing = true; $('btnPlay').innerHTML = '&#9646;&#9646;';
    }
    syncEq();
  },

  next() {
    if (state.queueIdx < state.queue.length - 1) {
      state.queueIdx++;
      if (cast.active) castAdvanceTrack();
      else player._playQueued(state.queueIdx);
    } else if (state.repeatMode === 'all' && state.queue.length) {
      state.queueIdx = 0;
      if (cast.active) castAdvanceTrack();
      else player._playQueued(0);
    } else {
      tryRadio();
    }
  },

  prev() {
    if (cast.active) { window.ipc?.castSeek(0); return; }
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    if (state.queueIdx > 0) {
      state.queueIdx--;
      player._playQueued(state.queueIdx);
    }
  },

  _playQueued(idx) {
    const track = state.queue[idx];
    if (!track) return;
    if (track._nugs && !track.stream_url) {
      nugsResolveAndPlay(track, state.artist, state.show);
    } else {
      player.load(track, state.artist, state.show);
    }
  },

  _setQueue(tracks, startIdx) {
    state.originalQueue = tracks;
    if (state.shuffleOn) {
      const first = tracks[startIdx];
      const rest  = shuffle(tracks.filter((_, i) => i !== startIdx));
      state.queue = [first, ...rest];
      state.queueIdx = 0;
    } else {
      state.queue    = tracks;
      state.queueIdx = startIdx;
    }
    preloadNext();
  },

  playSource(src) {
    const t = flatTracks(src);
    player._setQueue(t, 0);
    if (t.length) player.load(state.queue[0], state.artist, state.show);
  },

  playTrack(track, src) {
    const t    = flatTracks(src);
    const orig = Math.max(0, t.findIndex(x => x.uuid === track.uuid));
    player._setQueue(t, orig);
    player.load(state.queue[state.queueIdx], state.artist, state.show);
  },

  playTape(tape) {
    state.originalQueue = [...tape.tracks];
    state.queue    = state.shuffleOn ? shuffle([...tape.tracks]) : [...tape.tracks];
    state.queueIdx = 0;
    preloadNext();
    if (state.queue.length) player.load(state.queue[0], state.artist, state.show);
  },
};

/* ── Nugs playback helpers ─────────────────────── */
function handleNugsAuthError(e) {
  if (e.message === 'nugs:no_subscription') {
    showToast('Nugs subscription not active — check nugs.net');
  } else if (e.message === 'nugs:unauthenticated' || e.message?.includes('401') || e.message?.includes('403')) {
    nugsAuth.clear();
    showToast('Nugs session expired — sign in again in Settings');
    renderArtists(state.filteredArtists);
  } else if (e.message?.startsWith('nugs:policy:')) {
    showToast(e.message.replace('nugs:policy:', ''));
  } else {
    showToast(`Nugs error: ${e.message}`);
  }
}

async function nugsResolveAndPlay(track, artist, show) {
  if (!track.stream_url) {
    // Show track in player bar immediately so UI feels responsive
    $('playerTitle').textContent = track.title || '…';
    $('playerSub').textContent   = `${artist?.name ?? ''} · ${show?.display_date ?? ''}`;
    setPlayerArt(artist, show?._artData ?? show?._art ?? null);
    showToast('Loading stream…');
    try {
      if (track._nugs_video) {
        track.stream_url = await nugsApi.vidStreamUrl(track._nugs_skuId, track._nugs_containerId);
        if (!track.stream_url && track._nugs_trackId) {
          track.stream_url = await nugsApi.streamUrl(track._nugs_trackId);
        }
      } else {
        if (!track._nugs_trackId || track._nugs_trackId === '0') {
          throw new Error('Track unavailable — no track ID');
        }
        track.stream_url = await nugsApi.streamUrl(track._nugs_trackId);
      }
      if (!track.stream_url) throw new Error('Track unavailable — no stream returned');
    } catch (e) {
      handleNugsAuthError(e); return;
    }
  }
  if (track._nugs_video) {
    nugsViewVideo(artist, show, track);
  } else {
    player.load(track, artist, show);
    preloadNextNugsStream();
  }
}

async function preloadNextNugsStream() {
  const nextIdx = state.queueIdx + 1;
  if (nextIdx >= state.queue.length) return;
  const next = state.queue[nextIdx];
  if (!next?._nugs || next.stream_url || next._nugs_video) return;
  try {
    const url = await nugsApi.streamUrl(next._nugs_trackId);
    if (url) next.stream_url = url;
  } catch { /* silent — will retry on actual play */ }
}

audio.addEventListener('error', () => {
  const code = audio.error?.code;
  if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
    showToast('Audio format not supported by this player');
  } else if (code === MediaError.MEDIA_ERR_NETWORK) {
    showToast('Stream network error — check connection');
  } else if (code) {
    showToast(`Playback error (code ${code})`);
  }
});

audio.addEventListener('ended', () => {
  if (state.repeatMode === 'one') {
    audio.currentTime = 0; audio.play().catch(() => {});
  } else {
    playing = false; syncEq();
    player.next();
  }
});
audio.addEventListener('timeupdate', () => {
  if (!audio.duration) return;
  const pct = `${(audio.currentTime / audio.duration) * 100}%`;
  $('progressFill').style.width = pct;
  $('timeCur').textContent = fmt(audio.currentTime);
  $('timeDur').textContent = fmt(audio.duration);
  if (nowPlayingOpen) {
    $('npoFill').style.width  = pct;
    $('npoTimeCur').textContent = fmt(audio.currentTime);
    $('npoTimeDur').textContent = fmt(audio.duration);
  }
});

/* ── Now Playing Overlay ────────────────────────── */
function syncNowPlayingContent() {
  const artEl = $('playerArt');
  const artWrap = $('npoArtWrap');
  if (artWrap && artEl) artWrap.innerHTML = artEl.innerHTML;
  // Mirror art background color if no image
  if (artWrap && artEl?.style.background) artWrap.style.background = artEl.style.background;

  // Blurred background from art
  const bg = $('npoBg');
  if (bg) {
    const img = artEl?.querySelector('img');
    if (img?.src) {
      bg.style.backgroundImage = `url(${img.src})`;
      bg.style.background = '';
    } else {
      bg.style.backgroundImage = 'none';
      bg.style.background = artEl?.style.background ?? 'var(--bg)';
    }
  }

  if ($('npoTitle')) $('npoTitle').textContent = $('playerTitle')?.textContent ?? '';
  if ($('npoSub'))   $('npoSub').textContent   = $('playerSub')?.textContent   ?? '';

  // Sync progress
  if (audio.duration) {
    const pct = `${(audio.currentTime / audio.duration) * 100}%`;
    if ($('npoFill'))    $('npoFill').style.width      = pct;
    if ($('npoTimeCur')) $('npoTimeCur').textContent   = fmt(audio.currentTime);
    if ($('npoTimeDur')) $('npoTimeDur').textContent   = fmt(audio.duration);
  }

  // Play/pause button
  if ($('npoPlay')) $('npoPlay').innerHTML = playing ? '&#9646;&#9646;' : '&#9654;';
  // Shuffle/repeat
  $('npoShuffle')?.classList.toggle('active', state.shuffleOn);
  $('npoRepeat')?.classList.toggle('active', state.repeatMode !== 'off');
  // Volume
  if ($('npoVolume')) $('npoVolume').value = $('volumeSlider')?.value ?? '80';

  // Setlist — show queue tracks from current show
  const setlistEl = $('npoSetlist');
  if (setlistEl && state.queue.length) {
    setlistEl.innerHTML = state.queue.map((t, i) => {
      const active = i === state.queueIdx;
      return `<div class="npo-setlist-row ${active ? 'active' : ''}" data-idx="${i}">
        <span class="npo-setlist-num">${active ? '▶' : i + 1}</span>
        <span class="npo-setlist-title">${esc(t.title ?? 'Unknown Track')}</span>
        ${t.duration ? `<span class="npo-setlist-dur">${fmt(t.duration)}</span>` : ''}
      </div>`;
    }).join('');
    setlistEl.querySelectorAll('.npo-setlist-row').forEach(row =>
      row.addEventListener('click', () => {
        const idx = +row.dataset.idx;
        state.queueIdx = idx;
        player._playQueued(idx);
        syncNowPlayingContent();
      }));
    // Scroll active row into view
    const activeRow = setlistEl.querySelector('.npo-setlist-row.active');
    if (activeRow) activeRow.scrollIntoView({ block: 'nearest' });
  } else if (setlistEl) {
    setlistEl.innerHTML = '';
  }
}

function openNowPlaying() {
  const overlay = $('nowPlayingOverlay');
  if (!overlay) return;
  syncNowPlayingContent();
  overlay.style.display = 'flex';
  nowPlayingOpen = true;
}

function closeNowPlaying() {
  const overlay = $('nowPlayingOverlay');
  if (!overlay) return;
  overlay.style.display = 'none';
  nowPlayingOpen = false;
}

// Wire overlay controls
$('npoClose').addEventListener('click', closeNowPlaying);
$('nowPlayingOverlay').addEventListener('click', e => {
  if (e.target === $('nowPlayingOverlay')) closeNowPlaying();
});
// Escape handled in main keydown listener
$('npoPrev').addEventListener('click', () => player.prev());
$('npoPlay').addEventListener('click', () => { player.toggle(); syncNowPlayingContent(); });
$('npoNext').addEventListener('click', () => player.next());
$('npoShuffle').addEventListener('click', () => { $('btnShuffle').click(); syncNowPlayingContent(); });
$('npoRepeat').addEventListener('click',  () => { $('btnRepeat').click();  syncNowPlayingContent(); });
$('npoVolume').addEventListener('input', e => {
  audio.volume = e.target.value / 100;
  if ($('volumeSlider')) $('volumeSlider').value = e.target.value;
});
$('npoBar').addEventListener('click', e => {
  if (!audio.duration) return;
  const r = e.currentTarget.getBoundingClientRect();
  audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration;
});
// Keep play button in sync
audio.addEventListener('play',  () => { if (nowPlayingOpen && $('npoPlay')) $('npoPlay').innerHTML = '&#9646;&#9646;'; });
audio.addEventListener('pause', () => { if (nowPlayingOpen && $('npoPlay')) $('npoPlay').innerHTML = '&#9654;'; });

// Bookmark a moment
$('npoBookmark').addEventListener('click', () => {
  const track = state.queue[state.queueIdx];
  if (!track || !state.artist) { showToast('Nothing playing'); return; }
  const pos = Math.floor(audio.currentTime);
  store.addBookmark({
    artistSlug: state.artist.slug ?? '',
    artistName: state.artist.name ?? '',
    showDate:   state.show?.display_date ?? '',
    trackTitle: track.title ?? 'Unknown Track',
    position:   pos,
    savedAt:    new Date().toISOString(),
  });
  showToast(`🔖 Bookmarked at ${fmt(pos)}`);
});

// Open overlay by clicking the player art
$('playerArt').addEventListener('click', openNowPlaying);

$('progressBar').addEventListener('click', e => {
  if (!audio.duration) return;
  const r = e.currentTarget.getBoundingClientRect();
  audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration;
});

$('volumeSlider').addEventListener('input', e => { audio.volume = e.target.value / 100; });
audio.volume = 0.8;

$('btnPlay').addEventListener('click', () => player.toggle());
$('btnNext').addEventListener('click', () => player.next());
$('btnPrev').addEventListener('click', () => player.prev());

// Now-playing click → jump back to current show
$('playerTitle').addEventListener('click', () => {
  if (state.artist && state.show) viewShow(state.artist, state.show.display_date);
});

/* ── Shuffle / Repeat / Queue controls ─────────── */
$('btnShuffle').addEventListener('click', () => {
  state.shuffleOn = !state.shuffleOn;
  $('btnShuffle').classList.toggle('active', state.shuffleOn);
  if (state.shuffleOn && state.originalQueue.length) {
    const cur  = state.queue[state.queueIdx];
    const rest = shuffle(state.originalQueue.filter(t => t.uuid !== cur?.uuid));
    state.queue = cur ? [cur, ...rest] : rest;
    state.queueIdx = 0;
  } else if (!state.shuffleOn && state.originalQueue.length) {
    const cur = state.queue[state.queueIdx];
    state.queue    = state.originalQueue;
    state.queueIdx = Math.max(0, state.originalQueue.findIndex(t => t.uuid === cur?.uuid));
  }
  preloadNext();
  renderQueuePanel();
});

$('btnRepeat').addEventListener('click', () => {
  const cycle = { off: 'one', one: 'all', all: 'off' };
  state.repeatMode = cycle[state.repeatMode];
  const btn = $('btnRepeat');
  btn.classList.toggle('active', state.repeatMode !== 'off');
  btn.title = state.repeatMode === 'off' ? 'Repeat' : state.repeatMode === 'one' ? 'Repeat One' : 'Repeat All';
  btn.textContent = state.repeatMode === 'one' ? '①' : '↺';
});

$('btnRadio').addEventListener('click', () => {
  radioMode = !radioMode;
  $('btnRadio').classList.toggle('active', radioMode);
  $('btnRadio').title = radioMode ? 'Artist Radio ON — click to stop' : 'Artist Radio';
  showToast(radioMode ? 'Artist Radio on — will auto-play a related artist when queue ends' : 'Artist Radio off');
  if (radioMode && !state.queue.length) tryRadio();
});

$('btnQueue').addEventListener('click', () => {
  const open = $('queuePanel').classList.toggle('open');
  $('appBody').classList.toggle('queue-open', open);
  $('btnQueue').classList.toggle('active', open);
  if (open) renderQueuePanel();
});


$('queueClose').addEventListener('click', () => {
  $('queuePanel').classList.remove('open');
  $('appBody').classList.remove('queue-open');
  $('btnQueue').classList.remove('active');
});

$('queueSave').addEventListener('click', () => {
  if (!state.queue.length) { showToast('Queue is empty'); return; }
  const name = prompt('Name this queue:', `Queue — ${new Date().toLocaleDateString()}`);
  if (!name) return;
  const qs = getSavedQueues();
  qs.unshift({ name, tracks: [...state.queue], savedAt: new Date().toISOString() });
  if (qs.length > 20) qs.length = 20;
  saveQueues(qs);
  renderSavedQueues();
  showToast(`Saved: ${name}`);
});

$('btnCast').addEventListener('click', async () => {
  if (cast.active) { await window.ipc?.castStop(); return; }
  $('btnCast').disabled = true;
  showToast('Searching for Cast devices…');
  const res = await window.ipc?.castDiscover();
  $('btnCast').disabled = false;
  if (!res?.ok || !res.devices?.length) { showToast('No Cast devices found on this network'); return; }
  showCastPicker(res.devices);
});
$('castPickerClose').addEventListener('click', () => { $('castPicker').style.display = 'none'; });
$('castPicker').addEventListener('click', e => { if (e.target === $('castPicker')) $('castPicker').style.display = 'none'; });

/* ── Sleep Timer ───────────────────────────────── */
const sleepTimer = {
  _timer: null,
  _fadeInterval: null,
  _endAt: 0,
  _tickInterval: null,

  set(mins) {
    this.cancel();
    this._endAt = Date.now() + mins * 60 * 1000;
    this._timer = setTimeout(() => this._expire(), mins * 60 * 1000);
    this._tickInterval = setInterval(() => this._updateBtn(), 10000);
    $('btnSleep').classList.add('active');
    this._updateBtn();
    showToast(`Sleep timer set for ${mins} min`);
    $('sleepPicker').style.display = 'none';
  },

  cancel() {
    clearTimeout(this._timer);
    clearInterval(this._fadeInterval);
    clearInterval(this._tickInterval);
    this._timer = null; this._endAt = 0;
    $('btnSleep').classList.remove('active');
    $('btnSleep').title = 'Sleep Timer';
  },

  _updateBtn() {
    if (!this._endAt) return;
    const left = Math.max(0, Math.round((this._endAt - Date.now()) / 60000));
    $('btnSleep').title = `Sleep in ${left} min — click to cancel`;
  },

  _expire() {
    clearInterval(this._tickInterval);
    showToast('Sleep timer: fading out…');
    const startVol = audio.volume;
    let step = 0;
    this._fadeInterval = setInterval(() => {
      step++;
      audio.volume = Math.max(0, startVol * (1 - step / 20));
      if (step >= 20) {
        clearInterval(this._fadeInterval);
        audio.pause();
        playing = false;
        syncEq();
        $('btnPlay').innerHTML = '&#9654;';
        audio.volume = startVol;
        this.cancel();
        showToast('Sleep timer: goodnight');
      }
    }, 150);
  },
};

$('btnSleep').addEventListener('click', () => {
  if (sleepTimer._endAt) { sleepTimer.cancel(); showToast('Sleep timer cancelled'); return; }
  const panel = $('sleepPicker');
  const active = sleepTimer._endAt > 0;
  $('sleepCancelBtn').style.display = active ? '' : 'none';
  panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
});
$('sleepPickerClose').addEventListener('click', () => { $('sleepPicker').style.display = 'none'; });
$('sleepPicker').addEventListener('click', e => { if (e.target === $('sleepPicker')) $('sleepPicker').style.display = 'none'; });
$('sleepCancelBtn').addEventListener('click', () => { sleepTimer.cancel(); showToast('Sleep timer cancelled'); $('sleepPicker').style.display = 'none'; });
$('sleepPicker').querySelectorAll('.sleep-opt').forEach(btn =>
  btn.addEventListener('click', () => sleepTimer.set(+btn.dataset.mins)));

/* ── Concert Companion ─────────────────────────── */
function openCompanion(src, show) {
  const panel = $('companionPanel');
  const body  = $('companionBody');
  const noteKey = `db-note-${show?.artist_slug ?? 'unknown'}-${show?.display_date ?? ''}`;
  const savedNote = localStorage.getItem(noteKey) ?? '';

  const infoHtml = [
    src?.taper    ? `<div class="companion-section"><div class="companion-section-title">Taper</div><p>${esc(src.taper)}</p></div>` : '',
    src?.lineage  ? `<div class="companion-section"><div class="companion-section-title">Lineage</div><p>${esc(src.lineage)}</p></div>` : '',
    src?.taper_notes ? `<div class="companion-section"><div class="companion-section-title">Taper Notes</div><p>${esc(src.taper_notes)}</p></div>` : '',
    src?.description ? `<div class="companion-section"><div class="companion-section-title">Info</div><p>${esc(src.description)}</p></div>` : '',
    (!src?.taper && !src?.lineage && !src?.taper_notes && !src?.description)
      ? `<div class="companion-section"><p style="color:var(--text3)">No recording info available for this source.</p></div>` : '',
  ].join('');

  body.innerHTML = `
    ${infoHtml}
    <div class="companion-section">
      <div class="companion-section-title">My Notes</div>
      <textarea class="companion-notes-ta" id="companionNotes" placeholder="Add your notes about this show…">${esc(savedNote)}</textarea>
      <div class="companion-notes-hint">Auto-saved · included in data export</div>
    </div>`;

  let noteDebounce = null;
  $('companionNotes').addEventListener('input', e => {
    clearTimeout(noteDebounce);
    noteDebounce = setTimeout(() => localStorage.setItem(noteKey, e.target.value), 600);
  });

  panel.classList.add('open');
}

function closeCompanion() {
  $('companionPanel').classList.remove('open');
}

$('companionClose').addEventListener('click', closeCompanion);

function getSavedQueues() { try { return JSON.parse(localStorage.getItem('db-saved-queues') || '[]'); } catch { return []; } }
function saveQueues(qs)  { localStorage.setItem('db-saved-queues', JSON.stringify(qs)); }

function renderSavedQueues() {
  const qs = getSavedQueues();
  const sec = $('savedQueuesSection');
  if (!qs.length) { sec.style.display = 'none'; return; }
  sec.style.display = 'block';
  $('savedQueuesList').innerHTML = qs.map((q, i) => `
    <div class="saved-queue-row">
      <div class="saved-queue-info" data-qi="${i}">
        <div class="saved-queue-name">${esc(q.name)}</div>
        <div class="saved-queue-meta">${q.tracks.length} tracks</div>
      </div>
      <button class="saved-queue-del" data-qi="${i}" title="Delete">✕</button>
    </div>`).join('');
  $('savedQueuesList').querySelectorAll('.saved-queue-info').forEach(el =>
    el.addEventListener('click', () => {
      const q = getSavedQueues()[+el.dataset.qi];
      if (!q) return;
      state.queue = q.tracks; state.queueIdx = 0;
      player._playQueued(0);
      showToast(`Loaded: ${q.name}`);
    }));
  $('savedQueuesList').querySelectorAll('.saved-queue-del').forEach(btn =>
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const qs = getSavedQueues(); qs.splice(+btn.dataset.qi, 1); saveQueues(qs);
      renderSavedQueues();
    }));
}

let dragSrcIdx = null;

function renderQueuePanel() {
  if (!$('queuePanel').classList.contains('open')) return;
  const q = state.queue;
  if (!q.length) {
    $('queueList').innerHTML = `<div class="loading" style="height:60px;font-size:12px">No tracks queued</div>`;
    renderSavedQueues(); return;
  }
  $('queueList').innerHTML = q.map((t, i) => `
    <div class="queue-item ${i === state.queueIdx ? 'current' : ''}" data-qi="${i}" draggable="true">
      <div class="queue-drag-handle">⠿</div>
      <div class="queue-item-num">${i === state.queueIdx ? '▶' : i + 1}</div>
      <div class="queue-item-name">${esc(t.title || 'Unknown')}</div>
      <div class="queue-item-dur">${fmt(t.duration)}</div>
    </div>`).join('');

  $('queueList').querySelectorAll('.queue-item').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.classList.contains('queue-drag-handle')) return;
      state.queueIdx = parseInt(el.dataset.qi);
      player._playQueued(state.queueIdx);
    });
    el.addEventListener('dragstart', () => { dragSrcIdx = parseInt(el.dataset.qi); el.classList.add('dragging'); });
    el.addEventListener('dragend',   () => el.classList.remove('dragging'));
    el.addEventListener('dragover',  e => { e.preventDefault(); el.classList.add('drag-over'); });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', e => {
      e.preventDefault(); el.classList.remove('drag-over');
      const destIdx = parseInt(el.dataset.qi);
      if (dragSrcIdx === null || dragSrcIdx === destIdx) return;
      const moved = state.queue.splice(dragSrcIdx, 1)[0];
      state.queue.splice(destIdx, 0, moved);
      if (state.queueIdx === dragSrcIdx) state.queueIdx = destIdx;
      else if (dragSrcIdx < state.queueIdx && destIdx >= state.queueIdx) state.queueIdx--;
      else if (dragSrcIdx > state.queueIdx && destIdx <= state.queueIdx) state.queueIdx++;
      dragSrcIdx = null;
      renderQueuePanel();
    });
  });

  const cur = $('queueList').querySelector('.current');
  if (cur) cur.scrollIntoView({ block: 'nearest' });
  renderSavedQueues();
}

/* ── Cast session management ─────────────────── */
function updateCastUI() {
  const btn = $('btnCast');
  if (!btn) return;
  btn.classList.toggle('active', cast.active);
  btn.title = cast.active ? `Casting to ${cast.deviceName} — click to stop` : 'Cast';
  if (cast.active) $('btnPlay').innerHTML = cast.paused ? '&#9654;' : '&#9646;&#9646;';
}

function showCastPicker(devices) {
  const list = $('castPickerList');
  list.innerHTML = devices.map((d, i) =>
    `<div class="cast-device-item" data-idx="${i}">${esc(d.name)}</div>`).join('');
  $('castPicker').style.display = 'flex';
  list.querySelectorAll('.cast-device-item').forEach(el =>
    el.addEventListener('click', () => {
      $('castPicker').style.display = 'none';
      castStartSession(devices[+el.dataset.idx]);
    }));
}

async function castStartSession(device) {
  showToast(`Connecting to ${device.name}…`);
  const conn = await window.ipc?.castConnect(device.host, device.port);
  if (!conn?.ok) { showToast(`Connect failed: ${conn?.error}`); return; }
  const track = state.queue[state.queueIdx];
  if (!track) { showToast('Nothing to cast'); return; }
  let url = track.stream_url ?? track.mp3_url;
  if (track._nugs && !url) {
    try {
      url = track._nugs_video
        ? await nugsApi.vidStreamUrl(track._nugs_skuId, track._nugs_containerId)
        : await nugsApi.streamUrl(track._nugs_trackId);
      if (url) track.stream_url = url;
    } catch(e) { handleNugsAuthError(e); return; }
  }
  if (!url) { showToast('No stream URL available'); return; }
  const artSrc = $('playerArt')?.querySelector('img')?.src ?? '';
  const artUrl = artSrc.startsWith('data:') ? '' : artSrc;
  const res = await window.ipc?.castLoad(url, castContentType(url), track.title ?? '', artUrl);
  if (!res?.ok) { showToast(`Cast load failed: ${res?.error}`); return; }
  audio.pause(); playing = false; syncEq(); $('btnPlay').innerHTML = '&#9654;';
  cast.active = true; cast.paused = false; cast.deviceName = device.name;
  updateCastUI(); showToast(`Casting to ${device.name}`);
}

async function castAdvanceTrack() {
  const track = state.queue[state.queueIdx];
  if (!track) return;
  let url = track.stream_url ?? track.mp3_url;
  if (track._nugs && !url) {
    try {
      url = track._nugs_video
        ? await nugsApi.vidStreamUrl(track._nugs_skuId, track._nugs_containerId)
        : await nugsApi.streamUrl(track._nugs_trackId);
      if (url) track.stream_url = url;
    } catch(e) { return; }
  }
  if (!url) return;
  $('playerTitle').textContent = track.title || '';
  $('playerSub').textContent = `${state.artist?.name ?? ''} · ${state.show?.display_date ?? ''}`;
  window.ipc?.send('player-update', { title: `${track.title} — ${state.artist?.name}` });
  await window.ipc?.castLoad(url, castContentType(url), track.title ?? '', '');
  cast.paused = false; updateCastUI();
}

/* ── Shortcuts modal ───────────────────────────── */
function openShortcuts() { $('shortcutsModal').style.display = 'flex'; }
function closeShortcuts() { $('shortcutsModal').style.display = 'none'; }
$('shortcutsClose').addEventListener('click', closeShortcuts);
$('btnHelp').addEventListener('click', openShortcuts);
$('shortcutsModal').addEventListener('click', e => { if (e.target === $('shortcutsModal') || e.target.classList.contains('shortcuts-backdrop')) closeShortcuts(); });

/* ── Keyboard shortcuts ─────────────────────────── */
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'Escape') {
    if ($('shortcutsModal').style.display !== 'none') { closeShortcuts(); return; }
    if (nowPlayingOpen) { closeNowPlaying(); return; }
  }
  if (e.key === '?') { e.preventDefault(); openShortcuts(); return; }
  if (e.altKey && e.key === 'ArrowLeft')  { e.preventDefault(); nav.back();    return; }
  if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); nav.forward(); return; }
  switch (e.key) {
    case ' ':
      e.preventDefault(); player.toggle(); break;
    case 'ArrowLeft':
      e.preventDefault();
      if (audio.duration) audio.currentTime = Math.max(0, audio.currentTime - 10);
      break;
    case 'ArrowRight':
      e.preventDefault();
      if (audio.duration) audio.currentTime = Math.min(audio.duration, audio.currentTime + 10);
      break;
    case 'ArrowUp':
      e.preventDefault();
      audio.volume = Math.min(1, audio.volume + 0.05);
      $('volumeSlider').value = Math.round(audio.volume * 100);
      break;
    case 'ArrowDown':
      e.preventDefault();
      audio.volume = Math.max(0, audio.volume - 0.05);
      $('volumeSlider').value = Math.round(audio.volume * 100);
      break;
    case '[':
      e.preventDefault(); player.prev(); break;
    case ']':
      e.preventDefault(); player.next(); break;
    case 's': case 'S':
      e.preventDefault();
      state.shuffleOn = !state.shuffleOn;
      $('btnShuffle').classList.toggle('active', state.shuffleOn);
      break;
    case 'r': case 'R':
      e.preventDefault();
      $('btnRepeat').click();
      break;
    case 'q': case 'Q':
      e.preventDefault();
      $('btnQueue').click();
      break;
    case '/':
      e.preventDefault();
      $('searchToggle').click();
      break;
    case 'm': case 'M':
      if (!e.altKey) {
        e.preventDefault();
        $('btnMini').click();
      }
      break;
  }
});

/* ── Context menu (right-click track) ─────────── */
let ctxTrackUrl  = null;
let ctxTrackData = null;

document.addEventListener('contextmenu', e => {
  const row = e.target.closest('.track-row');
  if (!row) { hideCtx(); return; }
  e.preventDefault();
  const uuid  = row.dataset.trackUuid;
  const track = state.queue.find(t => t.uuid === uuid)
    ?? flatTracks(state.source ?? {}).find(t => t.uuid === uuid);
  if (!track?.mp3_url) return;
  ctxTrackUrl  = track.mp3_url;
  ctxTrackData = track;
  const menu = $('ctxMenu');
  menu.style.display = 'block';
  menu.style.left = `${Math.min(e.clientX, window.innerWidth  - 170)}px`;
  menu.style.top  = `${Math.min(e.clientY, window.innerHeight - 60)}px`;
});

document.addEventListener('click', () => hideCtx());
document.addEventListener('keydown', e => { if (e.key === 'Escape') { hideCtx(); hideTapePicker(); } });

function hideCtx() { $('ctxMenu').style.display = 'none'; ctxTrackUrl = null; ctxTrackData = null; }

$('ctxCopyUrl').addEventListener('click', () => {
  if (!ctxTrackUrl) return;
  navigator.clipboard.writeText(ctxTrackUrl).then(() => showToast('Stream URL copied!'));
  hideCtx();
});

$('ctxAddTape').addEventListener('click', () => {
  if (!ctxTrackData) return;
  const track = ctxTrackData;
  hideCtx();
  showTapePickerForTrack(track);
});

/* ── Tape Picker ───────────────────────────────── */
let _tapePickerTrack = null;

function showTapePickerForTrack(track) {
  _tapePickerTrack = track;
  renderTapePickerList();
  const picker = $('tapePicker');
  picker.style.display = 'block';
  picker.style.left = `${Math.round(window.innerWidth  / 2 - 110)}px`;
  picker.style.top  = `${Math.round(window.innerHeight / 2 - 80)}px`;
}

function hideTapePicker() {
  $('tapePicker').style.display = 'none';
  _tapePickerTrack = null;
}

function renderTapePickerList() {
  const all = tapes.getAll();
  if (!all.length) {
    $('tapePickerList').innerHTML = `<div style="padding:10px 12px;font-size:12px;color:var(--text3)">No tapes yet</div>`;
  } else {
    $('tapePickerList').innerHTML = all.map(t => `
      <div class="tape-picker-item" data-tid="${esc(t.id)}">
        ${esc(t.name)} <span style="color:var(--text3);font-size:11px">(${t.tracks.length})</span>
      </div>`).join('');
    $('tapePickerList').querySelectorAll('.tape-picker-item').forEach(item =>
      item.addEventListener('click', () => {
        if (!_tapePickerTrack) return;
        const tapeName = tapes.getAll().find(t => t.id === item.dataset.tid)?.name ?? '';
        const added    = tapes.addTrack(item.dataset.tid, _tapePickerTrack);
        showToast(added ? `Added to "${tapeName}"` : 'Already in tape');
        hideTapePicker();
      }));
  }
}

$('tapePickerNew').addEventListener('click', () => {
  const name = prompt('New tape name:');
  if (!name?.trim()) return;
  const id = tapes.create(name.trim());
  if (_tapePickerTrack) {
    tapes.addTrack(id, _tapePickerTrack);
    showToast(`Added to "${name.trim()}"`);
    hideTapePicker();
  } else {
    renderTapePickerList();
  }
});

document.addEventListener('click', e => {
  if (!$('tapePicker').contains(e.target) && !e.target.classList.contains('track-add-tape')) {
    hideTapePicker();
  }
});

/* ── Views ─────────────────────────────────────── */
const showLoading = () => {
  $('contentInner').innerHTML = `
    <div class="skeleton-list">
      ${Array.from({length: 6}, () => `
        <div class="skeleton-row">
          <div class="skel skel-date"></div>
          <div class="skel skel-venue"></div>
          <div class="skel skel-badge"></div>
        </div>`).join('')}
    </div>`;
};
const fadeIn = (el = $('contentInner')) => {
  el.classList.remove('content-fadein');
  void el.offsetWidth; // force reflow
  el.classList.add('content-fadein');
};
const showError = (msg) => {
  $('contentInner').innerHTML = `<div class="error-state"><div class="icon">⚠️</div><p>${esc(msg)}</p></div>`;
};

function setBreadcrumb(parts) {
  // Reset content-inner style overrides set by nugs split-view
  const ci = $('contentInner');
  ci.style.overflow = '';
  ci.style.padding  = '';
  // Close companion panel on any page navigation
  $('companionPanel')?.classList.remove('open');
  $('breadcrumb').innerHTML = '';
  parts.forEach((p, i) => {
    const el = document.createElement('span');
    el.className = i === parts.length - 1 ? 'bc-current' : 'bc-item';
    el.textContent = p.label;
    if (p.onClick || p.fn) el.addEventListener('click', p.onClick ?? p.fn);
    $('breadcrumb').appendChild(el);
    if (i < parts.length - 1) {
      const sep = document.createElement('span');
      sep.className = 'bc-sep'; sep.textContent = '›';
      $('breadcrumb').appendChild(sep);
    }
  });
  $('breadcrumb').appendChild(searchToggleEl);
  $('breadcrumb').appendChild(searchInlineEl);
}

/* ── On This Date ──────────────────────────────── */
async function viewToday() {
  nav.record(viewToday, []);
  showLoading();
  const now    = new Date();
  const month  = now.getMonth() + 1;
  const day    = now.getDate();
  const label  = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  const dayOrd = day + (['th','st','nd','rd'][day % 10 > 3 || ~~(day % 100 / 10) === 1 ? 0 : day % 10] ?? 'th');
  setBreadcrumb([{ label: `On This Day — ${label}` }]);
  try {
    const data  = await api.onDate(month, day);
    const shows = data.shows ?? data ?? [];
    if (!shows.length) {
      $('contentInner').innerHTML = `<div class="error-state"><p>No shows found for ${esc(label)}</p></div>`;
      return;
    }

    // Group by year, newest first
    const byYear = {};
    for (const s of shows) {
      const yr = (s.display_date ?? '').slice(0, 4);
      (byYear[yr] ??= []).push(s);
    }
    const years = Object.keys(byYear).sort((a, b) => b - a);
    const totalArtists = new Set(shows.map(s => s.artist_slug)).size;

    $('contentInner').innerHTML = `
      <div class="otd-hero">
        <div class="otd-hero-date">
          <span class="otd-month">${now.toLocaleDateString('en-US',{month:'long'})}</span>
          <span class="otd-day">${dayOrd}</span>
        </div>
        <div class="otd-hero-meta">
          <div class="otd-hero-count">${shows.length} shows</div>
          <div class="otd-hero-sub">${totalArtists} artists · ${years.length} years of recordings</div>
        </div>
      </div>
      <div id="otdTimeline">${years.map(yr => `
        <div class="otd-year-group">
          <div class="otd-year-label">${esc(yr)}</div>
          <div class="otd-year-shows">
            ${byYear[yr].map(s => {
              const artist = state.artists.find(a => a.slug === s.artist_slug) ?? { name: s.artist_name ?? s.artist_slug ?? '', slug: s.artist_slug ?? '' };
              const color  = artistColor(artist.name);
              const init   = esc((artist.name[0] ?? '?').toUpperCase());
              const imgStyle = artist.image_url ? `background-image:url('${esc(artist.image_url)}')` : `background:${color}`;
              return `<div class="otd-row" data-slug="${esc(s.artist_slug ?? '')}" data-date="${esc(s.display_date)}">
                <div class="otd-avatar" style="${imgStyle}" data-name="${esc(artist.name)}">${artist.image_url ? '' : `<span>${init}</span>`}</div>
                <div class="otd-info">
                  <div class="otd-artist-name">${esc(artist.name)}</div>
                  <div class="otd-venue-name">${esc(s.venue?.name ?? '')}${s.venue?.location ? ` · ${esc(s.venue.location)}` : ''}</div>
                </div>
                <div class="otd-badges">
                  ${s.has_soundboard_source ? '<span class="badge badge-sbd">SBD</span>' : ''}
                  ${s.avg_rating ? `<span class="otd-rating">${stars(s.avg_rating)}</span>` : ''}
                </div>
                <button class="otd-play-btn" title="Play best recording">▶</button>
              </div>`;
            }).join('')}
          </div>
        </div>`).join('')}
      </div>`;

    fadeIn();

    // Wire up clicks and play buttons
    $('otdTimeline').querySelectorAll('.otd-row').forEach(row => {
      const artist = state.artists.find(a => a.slug === row.dataset.slug) ?? { name: row.dataset.slug, slug: row.dataset.slug };
      row.addEventListener('click', e => {
        if (e.target.classList.contains('otd-play-btn')) return;
        state.artist = artist; viewShow(artist, row.dataset.date);
      });
      row.querySelector('.otd-play-btn').addEventListener('click', async e => {
        e.stopPropagation();
        state.artist = artist;
        showLoading();
        try {
          const show = await api.show(artist.slug, row.dataset.date);
          const src  = (show.sources ?? []).sort((a,b) => (b.is_soundboard - a.is_soundboard) || (b.avg_rating - a.avg_rating))[0];
          if (src?.tracks?.length) { queueAndPlay(src.tracks, artist, show, 0); viewShow(artist, row.dataset.date); }
          else viewShow(artist, row.dataset.date);
        } catch { viewShow(artist, row.dataset.date); }
      });
    });

    // Enrich avatars with Wikipedia photos
    for (const el of $('otdTimeline').querySelectorAll('.otd-avatar[data-name]')) {
      const name = el.dataset.name;
      if (el.querySelector('img') || !name) continue;
      lastfmArtistImage(name).then(url => {
        if (!url || el.querySelector('img')) return;
        const img = new Image(); img.alt = name;
        img.onload = () => { el.innerHTML = ''; el.appendChild(img); el.style.backgroundImage = ''; };
        img.src = url;
      });
    }
  } catch(e) { showError(e.message); }
}

/* ── Welcome with On This Day widget ───────────── */
async function viewWelcome() {
  nav.record(viewWelcome, []);
  $('breadcrumb').innerHTML = '';
  $('breadcrumb').appendChild(searchToggleEl);
  $('breadcrumb').appendChild(searchInlineEl);
  const now   = new Date();
  const label = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

  $('contentInner').innerHTML = `
    <div class="welcome">
      <div class="welcome-logo">D</div>
      <h2>Days Between</h2>
      <p>Stream 70,000+ live concert recordings from Phish, Grateful Dead, and thousands more.
         Powered by <strong style="color:var(--accent)">Relisten</strong>.</p>
      <div class="welcome-actions">
        <button class="action-btn primary" id="btnWelcomeRandom">🎲 Random Show</button>
        <button class="action-btn" id="btnWelcomeRecent">🆕 Recently Added</button>
      </div>
      <div class="welcome-sotd" id="welcomeSotd">
        <div class="welcome-otd-title">🎵 Show of the Day</div>
        <div id="sotdContent"><div class="loading" style="height:50px;font-size:12px"><div class="spinner"></div></div></div>
      </div>
      <div class="welcome-otd">
        <div class="welcome-otd-title">On This Day — ${esc(label)}</div>
        <div id="welcomeOtd"><div class="loading" style="height:60px;font-size:12px"><div class="spinner"></div>Loading…</div></div>
      </div>
    </div>`;

  $('btnWelcomeRecent').addEventListener('click', () => viewRecent());
  $('btnWelcomeRandom').addEventListener('click', async () => {
    if (!state.artists.length) return;
    const artist = state.artists[Math.floor(Math.random() * state.artists.length)];
    state.artist = artist;
    document.querySelectorAll('.artist-item').forEach(i => i.classList.remove('active'));
    document.querySelector(`[data-slug="${CSS.escape(artist.slug)}"]`)?.classList.add('active');
    showLoading();
    try {
      const show = await api.random(artist.slug);
      viewShow(artist, show.display_date);
    } catch(e) { showError(e.message); }
  });

  // Show of the Day — deterministic pick from top shows, refreshes daily
  (async () => {
    try {
      const today  = new Date().toISOString().slice(0, 10);
      const cached = JSON.parse(localStorage.getItem('sotd') || 'null');
      let sotd = (cached?.date === today) ? cached.show : null;
      if (!sotd) {
        const data  = await api.trending();
        const shows = (data.shows ?? data ?? []).filter(s => s.artist_slug);
        if (shows.length) {
          const seed = today.replace(/-/g, '');
          sotd = shows[parseInt(seed.slice(-4)) % shows.length];
          localStorage.setItem('sotd', JSON.stringify({ date: today, show: sotd }));
        }
      }
      if (!sotd) { $('welcomeSotd').style.display = 'none'; return; }
      const artist = state.artists.find(a => a.slug === sotd.artist_slug) || { name: sotd.artist_slug, slug: sotd.artist_slug };
      $('sotdContent').innerHTML = `
        <div class="sotd-card" data-slug="${esc(sotd.artist_slug)}" data-date="${esc(sotd.display_date)}">
          <div class="sotd-artist">${esc(artist.name)}</div>
          <div class="sotd-meta">${esc(sotd.display_date)}${sotd.venue?.name ? ' · ' + esc(sotd.venue.name) : ''}${sotd.venue?.location ? ', ' + esc(sotd.venue.location) : ''}</div>
          ${sotd.avg_rating ? `<div class="sotd-rating">${'★'.repeat(Math.round(sotd.avg_rating))} ${sotd.avg_rating.toFixed(1)}</div>` : ''}
          <button class="action-btn primary sotd-play" style="margin-top:8px">▶ Play Show</button>
        </div>`;
      $('sotdContent').querySelector('.sotd-card').addEventListener('click', () => viewShow(artist, sotd.display_date));
      $('sotdContent').querySelector('.sotd-play').addEventListener('click', async e => {
        e.stopPropagation();
        showLoading();
        try { viewShow(artist, sotd.display_date); } catch {}
      });
    } catch { $('welcomeSotd').style.display = 'none'; }
  })();

  try {
    const data  = await api.onDate(now.getMonth() + 1, now.getDate());
    const shows = (data.shows ?? data ?? []).slice(0, 20);
    if (!shows.length) { $('welcomeOtd').innerHTML = `<div style="font-size:12px;color:var(--text3)">No shows found for today.</div>`; return; }
    $('welcomeOtd').innerHTML = shows.map(s => {
      const artist = state.artists.find(a => a.slug === s.artist_slug) || { name: s.artist_slug, slug: s.artist_slug };
      return `<div class="otd-show-row" data-slug="${esc(s.artist_slug)}" data-date="${esc(s.display_date)}" style="margin-bottom:5px;padding:8px 12px">
        <div class="otd-artist" style="min-width:130px">${esc(artist.name)}</div>
        <div class="otd-year">${esc((s.display_date||'').slice(0,4))}</div>
        <div class="otd-venue">${esc(s.venue?.name??'')}</div>
      </div>`;
    }).join('');
    $('welcomeOtd').querySelectorAll('.otd-show-row').forEach(row =>
      row.addEventListener('click', () => {
        const artist = state.artists.find(a => a.slug === row.dataset.slug) || { name: row.dataset.slug, slug: row.dataset.slug };
        state.artist = artist;
        viewShow(artist, row.dataset.date);
      }));
  } catch { $('welcomeOtd').innerHTML = `<div style="font-size:12px;color:var(--text3)">Could not load shows.</div>`; }
}

/* ── Saved shows ───────────────────────────────── */
function viewSaved() {
  nav.record(viewSaved, []);
  setBreadcrumb([{ label: 'Saved Shows' }]);
  const favs = store.getFavs();
  if (!favs.length) {
    $('contentInner').innerHTML = `<div class="welcome"><div class="welcome-logo" style="font-size:24px">♥</div><h2>No saved shows yet</h2><p>Click the heart on any show to save it here.</p></div>`;
    return;
  }
  $('contentInner').innerHTML = `
    <div class="section-header">
      <div><div class="section-title">Saved Shows</div><div class="section-subtitle">${favs.length} show${favs.length!==1?'s':''}</div></div>
    </div>
    <div class="show-list">
      ${favs.map(f => `
        <div class="show-row" data-slug="${esc(f.artistSlug)}" data-date="${esc(f.date)}">
          <div class="show-date">${esc(f.displayDate)}</div>
          <div class="show-venue">${esc(f.artistName)}${f.venueName?' — '+esc(f.venueName):''}</div>
          <div class="show-badges"></div>
          <button class="show-heart favorited" data-slug="${esc(f.artistSlug)}" data-date="${esc(f.date)}" title="Unsave">♥</button>
        </div>`).join('')}
    </div>`;
  $('contentInner').querySelectorAll('.show-row').forEach(row =>
    row.addEventListener('click', e => {
      if (e.target.classList.contains('show-heart')) return;
      const artist = state.artists.find(a => a.slug === row.dataset.slug) || { name: row.dataset.slug, slug: row.dataset.slug };
      state.artist = artist;
      viewShow(artist, row.dataset.date);
    }));
  $('contentInner').querySelectorAll('.show-heart').forEach(btn =>
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const fav = store.getFavs().find(f => f.artistSlug === btn.dataset.slug && f.date === btn.dataset.date);
      if (fav) { store.toggleFav({ display_date: fav.date, venue: { name: fav.venueName } }, { slug: fav.artistSlug, name: fav.artistName }); viewSaved(); }
    }));
}

/* ── History ───────────────────────────────────── */
function viewHistory() {
  nav.record(viewHistory, []);
  setBreadcrumb([{ label: 'Recently Played' }]);
  const hist = store.getHistory();
  if (!hist.length) {
    $('contentInner').innerHTML = `<div class="welcome"><div class="welcome-logo" style="font-size:24px">⏱</div><h2>No history yet</h2><p>Tracks you play will appear here.</p></div>`;
    return;
  }
  const groups = {};
  hist.forEach(h => {
    const day = h.playedAt ? new Date(h.playedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Unknown';
    (groups[day] = groups[day] || []).push(h);
  });
  $('contentInner').innerHTML = `
    <div class="section-header">
      <div><div class="section-title">Recently Played</div><div class="section-subtitle">Last ${hist.length} tracks</div></div>
    </div>
    ${Object.entries(groups).map(([day, items]) => `
      <div class="history-date-group">
        <div class="history-date-label">${esc(day)}</div>
        ${items.map(h => `
          <div class="list-item" data-slug="${esc(h.artistSlug)}" data-date="${esc(h.date)}">
            ${esc(h.trackTitle)}
            <div class="list-item-sub">${esc(h.artistName)} · ${esc(h.showDate)}</div>
          </div>`).join('')}
      </div>`).join('')}`;
  $('contentInner').querySelectorAll('.list-item').forEach(el =>
    el.addEventListener('click', () => {
      if (!el.dataset.slug || !el.dataset.date) return;
      const artist = state.artists.find(a => a.slug === el.dataset.slug) || { name: el.dataset.slug, slug: el.dataset.slug };
      state.artist = artist;
      viewShow(artist, el.dataset.date);
    }));
}

/* ── Bookmarks ─────────────────────────────────── */
function viewBookmarks(activeTab = 'bookmarks') {
  nav.record(viewBookmarks, [activeTab]);
  setBreadcrumb([{ label: 'Bookmarks' }]);

  const bks      = store.getBookmarks();
  const attended = store.getAttended();

  function renderBookmarksTab() {
    const container = $('bkTabContent');
    if (!bks.length) {
      container.innerHTML = `<div class="welcome" style="padding-top:40px"><div style="font-size:24px">🔖</div><h2>No bookmarks yet</h2><p>Open the Now Playing view and tap 🔖 to pin a moment.</p></div>`;
      return;
    }
    container.innerHTML = `<div class="bk-list">
      ${bks.map((b, i) => `
        <div class="bk-row" data-idx="${i}" data-slug="${esc(b.artistSlug)}" data-date="${esc(b.showDate)}">
          <div class="bk-icon">🔖</div>
          <div class="bk-info">
            <div class="bk-track">${esc(b.trackTitle)}</div>
            <div class="bk-sub">${esc(b.artistName)} · ${esc(b.showDate)} · ${fmt(b.position)}</div>
          </div>
          <button class="bk-del" data-idx="${i}" title="Remove">✕</button>
        </div>`).join('')}
    </div>`;
    container.querySelectorAll('.bk-row').forEach(row =>
      row.addEventListener('click', e => {
        if (e.target.classList.contains('bk-del')) return;
        const slug = row.dataset.slug; const date = row.dataset.date;
        if (!slug || !date) return;
        const artist = state.artists.find(a => a.slug === slug) || { name: slug, slug };
        viewShow(artist, date);
      }));
    container.querySelectorAll('.bk-del').forEach(btn =>
      btn.addEventListener('click', e => {
        e.stopPropagation();
        store.removeBookmark(+btn.dataset.idx);
        renderBookmarksTab();
      }));
  }

  function renderAttendedTab() {
    const container = $('bkTabContent');
    if (!attended.length) {
      container.innerHTML = `<div class="welcome" style="padding-top:40px"><div style="font-size:24px">📍</div><h2>No shows marked yet</h2><p>Open any show and tap "📍 I Was There" to log it.</p></div>`;
      return;
    }
    container.innerHTML = `<div class="bk-list">
      ${attended.map((a, i) => `
        <div class="bk-row" data-idx="${i}" data-slug="${esc(a.artistSlug)}" data-date="${esc(a.date)}">
          <div class="bk-icon">📍</div>
          <div class="bk-info">
            <div class="bk-track">${esc(a.artistName)} — ${esc(a.date)}</div>
            <div class="bk-sub">${esc(a.venueName)}${a.venueLocation ? ' · ' + esc(a.venueLocation) : ''}</div>
          </div>
          <button class="bk-del" data-idx="${i}" title="Remove">✕</button>
        </div>`).join('')}
    </div>`;
    container.querySelectorAll('.bk-row').forEach(row =>
      row.addEventListener('click', e => {
        if (e.target.classList.contains('bk-del')) return;
        const slug = row.dataset.slug; const date = row.dataset.date;
        if (!slug || !date) return;
        const artist = state.artists.find(a => a.slug === slug) || { name: slug, slug };
        viewShow(artist, date);
      }));
    container.querySelectorAll('.bk-del').forEach(btn =>
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const all = store.getAttended();
        all.splice(+btn.dataset.idx, 1);
        localStorage.setItem('db-attended', JSON.stringify(all));
        renderAttendedTab();
      }));
  }

  $('contentInner').innerHTML = `
    <div class="section-header">
      <div><div class="section-title">Bookmarks</div></div>
    </div>
    <div class="bk-tabs">
      <button class="bk-tab${activeTab === 'bookmarks' ? ' active' : ''}" data-t="bookmarks">🔖 Moments <span class="bk-count">${bks.length}</span></button>
      <button class="bk-tab${activeTab === 'attended'  ? ' active' : ''}" data-t="attended">📍 I Was There <span class="bk-count">${attended.length}</span></button>
    </div>
    <div id="bkTabContent"></div>`;

  if (activeTab === 'bookmarks') renderBookmarksTab();
  else renderAttendedTab();

  $('contentInner').querySelectorAll('.bk-tab').forEach(tab =>
    tab.addEventListener('click', () => viewBookmarks(tab.dataset.t)));
}

/* ── Stats ─────────────────────────────────────── */
/* ── Stats helpers ─────────────────────────────── */
function buildHeatmap(hist) {
  const dayCounts = {};
  hist.forEach(h => {
    if (!h.playedAt) return;
    const key = new Date(h.playedAt).toISOString().slice(0, 10);
    dayCounts[key] = (dayCounts[key] || 0) + 1;
  });

  const today = new Date();
  today.setHours(23, 59, 59, 999);
  // Start on the Sunday that begins week 0 (52 weeks ago)
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - startDate.getDay() - 51 * 7);
  startDate.setHours(0, 0, 0, 0);

  const cells = [];
  const monthLabels = []; // [{label, weekIdx}]
  let currentMonth = -1;

  for (let week = 0; week < 52; week++) {
    const weekStart = new Date(startDate);
    weekStart.setDate(startDate.getDate() + week * 7);
    const m = weekStart.getMonth();
    if (m !== currentMonth) {
      monthLabels.push({ label: weekStart.toLocaleDateString('en-US', { month: 'short' }), weekIdx: week });
      currentMonth = m;
    }
    for (let day = 0; day < 7; day++) {
      const d = new Date(weekStart);
      d.setDate(weekStart.getDate() + day);
      if (d > today) {
        cells.push(`<div class="hm-cell" style="opacity:0.15"></div>`);
      } else {
        const key = d.toISOString().slice(0, 10);
        const count = dayCounts[key] || 0;
        const lvl = count === 0 ? 0 : count < 3 ? 1 : count < 7 ? 2 : count < 12 ? 3 : 4;
        cells.push(`<div class="hm-cell" data-lvl="${lvl}" title="${key}: ${count} track${count !== 1 ? 's' : ''}"></div>`);
      }
    }
  }

  const cellW = 17; // 14px cell + 3px gap
  const monthRow = monthLabels.map((m, i) => {
    const nextWeek = monthLabels[i + 1]?.weekIdx ?? 52;
    const w = (nextWeek - m.weekIdx) * cellW;
    return `<span class="hm-month-label" style="width:${w}px;display:inline-block">${m.label}</span>`;
  }).join('');

  return { cells: cells.join(''), monthRow };
}

function buildTimeline(hist) {
  const now = Date.now();
  const weeklyCounts = new Array(12).fill(0);
  hist.forEach(h => {
    if (!h.playedAt) return;
    const weeksAgo = Math.floor((now - new Date(h.playedAt).getTime()) / (7 * 24 * 3600 * 1000));
    if (weeksAgo < 12) weeklyCounts[11 - weeksAgo]++;
  });
  const maxW = Math.max(1, ...weeklyCounts);
  return weeklyCounts.map((count, i) => {
    const barH = Math.max(2, Math.round((count / maxW) * 50));
    const weeksAgo = 11 - i;
    const label = weeksAgo === 0 ? 'now' : `${weeksAgo}w`;
    return `<div class="tl-col" title="${count} track${count !== 1 ? 's' : ''}">
      <div class="tl-bar" style="height:${barH}px"></div>
      <div class="tl-label">${label}</div>
    </div>`;
  }).join('');
}

function computeStreaks(hist) {
  const days = new Set(hist.map(h => {
    if (!h.playedAt) return null;
    return new Date(h.playedAt).toISOString().slice(0, 10);
  }).filter(Boolean));

  if (!days.size) return { current: 0, longest: 0, totalDays: 0, firstPlay: null };

  const sortedDays = [...days].sort();

  let current = 0;
  let d = new Date();
  d.setHours(0, 0, 0, 0);
  while (days.has(d.toISOString().slice(0, 10))) {
    current++;
    d.setDate(d.getDate() - 1);
  }
  // If today not played, check if yesterday was (streak still alive)
  if (current === 0) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);
    if (days.has(yesterday.toISOString().slice(0, 10))) {
      d = new Date(yesterday);
      while (days.has(d.toISOString().slice(0, 10))) { current++; d.setDate(d.getDate() - 1); }
    }
  }

  let longest = 1, cur = 1;
  for (let i = 1; i < sortedDays.length; i++) {
    const diff = (new Date(sortedDays[i]) - new Date(sortedDays[i - 1])) / 86400000;
    if (diff === 1) { cur++; if (cur > longest) longest = cur; } else cur = 1;
  }

  return { current, longest: Math.max(longest, current), totalDays: days.size, firstPlay: sortedDays[0] };
}

function viewStats() {
  nav.record(viewStats, []);
  setBreadcrumb([{ label: 'Stats' }]);
  const hist = store.getHistory();
  if (!hist.length) {
    $('contentInner').innerHTML = `<div class="welcome"><div class="welcome-logo" style="font-size:24px">📊</div><h2>No stats yet</h2><p>Play some shows to build your listening history.</p></div>`;
    return;
  }

  const totalTracks   = hist.length;
  const uniqueShows   = new Set(hist.map(h => `${h.artistSlug}::${h.date}`)).size;
  const uniqueArtists = new Set(hist.map(h => h.artistSlug).filter(Boolean)).size;
  const totalSecs     = hist.reduce((s, h) => s + (h.duration || 0), 0);
  const listeningDisp = totalSecs > 3600
    ? `${(totalSecs / 3600).toFixed(1)}h`
    : totalSecs > 0
      ? `${Math.round(totalSecs / 60)}m`
      : `${Math.round(totalTracks * 6 / 60)}h est.`;

  const artistCounts = {};
  const songCounts   = {};
  hist.forEach(h => {
    if (h.artistName) artistCounts[h.artistName] = (artistCounts[h.artistName] || 0) + 1;
    if (h.trackTitle && h.trackTitle !== 'Unknown') songCounts[h.trackTitle] = (songCounts[h.trackTitle] || 0) + 1;
  });
  const topArtists = Object.entries(artistCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const topSongs   = Object.entries(songCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const maxA = topArtists[0]?.[1] || 1;
  const maxS = topSongs[0]?.[1]   || 1;

  const rankRows = (entries, max, withAvatars) => entries.map(([name, count], i) => {
    const artist = withAvatars ? (state.artists.find(a => a.name === name) ?? null) : null;
    const color  = artistColor(name);
    const avatarHtml = withAvatars
      ? `<div class="stats-rank-avatar" data-name="${esc(name)}" style="background:${color}"><span>${esc(name[0]?.toUpperCase() ?? '?')}</span></div>`
      : '';
    return `
    <div class="stats-rank-row">
      ${avatarHtml}
      <div class="stats-rank-num">${i + 1}</div>
      <div class="stats-rank-name">${esc(name)}</div>
      <div class="stats-bar-wrap"><div class="stats-bar-fill" style="width:${Math.round(count/max*100)}%"></div></div>
      <div class="stats-rank-val">${count}</div>
    </div>`;
  }).join('');

  const { cells: hmCells, monthRow: hmMonthRow } = buildHeatmap(hist);
  const tlBars = buildTimeline(hist);
  const streaks = computeStreaks(hist);

  $('contentInner').innerHTML = `
    <div class="section-header">
      <div><div class="section-title">Listening Stats</div></div>
    </div>

    <div class="stats-grid">
      <div class="stat-card"><div class="stat-num">${totalTracks}</div><div class="stat-label">Tracks Played</div></div>
      <div class="stat-card"><div class="stat-num">${uniqueShows}</div><div class="stat-label">Unique Shows</div></div>
      <div class="stat-card"><div class="stat-num">${uniqueArtists}</div><div class="stat-label">Artists Heard</div></div>
      <div class="stat-card"><div class="stat-num">${listeningDisp}</div><div class="stat-label">Listening Time</div></div>
    </div>

    <div class="section-header" style="margin-top:28px;margin-bottom:8px">
      <div><div class="section-title" style="font-size:13px">Activity — Last Year</div></div>
    </div>
    <div class="stats-heatmap-outer">
      <div class="stats-heatmap-inner">
        <div class="stats-weekdays">
          <span class="stats-weekday"></span>
          <span class="stats-weekday">M</span>
          <span class="stats-weekday"></span>
          <span class="stats-weekday">W</span>
          <span class="stats-weekday"></span>
          <span class="stats-weekday">F</span>
          <span class="stats-weekday"></span>
        </div>
        <div style="flex:1;min-width:0">
          <div class="stats-heatmap-month-row">${hmMonthRow}</div>
          <div class="stats-heatmap-scroll">
            <div class="stats-heatmap">${hmCells}</div>
          </div>
        </div>
      </div>
    </div>

    <div class="section-header" style="margin-top:24px;margin-bottom:8px">
      <div><div class="section-title" style="font-size:13px">Last 12 Weeks</div></div>
    </div>
    <div class="stats-timeline-wrap">
      <div class="stats-timeline">${tlBars}</div>
    </div>

    <div class="section-header" style="margin-top:4px;margin-bottom:10px">
      <div><div class="section-title" style="font-size:13px">Streaks &amp; Milestones</div></div>
    </div>
    <div class="stats-milestones">
      <div class="milestone-card"><div class="milestone-val">${streaks.current}</div><div class="milestone-label">Current streak (days)</div></div>
      <div class="milestone-card"><div class="milestone-val">${streaks.longest}</div><div class="milestone-label">Longest streak</div></div>
      <div class="milestone-card"><div class="milestone-val">${streaks.totalDays}</div><div class="milestone-label">Active listening days</div></div>
      ${streaks.firstPlay ? `<div class="milestone-card"><div class="milestone-val" style="font-size:15px">${streaks.firstPlay}</div><div class="milestone-label">First play date</div></div>` : ''}
    </div>

    ${topArtists.length ? `
      <div class="section-header" style="margin-top:24px;margin-bottom:4px">
        <div><div class="section-title" style="font-size:13px">Top Artists</div></div>
      </div>
      <div id="statsTopArtists">${rankRows(topArtists, maxA, true)}</div>` : ''}
    ${topSongs.length ? `
      <div class="section-header" style="margin-top:24px;margin-bottom:4px">
        <div><div class="section-title" style="font-size:13px">Most Played Songs</div></div>
      </div>
      ${rankRows(topSongs, maxS, false)}` : ''}`;

  // Enrich artist avatars in stats with Wikipedia photos
  if ($('statsTopArtists')) {
    for (const el of $('statsTopArtists').querySelectorAll('[data-name]')) {
      const name = el.dataset.name;
      if (!name) continue;
      lastfmArtistImage(name).then(url => {
        if (!url || el.querySelector('img')) return;
        const img = new Image(); img.alt = name;
        img.onload = () => { el.innerHTML = ''; el.appendChild(img); el.style.background = ''; };
        img.src = url;
      });
    }
  }
}

/* ── Global search ─────────────────────────────── */
let searchDebounce = null;

searchToggleEl.addEventListener('click', () => {
  const open = searchInlineEl.style.display === 'none';
  searchInlineEl.style.display = open ? 'flex' : 'none';
  searchToggleEl.classList.toggle('active', open);
  if (open) $('searchInput').focus();
});
$('searchClose').addEventListener('click', () => {
  searchInlineEl.style.display = 'none';
  searchToggleEl.classList.remove('active');
  $('searchInput').value = '';
});
$('searchInput').addEventListener('input', e => {
  clearTimeout(searchDebounce);
  const q = e.target.value.trim();
  if (q.length < 3) return;
  searchDebounce = setTimeout(() => runSearch(q), 350);
});

async function runSearch(q, yearFrom, yearTo) {
  nav.record(runSearch, [q, yearFrom, yearTo]);
  showLoading();
  setBreadcrumb([{ label: `Search: "${q}"` }]);
  try {
    // Parallel: Relisten API search + nugs local search + song search in current artist
    const songSearchPromise = state.artist?.slug
      ? api.songs(state.artist.slug).catch(() => ({ songs: [] }))
      : Promise.resolve({ songs: [] });

    const [data, nugsResults, songData] = await Promise.all([
      api.search(q),
      searchNugsLocal(q),
      songSearchPromise,
    ]);

    let artists = data.artists ?? [];
    let shows   = data.shows   ?? [];
    const venues  = data.venues  ?? [];

    // Year filter
    if (yearFrom || yearTo) {
      const from = parseInt(yearFrom) || 0;
      const to   = parseInt(yearTo)   || 9999;
      const inRange = d => { const y = parseInt((d ?? '').slice(0, 4)); return y >= from && y <= to; };
      shows = shows.filter(s => inRange(s.display_date));
    }

    // Song results — filter current artist songs by query
    const lq = q.toLowerCase();
    const songMatches = (songData?.songs ?? [])
      .filter(s => (s.name ?? s.title ?? '').toLowerCase().includes(lq))
      .slice(0, 12);

    const total = artists.length + shows.length + venues.length + nugsResults.length + songMatches.length;

    if (!total) {
      $('contentInner').innerHTML = `<div class="error-state"><p>No results for "${esc(q)}"</p></div>`;
      return;
    }

    const renderArtistRow = a => {
      const color = artistColor(a.name);
      const init  = esc((a.name[0] ?? '?').toUpperCase());
      const imgSt = a.image_url ? `background-image:url('${esc(a.image_url)}')` : `background:${color}`;
      return `<div class="sr-row" data-type="artist" data-slug="${esc(a.slug)}">
        <div class="sr-avatar" style="${imgSt}" data-name="${esc(a.name)}">${a.image_url ? '' : `<span>${init}</span>`}</div>
        <div class="sr-info"><div class="sr-title">${esc(a.name)}</div>
          <div class="sr-sub">${a.show_count ? `${a.show_count} shows` : ''}</div></div>
      </div>`;
    };

    const renderShowRow = (s, source) => {
      const aName  = s.artist_name ?? s.artist_slug ?? '';
      const artist = state.artists.find(a => a.slug === s.artist_slug) ?? { name: aName, slug: s.artist_slug ?? '', image_url: null };
      const color  = artistColor(artist.name);
      const imgSt  = artist.image_url ? `background-image:url('${esc(artist.image_url)}')` : `background:${color}`;
      const srcTag = source === 'nugs' ? '<span class="badge" style="background:var(--accent)">nugs</span>' : '';
      return `<div class="sr-row" data-type="show" data-slug="${esc(s.artist_slug ?? '')}" data-date="${esc(s.display_date ?? '')}">
        <div class="sr-avatar" style="${imgSt}" data-name="${esc(artist.name)}">${artist.image_url ? '' : `<span>${esc((artist.name[0]??'?').toUpperCase())}</span>`}</div>
        <div class="sr-info">
          <div class="sr-title">${esc(s.display_date ?? '')}</div>
          <div class="sr-sub">${esc(artist.name)} · ${esc(s.venue?.name ?? s.venueName ?? '')}</div>
        </div>
        <div class="sr-badges">
          ${srcTag}
          ${s.has_soundboard_source ? '<span class="badge badge-sbd">SBD</span>' : ''}
          ${s.avg_rating ? `<span class="sr-rating">${stars(s.avg_rating)}</span>` : ''}
        </div>
      </div>`;
    };

    const renderSongRow = s => {
      const name   = s.name ?? s.title ?? '';
      const count  = s.show_count ?? '';
      const artist = state.artist;
      const color  = artistColor(artist?.name ?? '');
      const imgSt  = `background:${color}`;
      return `<div class="sr-row" data-type="song" data-song="${esc(name)}">
        <div class="sr-avatar" style="${imgSt}" data-name="${esc(artist?.name ?? '')}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
        </div>
        <div class="sr-info">
          <div class="sr-title">${esc(name)}</div>
          <div class="sr-sub">${esc(artist?.name ?? '')}${count ? ` · played ${count}×` : ''}</div>
        </div>
      </div>`;
    };

    const yearFilterHtml = `
      <div class="sr-year-filter">
        <span class="sr-year-label">Year range:</span>
        <input class="sr-year-input" id="srYearFrom" type="number" placeholder="From" min="1960" max="2030" value="${yearFrom ?? ''}">
        <span style="color:var(--text3)">–</span>
        <input class="sr-year-input" id="srYearTo"   type="number" placeholder="To"   min="1960" max="2030" value="${yearTo ?? ''}">
        <button class="sr-year-apply" id="srYearApply">Apply</button>
        ${(yearFrom || yearTo) ? `<button class="sr-year-clear" id="srYearClear">Clear</button>` : ''}
      </div>`;

    $('contentInner').innerHTML = `
      <div class="sr-header">
        <div class="sr-query">"${esc(q)}"</div>
        <div class="sr-count">${total} result${total !== 1 ? 's' : ''}</div>
      </div>
      ${yearFilterHtml}
      ${artists.length ? `<div class="sr-section"><div class="sr-section-title">Artists</div>${artists.slice(0,8).map(renderArtistRow).join('')}</div>` : ''}
      ${(shows.length || nugsResults.length) ? `
        <div class="sr-section">
          <div class="sr-section-title">Shows</div>
          ${shows.slice(0,15).map(s => renderShowRow(s, 'relisten')).join('')}
          ${nugsResults.slice(0,8).map(s => renderShowRow(s, 'nugs')).join('')}
        </div>` : ''}
      ${venues.length ? `
        <div class="sr-section">
          <div class="sr-section-title">Venues</div>
          ${venues.slice(0,8).map(v => `
            <div class="sr-row" data-type="venue-label">
              <div class="sr-venue-dot"></div>
              <div class="sr-info"><div class="sr-title">${esc(v.name)}</div><div class="sr-sub">${esc(v.location ?? '')}</div></div>
            </div>`).join('')}
        </div>` : ''}
      ${songMatches.length ? `
        <div class="sr-section">
          <div class="sr-section-title">Songs — ${esc(state.artist?.name ?? '')}</div>
          ${songMatches.map(renderSongRow).join('')}
        </div>` : ''}`;

    fadeIn();

    // Year filter controls
    $('srYearApply')?.addEventListener('click', () => {
      runSearch(q, $('srYearFrom')?.value || '', $('srYearTo')?.value || '');
    });
    $('srYearClear')?.addEventListener('click', () => runSearch(q));
    ['srYearFrom','srYearTo'].forEach(id => {
      $(id)?.addEventListener('keydown', e => { if (e.key === 'Enter') $('srYearApply')?.click(); });
    });

    // Wire clicks
    $('contentInner').querySelectorAll('.sr-row').forEach(row => {
      row.addEventListener('click', () => {
        if (row.dataset.type === 'artist') {
          const artist = state.artists.find(a => a.slug === row.dataset.slug);
          if (artist) { state.artist = artist; viewYears(artist); }
        } else if (row.dataset.type === 'show') {
          const artist = state.artists.find(a => a.slug === row.dataset.slug)
            ?? { name: row.dataset.slug, slug: row.dataset.slug };
          state.artist = artist;
          viewShow(artist, row.dataset.date);
        } else if (row.dataset.type === 'song' && state.artist?.slug) {
          // Navigate to artist years so user can find a show to hear the song
          viewYears(state.artist);
          showToast(`Search shows for "${row.dataset.song}"`);
        }
      });
    });

    // Enrich artist avatars with Wikipedia photos
    for (const el of $('contentInner').querySelectorAll('[data-name]')) {
      const name = el.dataset.name;
      if (!name || el.querySelector('img') || el.querySelector('svg')) continue;
      lastfmArtistImage(name).then(url => {
        if (!url || el.querySelector('img')) return;
        const img = new Image(); img.alt = name;
        img.onload = () => { el.innerHTML = ''; el.appendChild(img); el.style.backgroundImage = ''; };
        img.src = url;
      });
    }
  } catch(e) { showError(e.message); }
}

// Search nugs releases from local cache
function searchNugsLocal(q) {
  const lq = q.toLowerCase();
  const results = [];
  for (const [artistId, releases] of Object.entries(nugsReleasesCache ?? {})) {
    const artist = nugsArtistStore.get().find(a => a.id === artistId);
    for (const r of (releases ?? [])) {
      const date  = nugsIsoDate(r.performanceDate ?? '');
      const venue = [r.venueName, r.venueCity].filter(Boolean).join(' ');
      if (date.includes(lq) || venue.toLowerCase().includes(lq) || (r.setlistData ?? '').toLowerCase().includes(lq)) {
        results.push({
          display_date: date,
          artist_slug:  artist?.slug ?? artistId,
          artist_name:  artist?.name ?? '',
          venueName:    venue,
        });
      }
    }
  }
  return Promise.resolve(results);
}

/* ── Filter bar ────────────────────────────────── */
function buildFilterBar(shows, renderFn) {
  let filters = { sbd: false, r40: false, r45: false };
  let sort = 'date-desc';

  function apply() {
    let list = [...shows];
    if (filters.sbd) list = list.filter(s => s.has_soundboard_source);
    if (filters.r45) list = list.filter(s => (s.avg_rating ?? 0) >= 4.5);
    else if (filters.r40) list = list.filter(s => (s.avg_rating ?? 0) >= 4.0);
    if (sort === 'date-asc')   list.sort((a,b) => (a.display_date??'') < (b.display_date??'') ? -1 : 1);
    else if (sort === 'date-desc') list.sort((a,b) => (a.display_date??'') > (b.display_date??'') ? -1 : 1);
    else if (sort === 'rating') list.sort((a,b) => (b.avg_rating??0) - (a.avg_rating??0));
    renderFn(list);
  }

  const bar = document.createElement('div');
  bar.className = 'filter-bar';
  bar.innerHTML = `
    <button class="filter-btn" data-f="sbd">SBD Only</button>
    <button class="filter-btn" data-f="r40">★ 4.0+</button>
    <button class="filter-btn" data-f="r45">★ 4.5+</button>
    <div class="filter-sep"></div>
    <button class="filter-btn sort-btn active" data-s="date-desc">Date ↓</button>
    <button class="filter-btn sort-btn" data-s="date-asc">Date ↑</button>
    <button class="filter-btn sort-btn" data-s="rating">Rating ↓</button>`;
  bar.querySelectorAll('[data-f]').forEach(btn => btn.addEventListener('click', () => {
    const f = btn.dataset.f;
    if (f === 'r40') { filters.r40 = !filters.r40; if (filters.r40) filters.r45 = false; }
    if (f === 'r45') { filters.r45 = !filters.r45; if (filters.r45) filters.r40 = false; }
    if (f === 'sbd') filters.sbd = !filters.sbd;
    bar.querySelector('[data-f="sbd"]').classList.toggle('active', filters.sbd);
    bar.querySelector('[data-f="r40"]').classList.toggle('active', filters.r40);
    bar.querySelector('[data-f="r45"]').classList.toggle('active', filters.r45);
    apply();
  }));
  bar.querySelectorAll('.sort-btn').forEach(btn => btn.addEventListener('click', () => {
    sort = btn.dataset.s;
    bar.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    apply();
  }));
  return bar;
}

/* ── Year / show views ─────────────────────────── */
async function viewYears(artist) {
  nav.record(viewYears, [artist]);
  state.artist = artist; state.year = null; state.show = null;
  showLoading();
  setBreadcrumb([{ label: artist.name }]);
  try {
    const years  = await api.years(artist.slug);
    const sorted = [...years].sort((a, b) => b.year - a.year);
    const totalShows = sorted.reduce((n, y) => n + (y.show_count ?? 0), 0);
    const heroColor  = artistColor(artist.name);
    const artHtml    = artist.image_url
      ? `<img src="${esc(artist.image_url)}" alt="">`
      : `<span class="art-hero-init">${esc(artist.name[0]?.toUpperCase() ?? '?')}</span>`;
    const artBg = artist.image_url ? '' : `background:${heroColor}`;

    $('contentInner').innerHTML = `
      <div class="artist-hero" style="--hero-bg:${heroColor}">
        <div class="artist-hero-art" style="${artBg}">${artHtml}</div>
        <div class="artist-hero-info">
          <div class="artist-hero-label">Artist</div>
          <div class="artist-hero-name">${esc(artist.name)}</div>
          <div class="artist-hero-meta">${sorted.length} years · ${totalShows.toLocaleString()} shows</div>
          <div class="artist-hero-actions">
            <button class="action-btn primary" id="btnRandom">🎲 Random Show</button>
            <button class="action-btn" id="btnTop">⭐ Top Shows</button>
            <button class="action-btn" id="btnTours">🗺 Tours</button>
            <button class="action-btn" id="btnSongs">🎵 Songs</button>
            <button class="action-btn" id="btnVenues">📍 Venues</button>
            <button class="action-btn" id="btnEras">📅 Eras</button>
          </div>
        </div>
      </div>
      <div id="artistBioCard" class="artist-bio loading"></div>
      <div class="artist-years-wrap">
        <div class="artist-years-label">Browse by year</div>
        <div class="year-grid">
          ${sorted.map(y => `
            <div class="year-card" data-year="${esc(y.year)}">
              <div class="year-num">${esc(y.year)}</div>
              <div class="year-count">${y.show_count ?? 0} shows</div>
            </div>`).join('')}
        </div>
      </div>`;
    fadeIn();
    injectArtistBio(artist.name);
    $('contentInner').querySelectorAll('.year-card').forEach(c =>
      c.addEventListener('click', () => viewShows(artist, c.dataset.year)));
    $('btnTours').addEventListener('click',  () => viewTours(artist));
    $('btnSongs').addEventListener('click',  () => viewSongs(artist));
    $('btnVenues').addEventListener('click', () => viewVenues(artist));
    $('btnEras').addEventListener('click',   () => viewDecades(artist, years));
    $('btnRandom').addEventListener('click', async () => {
      try { showLoading(); viewShow(artist, (await api.random(artist.slug)).display_date); }
      catch(e) { showError(e.message); }
    });
    $('btnTop').addEventListener('click', async () => {
      try { showLoading(); viewShowList(artist, await api.top(artist.slug), 'Top Shows'); }
      catch(e) { showError(e.message); }
    });
  } catch(e) { showError(e.message); }
}

/* ── Decade / Era Explorer ─────────────────────── */
function viewDecades(artist, years) {
  artist._years = years; // cache for breadcrumb back-navigation
  nav.record(viewDecades, [artist, years]);
  setBreadcrumb([{ label: artist.name, fn: () => viewYears(artist) }, { label: 'Eras' }]);

  const decades = {};
  years.forEach(y => {
    const d = Math.floor(y.year / 10) * 10;
    if (!decades[d]) decades[d] = { decade: d, years: [], showCount: 0 };
    decades[d].years.push(y);
    decades[d].showCount += y.show_count ?? 0;
  });
  const sortedDecades = Object.values(decades).sort((a, b) => a.decade - b.decade);

  $('contentInner').innerHTML = `
    <div class="section-header">
      <div>
        <div class="section-title">${esc(artist.name)} — Eras</div>
        <div class="section-subtitle">${sortedDecades.length} decade${sortedDecades.length !== 1 ? 's' : ''} · ${years.length} years</div>
      </div>
    </div>
    <div class="decade-grid">
      ${sortedDecades.map(d => `
        <div class="decade-card" data-decade="${d.decade}">
          <div class="decade-name">${d.decade}s</div>
          <div class="decade-meta">${d.years.length} year${d.years.length !== 1 ? 's' : ''} · ${d.showCount} shows</div>
        </div>`).join('')}
    </div>`;

  $('contentInner').querySelectorAll('.decade-card').forEach(card => {
    const dec = sortedDecades.find(d => d.decade === parseInt(card.dataset.decade));
    if (dec) card.addEventListener('click', () => viewDecadeDetail(artist, dec));
  });
}

function viewDecadeDetail(artist, dec) {
  nav.record(viewDecadeDetail, [artist, dec]);
  setBreadcrumb([
    { label: artist.name, fn: () => viewYears(artist) },
    { label: 'Eras', fn: () => viewDecades(artist, artist._years ?? dec.years) },
    { label: `${dec.decade}s` },
  ]);
  const sorted = [...dec.years].sort((a, b) => a.year - b.year);
  $('contentInner').innerHTML = `
    <div class="section-header">
      <div>
        <div class="section-title">${esc(artist.name)} — ${dec.decade}s</div>
        <div class="section-subtitle">${sorted.length} year${sorted.length !== 1 ? 's' : ''} · ${dec.showCount} shows</div>
      </div>
    </div>
    <div class="decade-timeline-wrap">
      <div class="decade-timeline">
        ${sorted.map(y => `
          <div class="decade-year-card" data-year="${esc(y.year)}">
            <div class="decade-year-num">${esc(y.year)}</div>
            <div class="decade-year-count">${y.show_count ?? 0} shows</div>
          </div>`).join('')}
      </div>
    </div>`;
  $('contentInner').querySelectorAll('.decade-year-card').forEach(card =>
    card.addEventListener('click', () => viewShows(artist, card.dataset.year)));
}

/* ── Tour browser ──────────────────────────────── */
async function viewTours(artist) {
  nav.record(viewTours, [artist]);
  showLoading();
  setBreadcrumb([
    { label: artist.name, onClick: () => viewYears(artist) },
    { label: 'Tours' },
  ]);
  try {
    const allShows = await getAllShows(artist);
    const tourMap  = {};
    for (const show of allShows) {
      if (!show.tour?.slug) continue;
      const slug = show.tour.slug;
      if (!tourMap[slug]) tourMap[slug] = { ...show.tour, shows: [] };
      tourMap[slug].shows.push(show);
    }
    const tours = Object.values(tourMap)
      .filter(t => t.shows.length)
      .sort((a, b) => (a.shows[0]?.display_date ?? '') < (b.shows[0]?.display_date ?? '') ? -1 : 1);

    if (!tours.length) {
      $('contentInner').innerHTML = `
        <div class="section-header">
          <div><div class="section-title">Tours — ${esc(artist.name)}</div></div>
        </div>
        <div class="error-state" style="margin-top:20px"><p>No tour data available for this artist.</p></div>`;
      return;
    }

    $('contentInner').innerHTML = `
      <div class="section-header">
        <div>
          <div class="section-title">Tours — ${esc(artist.name)}</div>
          <div class="section-subtitle">${tours.length} tour${tours.length !== 1 ? 's' : ''}</div>
        </div>
      </div>
      <div class="tour-list">
        ${tours.map(tour => {
          const dates     = tour.shows.map(s => s.display_date).sort();
          const start     = dates[0]?.slice(0,4) ?? '';
          const end       = dates[dates.length-1]?.slice(0,4) ?? '';
          const dateRange = start === end ? start : `${start}–${end}`;
          return `<div class="tour-row" data-tslug="${esc(tour.slug)}">
            <div class="tour-name">${esc(tour.name || tour.slug)}</div>
            <div class="tour-dates">${esc(dateRange)}</div>
            <div class="tour-count">${tour.shows.length} show${tour.shows.length !== 1 ? 's' : ''}</div>
          </div>`;
        }).join('')}
      </div>`;
    $('contentInner').querySelectorAll('.tour-row').forEach(row => {
      row.addEventListener('click', () => {
        const tour = tours.find(t => t.slug === row.dataset.tslug);
        if (tour) viewTourShows(artist, tour);
      });
    });
  } catch(e) { showError(e.message); }
}

function viewTourShows(artist, tour) {
  nav.record(viewTourShows, [artist, tour]);
  setBreadcrumb([
    { label: artist.name, onClick: () => viewYears(artist) },
    { label: 'Tours',     onClick: () => viewTours(artist) },
    { label: tour.name || tour.slug },
  ]);
  renderShowList(tour.shows ?? [], artist, tour.name || tour.slug);
}

/* ── Song finder ───────────────────────────────── */
const allShowsCache  = {};
const songShowsCache = {};
let   scanCancelled  = false;

async function getAllShows(artist) {
  if (allShowsCache[artist.slug]) return allShowsCache[artist.slug];
  const years   = await api.years(artist.slug);
  const results = await Promise.all(
    years.map(y => api.shows(artist.slug, y.year).then(d => d.shows ?? d).catch(() => []))
  );
  allShowsCache[artist.slug] = results.flat();
  return allShowsCache[artist.slug];
}

async function viewVenues(artist) {
  nav.record(viewVenues, [artist]);
  showLoading();
  setBreadcrumb([
    { label: artist.name, onClick: () => viewYears(artist) },
    { label: 'Venues' },
  ]);
  try {
    const allShows = await getAllShows(artist);
    const venueMap = new Map();
    for (const show of allShows) {
      if (!show.venue?.name) continue;
      const key = show.venue.name;
      if (!venueMap.has(key)) venueMap.set(key, { name: show.venue.name, location: show.venue.location ?? '', count: 0 });
      venueMap.get(key).count++;
    }
    const venues = [...venueMap.values()].sort((a, b) => b.count - a.count);

    $('contentInner').innerHTML = `
      <div class="section-header">
        <div>
          <div class="section-title">Venues — ${esc(artist.name)}</div>
          <div class="section-subtitle">${venues.length} venue${venues.length !== 1 ? 's' : ''}</div>
        </div>
      </div>
      <input class="song-filter" id="venueFilter" type="text" placeholder="Filter venues…" autocomplete="off" spellcheck="false">
      <div class="venue-list" id="venueListEl"></div>`;

    function renderVenueRows(list) {
      $('venueListEl').innerHTML = list.map(v => `
        <div class="venue-row" data-name="${esc(v.name)}">
          <div class="venue-info">
            <div class="venue-name">${esc(v.name)}</div>
            ${v.location ? `<div class="venue-loc">${esc(v.location)}</div>` : ''}
          </div>
          <div class="venue-count">${v.count} show${v.count !== 1 ? 's' : ''}</div>
        </div>`).join('');
      $('venueListEl').querySelectorAll('.venue-row').forEach(row =>
        row.addEventListener('click', () => {
          const vname = row.dataset.name;
          const venueShows = allShows.filter(s => s.venue?.name === vname);
          viewShowList(artist, venueShows, `📍 ${vname}`);
        }));
    }

    renderVenueRows(venues);
    $('venueFilter').addEventListener('input', e => {
      const q = e.target.value.toLowerCase().trim();
      renderVenueRows(q ? venues.filter(v =>
        v.name.toLowerCase().includes(q) || v.location.toLowerCase().includes(q)
      ) : venues);
    });
    fadeIn();
  } catch(e) { showError(e.message); }
}

async function viewSongs(artist) {
  nav.record(viewSongs, [artist]);
  showLoading();
  setBreadcrumb([
    { label: artist.name, onClick: () => viewYears(artist) },
    { label: 'Songs' },
  ]);
  try {
    const songs      = await api.songs(artist.slug);
    const byPopular  = [...songs].sort((a, b) => (b.shows_played_at ?? 0) - (a.shows_played_at ?? 0));
    const byRare     = [...songs].sort((a, b) => (a.shows_played_at ?? 0) - (b.shows_played_at ?? 0));
    let   activeSort = 'popular';

    function rarityLabel(n) {
      if (n === 1)       return `<span class="rarity-badge rarity-once">Once</span>`;
      if (n <= 5)        return `<span class="rarity-badge rarity-rare">Rare</span>`;
      if (n <= 15)       return `<span class="rarity-badge rarity-uncommon">Uncommon</span>`;
      return '';
    }

    $('contentInner').innerHTML = `
      <div class="section-header">
        <div>
          <div class="section-title">Songs — ${esc(artist.name)}</div>
          <div class="section-subtitle">${songs.length} unique songs</div>
        </div>
        <div class="song-sort-tabs">
          <button class="song-sort-tab active" data-sort="popular">Most Played</button>
          <button class="song-sort-tab" data-sort="rare">🦄 Rarities</button>
        </div>
      </div>
      <input class="song-filter" id="songFilter" type="text" placeholder="Filter songs…" autocomplete="off" spellcheck="false">
      <div class="song-list" id="songListEl"></div>`;

    function renderSongRows(list) {
      $('songListEl').innerHTML = list.map(s => `
        <div class="song-row" data-name="${esc(s.name)}">
          <div class="song-name">${esc(s.name)}${activeSort === 'rare' ? rarityLabel(s.shows_played_at ?? 0) : ''}</div>
          <div class="song-count">${s.shows_played_at ?? '?'} shows</div>
        </div>`).join('');
      $('songListEl').querySelectorAll('.song-row').forEach(row =>
        row.addEventListener('click', () => viewSongShows(artist, row.dataset.name)));
    }

    function currentList(q) {
      const base = activeSort === 'rare' ? byRare : byPopular;
      return q ? base.filter(s => s.name.toLowerCase().includes(q)) : base;
    }

    renderSongRows(currentList(''));

    $('songFilter').addEventListener('input', e => {
      renderSongRows(currentList(e.target.value.toLowerCase().trim()));
    });

    $('contentInner').querySelectorAll('.song-sort-tab').forEach(tab =>
      tab.addEventListener('click', () => {
        activeSort = tab.dataset.sort;
        $('contentInner').querySelectorAll('.song-sort-tab').forEach(t => t.classList.toggle('active', t === tab));
        renderSongRows(currentList($('songFilter').value.toLowerCase().trim()));
      }));
  } catch(e) { showError(e.message); }
}

async function viewSongShows(artist, songName) {
  nav.record(viewSongShows, [artist, songName]);
  const cacheKey = `${artist.slug}::${songName.toLowerCase()}`;
  setBreadcrumb([
    { label: artist.name, onClick: () => viewYears(artist) },
    { label: 'Songs',     onClick: () => viewSongs(artist) },
    { label: songName },
  ]);

  if (songShowsCache[cacheKey]) {
    renderShowList(songShowsCache[cacheKey], artist, `"${songName}"`);
    return;
  }

  scanCancelled = false;

  $('contentInner').innerHTML = `
    <div class="section-header" style="align-items:center">
      <div>
        <div class="section-title">"${esc(songName)}"</div>
        <div class="section-subtitle" id="scanStatus">Fetching show list…</div>
      </div>
      <button class="action-btn" id="btnCancelScan">Cancel</button>
    </div>
    <div class="scan-bar"><div class="scan-bar-fill" id="scanFill"></div></div>
    <div class="show-list" id="songShowsEl"></div>`;

  $('btnCancelScan').addEventListener('click', () => {
    scanCancelled = true;
    if ($('scanStatus'))    $('scanStatus').textContent = 'Cancelled.';
    if ($('btnCancelScan')) $('btnCancelScan').remove();
    if ($('scanFill'))      $('scanFill').style.width = '100%';
  });

  try {
    const allShows = await getAllShows(artist);
    if (scanCancelled) return;

    const total = allShows.length;
    let scanned = 0;
    const found = [];
    const lower = songName.toLowerCase();

    const updateStatus = () => {
      if ($('scanStatus')) $('scanStatus').textContent =
        `Scanning ${scanned} / ${total} shows · ${found.length} found`;
      if ($('scanFill')) $('scanFill').style.width = `${Math.round((scanned / total) * 100)}%`;
    };

    const batchSize = 20;
    for (let i = 0; i < allShows.length; i += batchSize) {
      if (scanCancelled) break;
      await Promise.all(allShows.slice(i, i + batchSize).map(async show => {
        if (scanCancelled) return;
        try {
          const full   = await api.show(artist.slug, show.display_date);
          const tracks = (full.sources ?? []).flatMap(src => flatTracks(src));
          const match  = tracks.some(t => t.title?.toLowerCase().includes(lower));
          if (match) {
            found.push(show);
            const el = document.createElement('div');
            el.className = 'show-row';
            el.dataset.date = show.display_date;
            el.innerHTML = `
              <div class="show-date">${esc(show.display_date)}</div>
              <div class="show-venue">
                ${show.venue?.name
                  ? `<span class="venue-link" data-venue="${esc(show.venue.name)}">${esc(show.venue.name)}</span>${show.venue?.location ? ' — ' + esc(show.venue.location) : ''}`
                  : ''}
              </div>
              <div class="show-badges">
                ${show.has_soundboard_source ? '<span class="badge badge-sbd">SBD</span>' : ''}
                ${show.avg_rating ? `<span class="star">${stars(show.avg_rating)}</span>` : ''}
              </div>`;
            el.addEventListener('click', () => viewShow(artist, show.display_date));
            el.querySelectorAll('.venue-link').forEach(link =>
              link.addEventListener('click', async e => {
                e.stopPropagation();
                const vname      = link.dataset.venue;
                const venueShows = (allShowsCache[artist.slug] ?? []).filter(s => s.venue?.name === vname);
                if (venueShows.length) viewShowList(artist, venueShows, `📍 ${vname}`);
              }));
            $('songShowsEl')?.appendChild(el);
          }
        } catch { /* skip */ }
        scanned++;
      }));
      updateStatus();
    }

    if ($('scanFill'))      $('scanFill').style.width = '100%';
    if ($('btnCancelScan')) $('btnCancelScan').remove();
    if ($('scanStatus')) {
      $('scanStatus').textContent = scanCancelled
        ? `Cancelled · ${found.length} shows found`
        : `${found.length} show${found.length !== 1 ? 's' : ''} · Complete`;
    }
    if (!found.length && !scanCancelled && $('songShowsEl')) {
      $('songShowsEl').innerHTML = `<div class="error-state"><p>No shows found for "${esc(songName)}"</p></div>`;
    }
    if (!scanCancelled) songShowsCache[cacheKey] = found;

  } catch(e) { showError(e.message); }
}

async function viewShows(artist, year) {
  nav.record(viewShows, [artist, year]);
  state.year = year; state.show = null;
  showLoading();
  setBreadcrumb([
    { label: artist.name, onClick: () => viewYears(artist) },
    { label: year },
  ]);
  try {
    const data  = await api.shows(artist.slug, year);
    const shows = data.shows ?? data;
    renderShowList(shows, artist, year);
  } catch(e) { showError(e.message); }
}

function viewShowList(artist, shows, title) {
  nav.record(viewShowList, [artist, shows, title]);
  setBreadcrumb([
    { label: artist.name, onClick: () => viewYears(artist) },
    { label: title },
  ]);
  renderShowList(shows, artist, title);
}

function renderShowList(shows, artist, context) {
  $('contentInner').innerHTML = `
    <div class="section-header">
      <div>
        <div class="section-title">${esc(String(context ?? ''))}</div>
        <div class="section-subtitle" id="showCount">${shows.length} show${shows.length!==1?'s':''}</div>
      </div>
    </div>
    <div id="filterBarSlot"></div>
    <div class="show-cards" id="showListEl"></div>`;
  fadeIn();

  const effectiveArtist = artist ?? state.artist;

  function renderRows(list) {
    $('showListEl').innerHTML = list.map(s => {
      const fav      = effectiveArtist ? store.isFav(effectiveArtist.slug, s.display_date) : false;
      const myRating = effectiveArtist ? store.getRating(effectiveArtist.slug, s.display_date) : null;
      const attended = effectiveArtist ? store.isAttended(effectiveArtist.slug, s.display_date) : false;
      const artBg = effectiveArtist?.image_url ? '' : `background:${artistColor(effectiveArtist?.name ?? '')}`;
      const artContent = effectiveArtist?.image_url
        ? `<img src="${esc(effectiveArtist.image_url)}" alt="" loading="lazy">`
        : (() => {
            const parts = s.display_date?.split('-') ?? [];
            const mn = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
            const month = parts[1] ? (mn[parseInt(parts[1],10)-1] ?? '') : '';
            const day   = parts[2] ? String(parseInt(parts[2],10)) : '';
            const year  = parts[0] ?? '';
            return `<div class="typo-artist">${esc(effectiveArtist?.name ?? '')}</div>
                    <div class="typo-month">${esc(month)}</div>
                    <div class="typo-day">${esc(day)}</div>
                    <div class="typo-year">${esc(year)}</div>`;
          })();
      return `
        <div class="show-card" data-date="${esc(s.display_date)}">
          <div class="show-card-art${effectiveArtist?.image_url ? '' : ' typo'}" style="${artBg}">
            ${artContent}
            <div class="card-play">&#9654;</div>
          </div>
          <div class="show-card-body">
            <div class="show-card-date">${esc(s.display_date)}</div>
            <div class="show-card-venue">${esc(s.venue?.name ?? '')}</div>
            <div class="show-card-badges">
              ${s.has_soundboard_source ? '<span class="badge badge-sbd">SBD</span>' : ''}
              ${s.avg_rating ? `<span class="star">${stars(s.avg_rating)}</span>` : ''}
              ${myRating ? `<span class="badge badge-mine">★${myRating}</span>` : ''}
              ${attended ? '<span class="badge badge-attended">📍</span>' : ''}
              ${(s.source_count ?? 1) > 1 ? `<span class="badge badge-src">${s.source_count} src</span>` : ''}
              <button class="show-heart ${fav ? 'favorited' : ''}" data-date="${esc(s.display_date)}" title="${fav ? 'Unsave' : 'Save'}">♥</button>
            </div>
          </div>
        </div>`;
    }).join('');
    $('showCount').textContent = `${list.length} show${list.length!==1?'s':''}`;

    $('showListEl').querySelectorAll('.show-card').forEach(card =>
      card.addEventListener('click', e => {
        if (e.target.classList.contains('show-heart')) return;
        viewShow(effectiveArtist, card.dataset.date);
      }));

    $('showListEl').querySelectorAll('.show-heart').forEach(btn =>
      btn.addEventListener('click', e => {
        e.stopPropagation();
        if (!effectiveArtist) return;
        const show = shows.find(s => s.display_date === btn.dataset.date);
        if (!show) return;
        const nowFav = store.toggleFav(show, effectiveArtist);
        btn.classList.toggle('favorited', nowFav);
        btn.title = nowFav ? 'Unsave' : 'Save';
      }));

    if (effectiveArtist) {
      $('showListEl').querySelectorAll('.venue-link').forEach(link =>
        link.addEventListener('click', async e => {
          e.stopPropagation();
          const vname = link.dataset.venue;
          showLoading();
          setBreadcrumb([
            { label: effectiveArtist.name, onClick: () => viewYears(effectiveArtist) },
            { label: `📍 ${vname}` },
          ]);
          try {
            const all        = await getAllShows(effectiveArtist);
            const venueShows = all.filter(s => s.venue?.name === vname);
            if (venueShows.length) {
              viewShowList(effectiveArtist, venueShows, `📍 ${vname}`);
            } else {
              showError(`No shows found at ${vname}`);
            }
          } catch(e2) { showError(e2.message); }
        }));
    }
  }

  const bar = buildFilterBar(shows, renderRows);
  $('filterBarSlot').appendChild(bar);
  renderRows(shows);
}

async function viewShow(artist, date) {
  nav.record(viewShow, [artist, date]);
  showLoading();
  try {
    const show = await api.show(artist.slug, date);
    state.show = show;
    const year = (show.display_date || date).slice(0, 4);
    setBreadcrumb([
      { label: artist.name, onClick: () => viewYears(artist) },
      { label: year,        onClick: () => viewShows(artist, year) },
      { label: show.display_date || date },
    ]);
    renderShow(show, artist);
  } catch(e) { showError(e.message); }
}

function renderShow(show, artist) {
  const sources  = show.sources ?? [];
  const fav      = store.isFav(artist.slug, show.display_date);
  const shareUrl = `https://relisten.net/${artist.slug}/${show.display_date}`;

  const heroColor  = artistColor(artist.name);
  const artHtml = artist.image_url
    ? `<img src="${esc(artist.image_url)}" alt="${esc(artist.name)}">`
    : `<span class="art-init">${esc(artist.name[0]?.toUpperCase() ?? '?')}</span>`;

  $('contentInner').innerHTML = `
    <div class="show-header" style="--hero-bg:${heroColor}">
      <div class="show-header-wrap">
        <div class="show-art" id="relistenShowArt" style="${artist.image_url ? '' : `background:${heroColor}`}">${artHtml}</div>
        <div class="show-header-info">
          <h1>${esc(show.display_date)}</h1>
          <div class="show-venue-full">
            ${esc(show.venue?.name??'')}${show.venue?.location?' — '+esc(show.venue.location):''}
          </div>
          <div class="show-tags">
            ${show.has_soundboard_source      ?'<span class="tag tag-green">Soundboard</span>':''}
            ${show.has_streamable_flac_source ?'<span class="tag">FLAC</span>':''}
            ${show.avg_rating                 ?`<span class="tag tag-gold">${stars(show.avg_rating)}</span>`:''}
            ${show.tour_name                  ?`<span class="tag">${esc(show.tour_name)}</span>`:''}
            <span class="tag">${sources.length} recording${sources.length!==1?'s':''}</span>
          </div>
          <div class="show-personal-row">
            <div class="show-rating-stars" id="showRatingStars">
              ${[1,2,3,4,5].map(n=>`<button class="pr-star${n<=(store.getRating(artist.slug,show.display_date)??0)?' filled':''}" data-r="${n}">★</button>`).join('')}
              <span class="pr-label">${store.getRating(artist.slug,show.display_date)?'Your rating':'Rate this show'}</span>
            </div>
            <button class="action-btn attended-btn${store.isAttended(artist.slug,show.display_date)?' active':''}" id="btnAttended">
              ${store.isAttended(artist.slug,show.display_date)?'📍 I Was There':'📍 I Was There'}
            </button>
          </div>
          <div class="show-actions">
            <button class="action-btn primary" id="btnPlayAll">▶ Play Best Recording</button>
            <button class="action-btn show-heart-btn ${fav?'active':''}" id="btnFav">${fav?'♥ Saved':'♡ Save'}</button>
            <button class="action-btn" id="btnShare" title="Copy Relisten link">🔗 Share</button>
            <button class="action-btn" id="btnCompanion" title="Recording info &amp; notes">ℹ Info</button>
          </div>
        </div>
      </div>
    </div>
    <div id="sourceArea"></div>`;
  fadeIn();

  // Enrich with Last.fm artist image if Relisten doesn't have one
  if (!artist.image_url) {
    lastfmArtistImage(artist.name).then(imgUrl => {
      const artEl = $('relistenShowArt');
      if (!artEl || !imgUrl) return;
      const img = new Image();
      img.alt = artist.name;
      img.onload = () => { artEl.innerHTML = ''; artEl.appendChild(img); artEl.style.background = ''; };
      img.src = imgUrl;
    });
  }

  $('btnFav').addEventListener('click', () => {
    const nowFav = store.toggleFav(show, artist);
    $('btnFav').classList.toggle('active', nowFav);
    $('btnFav').textContent = nowFav ? '♥ Saved' : '♡ Save';
  });

  $('btnShare').addEventListener('click', () => {
    navigator.clipboard.writeText(shareUrl).then(() => showToast('Relisten link copied!'));
  });

  $('btnCompanion').addEventListener('click', () => {
    const panel = $('companionPanel');
    if (panel.classList.contains('open')) { closeCompanion(); return; }
    openCompanion(state.source ?? sources[0], { ...show, artist_slug: artist.slug });
  });

  // Personal rating stars
  function refreshStars() {
    const r = store.getRating(artist.slug, show.display_date) ?? 0;
    $('showRatingStars').querySelectorAll('.pr-star').forEach(s => s.classList.toggle('filled', +s.dataset.r <= r));
    $('showRatingStars').querySelector('.pr-label').textContent = r ? 'Your rating' : 'Rate this show';
  }
  $('showRatingStars').querySelectorAll('.pr-star').forEach(btn =>
    btn.addEventListener('click', () => {
      const prev = store.getRating(artist.slug, show.display_date);
      const val  = +btn.dataset.r;
      store.setRating(artist.slug, show.display_date, prev === val ? null : val);
      refreshStars();
    }));

  // Attended toggle
  $('btnAttended').addEventListener('click', () => {
    const now = store.toggleAttended(artist, show);
    $('btnAttended').classList.toggle('active', now);
    showToast(now ? '📍 Marked as attended!' : 'Attendance removed');
  });

  function renderSourceArea(idx) {
    const src = sources[idx]; if (!src) return;
    state.source = src;
    const tracks = flatTracks(src);

    $('sourceArea').innerHTML = `
      <div class="source-tabs">
        ${sources.map((s,i)=>`
          <div class="source-tab ${i===idx?'active':''}" data-sidx="${i}">
            ${s.is_soundboard?'🎤 Soundboard':`🎧 Audience ${i+1}`}
            ${s.avg_rating?` · ★${s.avg_rating.toFixed(1)}`:''}
          </div>`).join('')}
      </div>
      ${(src.taper_notes||src.description||src.taper||src.lineage)?`
        <div class="source-meta">
          ${src.taper       ?`<strong>Taper:</strong> ${esc(src.taper)}<br>`:''}
          ${src.lineage     ?`<strong>Lineage:</strong> ${esc(src.lineage)}<br>`:''}
          ${src.taper_notes ?`<strong>Notes:</strong> ${esc(src.taper_notes)}<br>`:''}
          ${src.description ?`<strong>Info:</strong> ${esc(src.description)}`:''}
        </div>`:''}
      <div id="trackList">
        ${(src.sets??[]).map((set,si)=>`
          ${set.name?`<div class="set-label">${esc(set.name)}</div>`
            :(src.sets?.length??0)>1?`<div class="set-label">Set ${si+1}</div>`:''}
          ${(set.tracks??[]).filter(t=>t.mp3_url).map((t,ti)=>`
            <div class="track-row" data-track-uuid="${esc(t.uuid)}" data-track-pos="${ti+1}">
              <div class="track-num">${ti+1}</div>
              <div class="track-name">${esc(t.title||'Unknown')}</div>
              <div class="track-dur">${fmt(t.duration)}</div>
              <button class="track-stats-btn" data-title="${esc(t.title||'')}" title="Show occurrences">📊</button>
              <button class="track-add-tape" data-track-uuid="${esc(t.uuid)}" title="Add to tape">📼</button>
            </div>`).join('')}
        `).join('')}
      </div>`;

    if (state.queue[state.queueIdx]) {
      const el = document.querySelector(`[data-track-uuid="${state.queue[state.queueIdx].uuid}"]`);
      if (el) { el.classList.add('playing'); el.querySelector('.track-num').textContent = '▶'; }
    }

    $('sourceArea').querySelectorAll('.source-tab').forEach(tab =>
      tab.addEventListener('click', () => {
        closeCompanion();
        renderSourceArea(parseInt(tab.dataset.sidx));
      }));

    $('sourceArea').querySelectorAll('.track-row').forEach(row =>
      row.addEventListener('click', e => {
        if (e.target.classList.contains('track-add-tape')) return;
        const track = tracks.find(t => t.uuid === row.dataset.trackUuid);
        if (track) player.playTrack(track, src);
      }));

    $('sourceArea').querySelectorAll('.track-add-tape').forEach(btn =>
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const track = tracks.find(t => t.uuid === btn.dataset.trackUuid);
        if (track) showTapePickerForTrack(track);
      }));

    $('sourceArea').querySelectorAll('.track-stats-btn').forEach(btn =>
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const title = btn.dataset.title;
        if (title) viewSongShows(artist, title);
      }));
  }

  renderSourceArea(0);
  $('btnPlayAll').addEventListener('click', () => {
    const best = sources.find(s => s.is_soundboard) ?? sources[0];
    if (best) player.playSource(best);
  });

  // Per-show notes
  const noteKey = `db-note-${artist.slug}-${show.display_date}`;
  const savedNote = localStorage.getItem(noteKey) ?? '';
  $('contentInner').insertAdjacentHTML('beforeend', `
    <div class="show-notes-section">
      <div class="show-notes-label">My Notes</div>
      <textarea class="show-notes-ta" id="showNotesTa" placeholder="Add your notes about this show…">${esc(savedNote)}</textarea>
      <div class="show-notes-hint">Auto-saved to this device · included in data export</div>
    </div>`);

  let notesDebounce = null;
  $('showNotesTa').addEventListener('input', e => {
    clearTimeout(notesDebounce);
    notesDebounce = setTimeout(() => localStorage.setItem(noteKey, e.target.value), 600);
  });
  $('showNotesTa').addEventListener('click', e => e.stopPropagation());

  // Similar Shows — load asynchronously after render
  $('contentInner').insertAdjacentHTML('beforeend', `
    <div class="similar-shows" id="similarShows">
      <div class="section-header" style="margin-top:8px">
        <div><div class="section-title" style="font-size:13px">Similar Shows</div></div>
      </div>
      <div id="similarShowsList"><div class="loading" style="height:50px;font-size:12px"><div class="spinner"></div></div></div>
    </div>`);
  loadSimilarShows(show, artist);
}

async function loadSimilarShows(show, artist) {
  const section = $('similarShows');
  const list    = $('similarShowsList');
  if (!section || !list) return;
  try {
    const allShows = await getAllShows(artist);
    const scored = allShows
      .filter(s => s.display_date !== show.display_date)
      .map(s => {
        let score = 0;
        if (s.venue?.name && s.venue.name === show.venue?.name) score += 3;
        if (s.tour?.slug  && show.tour?.slug && s.tour.slug === show.tour.slug) score += 3;
        const sy = s.display_date?.slice(0,4), cy = show.display_date?.slice(0,4);
        if (sy && cy) {
          const diff = Math.abs(parseInt(sy) - parseInt(cy));
          if (diff === 0) score += 2; else if (diff <= 2) score += 1;
        }
        if (s.avg_rating && show.avg_rating && Math.abs(s.avg_rating - show.avg_rating) <= 0.5) score += 1;
        return { show: s, score };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score || (b.show.avg_rating ?? 0) - (a.show.avg_rating ?? 0))
      .slice(0, 8)
      .map(x => x.show);

    if (!scored.length) { section.style.display = 'none'; return; }

    list.innerHTML = scored.map(s => `
      <div class="show-row" data-date="${esc(s.display_date)}" style="cursor:pointer">
        <div class="show-date">${esc(s.display_date)}</div>
        <div class="show-venue">${esc(s.venue?.name ?? '')}</div>
        <div class="show-badges">
          ${s.has_soundboard_source ? '<span class="badge badge-sbd">SBD</span>' : ''}
          ${s.avg_rating ? `<span class="star">${stars(s.avg_rating)}</span>` : ''}
        </div>
      </div>`).join('');
    list.querySelectorAll('.show-row').forEach(row =>
      row.addEventListener('click', () => viewShow(artist, row.dataset.date)));
  } catch { section.style.display = 'none'; }
}

function renderShowCards(shows, title) {
  $('contentInner').innerHTML = `
    <div class="section-header">
      <div><div class="section-title">${esc(title)}</div><div class="section-subtitle">${shows.length} shows</div></div>
    </div>
    <div class="show-cards" id="showCardsGrid"></div>`;

  $('showCardsGrid').innerHTML = shows.map(s => {
    const artist = state.artists.find(a => a.slug === s.artist_slug) ?? { name: s.artist_name ?? s.artist_slug ?? '', slug: s.artist_slug ?? '' };
    const artStyle = artist.image_url
      ? `background-image:url('${esc(artist.image_url)}');background-color:${artistColor(artist.name)}`
      : `background-color:${artistColor(artist.name)}`;
    const artInner = artist.image_url
      ? `<img src="${esc(artist.image_url)}" alt="" loading="lazy">`
      : `<span class="art-init">${esc(artist.name[0]?.toUpperCase() ?? '?')}</span>`;
    return `
      <div class="show-card" data-slug="${esc(s.artist_slug ?? '')}" data-date="${esc(s.display_date)}">
        <div class="show-card-art" style="${artStyle}">${artInner}<span class="card-play">▶</span></div>
        <div class="show-card-body">
          <div class="show-card-artist">${esc(artist.name)}</div>
          <div class="show-card-date">${esc(s.display_date)}</div>
          <div class="show-card-venue">${esc(s.venue?.name ?? '')}</div>
          <div class="show-card-badges">
            ${s.has_soundboard_source ? '<span class="badge badge-sbd">SBD</span>' : ''}
            ${s.avg_rating ? `<span class="star">${stars(s.avg_rating)}</span>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');

  $('showCardsGrid').querySelectorAll('.show-card').forEach(card =>
    card.addEventListener('click', () => {
      const artist = state.artists.find(a => a.slug === card.dataset.slug)
        ?? { name: card.dataset.slug, slug: card.dataset.slug };
      state.artist = artist;
      viewShow(artist, card.dataset.date);
    }));
}

async function viewTrending() {
  nav.record(viewTrending, []);
  showLoading(); setBreadcrumb([{ label: 'Trending Shows' }]);
  try {
    const data  = await api.trending();
    const shows = data.shows ?? data;
    renderShowCards(shows, '🔥 Trending Shows');
  } catch(e) { showError(e.message); }
}

async function viewRecent() {
  nav.record(viewRecent, []);
  showLoading(); setBreadcrumb([{ label: 'Recently Added' }]);
  try {
    const data = await api.recent();
    renderShowList(data.shows ?? data, null, '🆕 Recently Added');
  } catch(e) { showError(e.message); }
}

/* ── Tapes (playlists) views ───────────────────── */
function viewTapes() {
  nav.record(viewTapes, []);
  setBreadcrumb([{ label: 'Tapes' }]);
  const allTapes = tapes.getAll();
  if (!allTapes.length) {
    $('contentInner').innerHTML = `
      <div class="welcome">
        <div class="welcome-logo" style="font-size:24px">📼</div>
        <h2>No tapes yet</h2>
        <p>Create cross-show, cross-artist playlists by clicking 📼 on any track.</p>
        <button class="action-btn primary" id="btnNewTape">+ New Tape</button>
      </div>`;
    $('btnNewTape').addEventListener('click', () => {
      const name = prompt('Tape name:');
      if (!name?.trim()) return;
      tapes.create(name.trim());
      viewTapes();
    });
    return;
  }
  $('contentInner').innerHTML = `
    <div class="section-header">
      <div><div class="section-title">Tapes</div><div class="section-subtitle">${allTapes.length} tape${allTapes.length!==1?'s':''}</div></div>
      <button class="action-btn" id="btnNewTape">+ New Tape</button>
    </div>
    <div class="tape-list">
      ${allTapes.map(t => `
        <div class="tape-row" data-tid="${esc(t.id)}">
          <div class="tape-icon">📼</div>
          <div class="tape-name">${esc(t.name)}</div>
          <div class="tape-meta">${t.tracks.length} track${t.tracks.length!==1?'s':''}</div>
          <button class="tape-del" data-tid="${esc(t.id)}" title="Delete tape">🗑</button>
        </div>`).join('')}
    </div>`;
  $('btnNewTape').addEventListener('click', () => {
    const name = prompt('Tape name:');
    if (!name?.trim()) return;
    tapes.create(name.trim());
    viewTapes();
  });
  $('contentInner').querySelectorAll('.tape-row').forEach(row =>
    row.addEventListener('click', e => {
      if (e.target.classList.contains('tape-del')) return;
      const tape = tapes.getAll().find(t => t.id === row.dataset.tid);
      if (tape) viewTapeDetail(tape);
    }));
  $('contentInner').querySelectorAll('.tape-del').forEach(btn =>
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const tape = tapes.getAll().find(t => t.id === btn.dataset.tid);
      if (tape && confirm(`Delete tape "${tape.name}"?`)) { tapes.delete(btn.dataset.tid); viewTapes(); }
    }));
}

function viewTapeDetail(tape) {
  nav.record(viewTapeDetail, [tape]);
  const fresh = tapes.getAll().find(t => t.id === tape.id);
  if (!fresh) { viewTapes(); return; }
  setBreadcrumb([
    { label: 'Tapes', onClick: () => viewTapes() },
    { label: fresh.name },
  ]);
  if (!fresh.tracks.length) {
    $('contentInner').innerHTML = `
      <div class="section-header">
        <div><div class="section-title">${esc(fresh.name)}</div><div class="section-subtitle">Empty tape</div></div>
        <button class="action-btn" disabled>▶ Play</button>
      </div>
      <div class="welcome" style="padding-top:20px">
        <p style="font-size:13px;color:var(--text3)">Add tracks from any show by clicking 📼 on a track row.</p>
      </div>`;
    return;
  }
  $('contentInner').innerHTML = `
    <div class="section-header">
      <div><div class="section-title">${esc(fresh.name)}</div><div class="section-subtitle">${fresh.tracks.length} track${fresh.tracks.length!==1?'s':''}</div></div>
      <button class="action-btn primary" id="btnPlayTape">▶ Play Tape</button>
    </div>
    <div id="tapeTrackList">
      ${fresh.tracks.map((t, i) => `
        <div class="tape-track-row" data-uuid="${esc(t.uuid)}">
          <div class="tape-track-num">${i + 1}</div>
          <div class="tape-track-name">${esc(t.title || 'Unknown')}</div>
          <div class="tape-track-dur">${fmt(t.duration)}</div>
          <button class="tape-track-del" data-uuid="${esc(t.uuid)}" title="Remove">✕</button>
        </div>`).join('')}
    </div>`;

  $('btnPlayTape').addEventListener('click', () => {
    player.playTape(fresh);
    showToast(`Playing: ${fresh.name}`);
  });

  $('contentInner').querySelectorAll('.tape-track-del').forEach(btn =>
    btn.addEventListener('click', () => {
      tapes.removeTrack(fresh.id, btn.dataset.uuid);
      viewTapeDetail(fresh);
    }));

  $('contentInner').querySelectorAll('.tape-track-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.classList.contains('tape-track-del')) return;
      const idx = fresh.tracks.findIndex(t => t.uuid === row.dataset.uuid);
      if (idx < 0) return;
      state.originalQueue = [...fresh.tracks];
      state.queue    = state.shuffleOn ? shuffle([...fresh.tracks]) : [...fresh.tracks];
      state.queueIdx = idx;
      player.load(fresh.tracks[idx], state.artist, state.show);
      preloadNext();
    });
  });
}

/* ── Settings ──────────────────────────────────── */
function viewSettings() {
  nav.record(viewSettings, []);
  setBreadcrumb([{ label: 'Settings' }]);
  const s = settings.get();
  $('contentInner').innerHTML = `
    <div class="section-header">
      <div><div class="section-title">Settings</div></div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">Appearance</div>
      <div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:12px">
        <div class="settings-row-label">Theme</div>
        <div class="theme-swatches" id="themeSwatches">
          ${[
            { id: 'dark',     label: 'Dark',     colors: ['#0d0f14','#12151e','#e94560'] },
            { id: 'cinema',   label: 'Cinema',   colors: ['#050608','#0a0c12','#e94560'] },
            { id: 'midnight', label: 'Midnight', colors: ['#080c18','#0d1326','#4a9eff'] },
            { id: 'dusk',     label: 'Dusk',     colors: ['#0c0814','#120e1e','#a855f7'] },
            { id: 'slate',    label: 'Slate',    colors: ['#0a0d11','#0f1318','#38bdf8'] },
            { id: 'amber',    label: 'Amber',    colors: ['#100a02','#1c1205','#f5a623'] },
            { id: 'forest',   label: 'Forest',   colors: ['#030d07','#071510','#3ddc84'] },
            { id: 'light',    label: 'Light',    colors: ['#f0f2f5','#ffffff','#e94560'] },
          ].map(t => `
            <div class="theme-swatch-wrap">
              <div class="theme-swatch ${(s.theme ?? 'dark') === t.id ? 'active' : ''}" data-theme="${t.id}"
                style="background:${t.colors[0]}">
                <div style="width:100%;height:60%;background:${t.colors[1]}"></div>
                <div style="width:40%;height:40%;background:${t.colors[2]};border-radius:50%;position:absolute;bottom:6px;right:6px"></div>
              </div>
              <div class="theme-swatch-label">${t.label}</div>
            </div>`).join('')}
        </div>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">Playback</div>
      <div class="settings-row">
        <div class="settings-row-label">
          Desktop Notifications
          <div class="settings-row-sub">Show a notification when a new track starts</div>
        </div>
        <label class="toggle">
          <input type="checkbox" id="toggleNotifications" ${s.notifications ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">Last.fm</div>
      ${lfm.session ? `
      <div class="settings-row">
        <div class="settings-row-label">
          Connected
          <div class="settings-row-sub">Scrobbling as ${esc(lfm.session.name)}</div>
        </div>
        <button class="action-btn" id="btnLfmDisconnect" style="color:#e05252">Disconnect</button>
      </div>` : localStorage.getItem('lfm_pending_token') ? `
      <div class="settings-row">
        <div class="settings-row-label">
          Waiting for authorization
          <div class="settings-row-sub">Authorize Days Between on Last.fm, then click Connect</div>
        </div>
        <button class="action-btn primary" id="btnLfmConnect">Connect</button>
      </div>` : `
      <div class="settings-row">
        <div class="settings-row-label">
          Scrobble your listening history
          <div class="settings-row-sub">Opens Last.fm in your browser to authorize</div>
        </div>
        <button class="action-btn primary" id="btnLfmConnect">Connect Last.fm</button>
      </div>`}
    </div>

    <div class="settings-section" id="nugsSettingsSection">
      <div class="settings-section-title">Nugs.net</div>
      ${nugsAuth.isValid() ? (() => {
        const a = nugsAuth.get();
        const savedArtists = nugsArtistStore.get();
        return `
        <div class="settings-row">
          <div class="settings-row-label">
            Signed in
            <div class="settings-row-sub">Subscription active · ${esc(a?.plan_id ?? '')}</div>
          </div>
          <button class="action-btn" id="btnNugsSignOut" style="color:#e05252">Sign Out</button>
        </div>
        <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:8px;padding-top:4px">
          <div class="settings-row-label">My Artists
            <div class="settings-row-sub">Search for artists to add to your sidebar</div>
          </div>
          <div style="display:flex;gap:6px">
            <input type="text" id="nugsArtistSearch" class="settings-input" placeholder="Search artist name…" style="flex:1">
            <button class="action-btn primary" id="btnNugsArtistSearch">Search</button>
          </div>
          <div id="nugsArtistResults" style="display:none;flex-direction:column;gap:4px;max-height:160px;overflow-y:auto"></div>
          ${savedArtists.length ? `
            <div style="margin-top:4px">
              ${savedArtists.map(a => `
                <div class="settings-row" style="padding:4px 0;border:none">
                  <div class="settings-row-label" style="font-size:13px">${esc(a.name)}</div>
                  <button class="action-btn nugs-remove-artist" data-id="${esc(a.id)}" style="color:#e05252;font-size:11px;padding:2px 8px">Remove</button>
                </div>`).join('')}
            </div>` : ''}
        </div>`;
      })() : `
        <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:8px">
          <div class="settings-row-label">Sign in to stream nugs.net concerts</div>
          <input type="email" id="nugsEmail" class="settings-input" placeholder="nugs.net email" autocomplete="off" spellcheck="false">
          <input type="password" id="nugsPassword" class="settings-input" placeholder="Password" autocomplete="off">
          <button class="action-btn primary" id="btnNugsLogin">Sign In</button>
          <div id="nugsLoginError" style="color:#e05252;font-size:12px;display:none"></div>
        </div>`}
    </div>

    <div class="settings-section">
      <div class="settings-section-title">Data</div>
      <div class="settings-row">
        <div class="settings-row-label">
          Export All Data
          <div class="settings-row-sub">Download your saves, history, and tapes as JSON</div>
        </div>
        <button class="action-btn" id="btnExport">Export</button>
      </div>
      <div class="settings-row">
        <div class="settings-row-label">
          Import Data
          <div class="settings-row-sub">Restore from a previously exported JSON file</div>
        </div>
        <button class="action-btn" id="btnImport">Import</button>
        <input type="file" id="importFile" accept=".json" style="display:none">
      </div>
      <div class="settings-row">
        <div class="settings-row-label">
          Clear History
          <div class="settings-row-sub">Remove all play history (keeps saved shows and tapes)</div>
        </div>
        <button class="action-btn" id="btnClearHistory" style="color:#e05252">Clear</button>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">About</div>
      <div class="settings-row">
        <div class="settings-row-label">
          Days Between
          <div class="settings-row-sub">Powered by Relisten.net — 70,000+ live concerts</div>
        </div>
      </div>
    </div>`;

  $('themeSwatches').querySelectorAll('.theme-swatch').forEach(swatch =>
    swatch.addEventListener('click', () => {
      const theme = swatch.dataset.theme;
      applyTheme(theme);
      settings.setKey('theme', theme);
      $('themeSwatches').querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
      showToast(`Theme: ${theme}`);
    }));

  $('toggleNotifications').addEventListener('change', e => {
    settings.setKey('notifications', e.target.checked);
  });

  // Last.fm settings handlers
  if ($('btnLfmDisconnect')) {
    $('btnLfmDisconnect').addEventListener('click', () => {
      lfm.session = null; lfm.save();
      localStorage.removeItem('lfm_pending_token');
      showToast('Last.fm disconnected'); viewSettings();
    });
  }
  if ($('btnLfmConnect')) {
    $('btnLfmConnect').addEventListener('click', async () => {
      const pending = localStorage.getItem('lfm_pending_token');
      if (pending) {
        // Try to exchange token for session
        const session = await window.ipc?.lfmGetSession(pending);
        if (session?.key) {
          lfm.session = session; lfm.save();
          localStorage.removeItem('lfm_pending_token');
          showToast(`Last.fm connected as ${session.name}`); viewSettings();
        } else {
          showToast('Not authorized yet — please approve on Last.fm first');
        }
      } else {
        // Start auth flow
        const token = await window.ipc?.lfmGetToken();
        if (!token) { showToast('Last.fm: could not get token'); return; }
        localStorage.setItem('lfm_pending_token', token);
        window.ipc?.openUrl(`https://www.last.fm/api/auth/?api_key=${LFM_KEY}&token=${token}`);
        viewSettings(); // re-render to show "waiting" state
      }
    });
  }

  // Nugs.net settings handlers
  if (nugsAuth.isValid()) {
    $('btnNugsSignOut').addEventListener('click', () => {
      nugsAuth.clear();
      showToast('Signed out of nugs.net');
      renderArtists(state.filteredArtists);
      viewSettings();
    });

    // Artist search
    const searchBtn     = $('btnNugsArtistSearch');
    const searchInput   = $('nugsArtistSearch');
    const resultsEl     = $('nugsArtistResults');

    const doSearch = async () => {
      const q = searchInput.value.trim();
      if (!q) return;
      searchBtn.disabled    = true;
      searchBtn.textContent = '…';
      resultsEl.style.display = 'flex';
      resultsEl.innerHTML = '<div style="font-size:12px;color:var(--text3);padding:4px">Loading artists…</div>';
      try {
        await nugsApi.allArtists();
        const results = nugsApi.searchArtists(q);
        if (!results.length) {
          resultsEl.innerHTML = '<div style="font-size:12px;color:var(--text3);padding:4px">No artists found. Try a different name.</div>';
        } else {
          resultsEl.innerHTML = results.map(a =>
            `<div class="settings-row" style="padding:4px 0;border:none;gap:8px">
               <div class="settings-row-label" style="font-size:13px">${esc(a.name)} <span style="color:var(--text3);font-size:11px">ID ${esc(a.id)}</span></div>
               <button class="action-btn nugs-add-artist" data-id="${esc(a.id)}" data-name="${esc(a.name)}" style="font-size:11px;padding:2px 8px">+ Add</button>
             </div>`).join('');
          resultsEl.querySelectorAll('.nugs-add-artist').forEach(btn =>
            btn.addEventListener('click', () => {
              const added = nugsArtistStore.add(btn.dataset.id, btn.dataset.name);
              if (added) {
                showToast(`Added ${btn.dataset.name}`);
                renderArtists(state.filteredArtists);
                viewSettings();
              } else {
                showToast('Artist already in your list');
              }
            }));
        }
      } catch (e) {
        resultsEl.innerHTML = `<div style="font-size:12px;color:#e05252;padding:4px">${esc(e.message)}</div>`;
      }
      searchBtn.disabled    = false;
      searchBtn.textContent = 'Search';
    };

    searchBtn.addEventListener('click', doSearch);
    searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

    // Remove artist buttons
    document.querySelectorAll('.nugs-remove-artist').forEach(btn =>
      btn.addEventListener('click', () => {
        nugsArtistStore.remove(btn.dataset.id);
        delete nugsReleasesCache[btn.dataset.id];
        renderArtists(state.filteredArtists);
        viewSettings();
      }));
  } else {
    const loginBtn = $('btnNugsLogin');
    const errEl    = $('nugsLoginError');
    loginBtn.addEventListener('click', async () => {
      const email    = $('nugsEmail').value.trim();
      const password = $('nugsPassword').value;
      if (!email || !password) return;
      loginBtn.disabled    = true;
      loginBtn.textContent = 'Signing in…';
      errEl.style.display  = 'none';
      try {
        await nugsApi.login(email, password);
        showToast('Signed in to nugs.net!');
        renderArtists(state.filteredArtists);
        viewSettings();
      } catch (e) {
        const msg = e.message === 'nugs:login_failed'    ? 'Invalid email or password.'
                  : e.message === 'nugs:no_subscription' ? 'No active subscription found.'
                  : 'Sign-in failed. Check your connection.';
        errEl.textContent    = msg;
        errEl.style.display  = 'block';
        loginBtn.disabled    = false;
        loginBtn.textContent = 'Sign In';
      }
    });
    $('nugsPassword').addEventListener('keydown', e => { if (e.key === 'Enter') loginBtn.click(); });
  }

  $('btnExport').addEventListener('click', exportData);
  $('btnImport').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', e => {
    const file = e.target.files[0]; if (!file) return;
    importData(file);
    e.target.value = '';
  });
  $('btnClearHistory').addEventListener('click', () => {
    if (confirm('Clear all play history?')) {
      localStorage.removeItem('db-history');
      showToast('History cleared');
    }
  });
}

/* ── Nugs.net views ────────────────────────────── */
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Fetch a nugs image via the main-process proxy (bypasses renderer CORS restrictions).
// Returns a data: URL string, or null on failure.
async function nugsLoadImage(url) {
  if (!url) return null;
  try {
    const token = nugsAuth.get()?.access_token ?? null;
    return await window.ipc.fetchImage(url, token);
  } catch {
    return null;
  }
}

// Normalize nugs performanceDate to YYYY-MM-DD regardless of source format.
// Handles: "YYYY-MM-DD", "MM/DD/YYYY", "MM/DD/YYYY HH:MM:SS"
function nugsIsoDate(d) {
  if (!d) return '';
  const iso = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return `${us[3]}-${us[1].padStart(2,'0')}-${us[2].padStart(2,'0')}`;
  return d;
}

function applyNugsFilters(releases, { sortAsc, year, month, type }) {
  let list = releases.filter(r => {
    const d = nugsIsoDate(r.performanceDate);
    const isVideo = !!(r.videoURL || r.videoChapters || r.vodPlayerImage
      || r.containerTypeStr?.toLowerCase().includes('video'));
    if (type === 'audio' && isVideo) return false;
    if (type === 'video' && !isVideo) return false;
    if (year && !d.startsWith(year)) return false;
    if (month && !d.startsWith(`${year}-${month}`)) return false;
    return true;
  });
  list.sort((a, b) => {
    const da = nugsIsoDate(a.performanceDate), db = nugsIsoDate(b.performanceDate);
    return sortAsc ? (da > db ? 1 : -1) : (db > da ? 1 : -1);
  });
  return list;
}

function renderNugsReleaseRows(releases, artist) {
  const el = $('nugsReleaseList');
  if (!el) return;
  el.innerHTML = releases.length === 0
    ? `<div class="empty-state" style="padding:24px;color:var(--text3);text-align:center">No releases match the current filters</div>`
    : releases.map(c => {
        const isVideo = !!(c.videoURL || c.videoChapters || c.vodPlayerImage
          || c.containerTypeStr?.toLowerCase().includes('video'));
        return `<div class="show-row" data-cid="${esc(c.containerID)}">
          <div class="show-date">${esc(nugsIsoDate(c.performanceDate) || String(c.containerID))}</div>
          <div class="show-venue">${esc(c.venueName ?? '')}${c.venueCity ? ' — ' + esc(c.venueCity) : ''}</div>
          <div class="show-badges">
            ${isVideo ? `<span class="badge" title="Video release">🎬</span>` : ''}
          </div>
        </div>`;
      }).join('');
  el.querySelectorAll('.show-row').forEach(row =>
    row.addEventListener('click', () => nugsViewRelease(artist, row.dataset.cid)));
}

async function nugsViewArtist(artist) {
  nav.record(nugsViewArtist, [artist]);
  state.artist = artist;
  setBreadcrumb([{ label: artist.name }]);
  $('contentInner').innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
  try {
    if (!nugsReleasesCache[artist.id]) {
      let all = [], offset = 1, batch;
      do {
        const data = await nugsApi.catalog(artist.id, offset);
        batch = data?.Response?.containers ?? data?.response?.containers ?? [];
        all   = all.concat(batch);
        offset += 100;
      } while (batch.length === 100);
      nugsReleasesCache[artist.id] = all;
    }
    // Refresh sidebar count now that we have the release count cached
    renderArtists(state.filteredArtists);
    const allReleases = nugsReleasesCache[artist.id];

    // Build year/month map
    const byYear = {};
    allReleases.forEach(r => {
      const d = nugsIsoDate(r.performanceDate);
      const [y, m] = d.split('-');
      if (!y) return;
      if (!byYear[y]) byYear[y] = { count: 0, months: {} };
      byYear[y].count++;
      if (m) byYear[y].months[m] = (byYear[y].months[m] ?? 0) + 1;
    });
    const years = Object.keys(byYear).sort((a, b) => b - a);

    // Filter state
    const filters = { sortAsc: false, year: null, month: null, type: 'all' };

    function renderFilterBar() {
      const fc = $('nugsFilterControls');
      if (!fc) return;

      // Build year options
      const yearOpts = `<option value="">All Years</option>`
        + years.map(y => `<option value="${y}"${filters.year===y?' selected':''}>${y} (${byYear[y].count})</option>`).join('');

      // Build month options for selected year
      const monthsForYear = filters.year ? Object.keys(byYear[filters.year]?.months ?? {}).sort() : [];
      const monthOpts = `<option value="">All Months</option>`
        + monthsForYear.map(m => {
            const name = MONTH_NAMES[parseInt(m,10)-1] ?? m;
            const count = byYear[filters.year].months[m];
            return `<option value="${m}"${filters.month===m?' selected':''}>${name} (${count})</option>`;
          }).join('');

      fc.innerHTML = `
        <button class="filter-btn${!filters.sortAsc?' active':''}" id="nfSortDesc">Date ▾</button>
        <button class="filter-btn${filters.sortAsc?' active':''}"  id="nfSortAsc">Date ▴</button>
        <div class="filter-sep"></div>
        <button class="filter-btn${filters.type==='all'  ?' active':''}" id="nfTypeAll">All</button>
        <button class="filter-btn${filters.type==='audio'?' active':''}" id="nfTypeAudio">Audio</button>
        <button class="filter-btn${filters.type==='video'?' active':''}" id="nfTypeVideo">🎬 Video</button>
        <div class="filter-sep"></div>
        <select id="nfYear"  class="filter-select">${yearOpts}</select>
        <select id="nfMonth" class="filter-select"${!filters.year?' disabled':''}>${monthOpts}</select>`;

      $('nfSortDesc').addEventListener('click', () => { filters.sortAsc = false; refresh(); });
      $('nfSortAsc').addEventListener('click',  () => { filters.sortAsc = true;  refresh(); });
      $('nfTypeAll').addEventListener('click',   () => { filters.type = 'all';   refresh(); });
      $('nfTypeAudio').addEventListener('click', () => { filters.type = 'audio'; refresh(); });
      $('nfTypeVideo').addEventListener('click', () => { filters.type = 'video'; refresh(); });
      $('nfYear').addEventListener('change', e => {
        filters.year  = e.target.value || null;
        filters.month = null;
        refresh();
      });
      $('nfMonth').addEventListener('change', e => {
        filters.month = e.target.value || null;
        refresh();
      });
    }

    function refresh() {
      renderFilterBar();
      renderNugsReleaseRows(applyNugsFilters(allReleases, filters), artist);
    }

    // Use split layout: fixed top section + scrollable list
    const ci = $('contentInner');
    ci.style.overflow = 'hidden';
    ci.style.padding  = '0';
    const nugsHeroColor = artistColor(artist.name);
    ci.innerHTML = `
      <div id="nugsArtistWrap">
        <div id="nugsArtistTop">
          <div class="nugs-artist-hero" style="--hero-bg:${nugsHeroColor}">
            <div class="nugs-artist-hero-art" style="background:${nugsHeroColor}">
              <span class="art-hero-init">${esc(artist.name[0]?.toUpperCase() ?? '?')}</span>
            </div>
            <div class="nugs-artist-hero-info">
              <div class="artist-hero-label">nugs.net</div>
              <div class="artist-hero-name nugs-hero-name">${esc(artist.name)}</div>
              <div class="artist-hero-meta">${allReleases.length} releases</div>
            </div>
          </div>
          <div id="artistBioCard" class="artist-bio loading"></div>
          <div id="nugsFilterControls"></div>
        </div>
        <div class="show-list" id="nugsReleaseList"></div>
      </div>`;
    fadeIn(ci);
    injectArtistBio(artist.name);
    refresh();
  } catch (e) {
    if (e.message?.includes('nugs:')) { handleNugsAuthError(e); return; }
    $('contentInner').innerHTML = `<div class="error-state"><p>${esc(e.message)}</p></div>`;
  }
}

async function nugsViewRelease(artist, containerId) {
  nav.record(nugsViewRelease, [artist, containerId]);
  setBreadcrumb([{ label: artist.name, fn: () => nugsViewArtist(artist) }, { label: containerId }]);
  $('contentInner').innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
  try {
    const data      = await nugsApi.release(containerId);
    // catalog.container returns the container directly in data.Response (not nested in containers[])
    const container = data?.Response ?? data?.response ?? {};
    const tracks    = container.tracks ?? container.Tracks ?? [];
    const showArtUrl = container.img?.url ? `https://www.nugs.net${container.img.url}` : null;

    const displayDate = container.performanceDate ?? containerId;
    const venue       = [container.venueName, container.venueCity].filter(Boolean).join(' — ');
    setBreadcrumb([
      { label: artist.name, fn: () => nugsViewArtist(artist) },
      { label: displayDate },
    ]);

    // skuId for video: prefer svodskuID; fall back to first product skuID
    const containerSkuId = container.svodskuID && container.svodskuID !== 0
      ? String(container.svodskuID)
      : String((container.products ?? [])[0]?.skuID ?? '');
    // Detect container-level video (videoURL is the direct stream URL)
    const containerVideoUrl = container.videoURL || container.vodURL || null;
    const isVideoRelease = !!(containerVideoUrl || container.videoChapters
      || container.containerTypeStr?.toLowerCase().includes('video'));
    const normTracks = tracks.map((t, i) => {
      // Track-level video: videoProduct set, or container is a video release
      const isVideo = !!(t.videoProduct || t.mp4Product || t.videoondemandProduct);
      return {
        uuid:              `nugs-${containerId}-${t.trackID ?? i}`,
        title:             t.songTitle ?? t.title ?? `Track ${i + 1}`,
        duration:          t.totalRunningTime ?? t.duration ?? 0,  // already in seconds
        stream_url:        null,
        _nugs:             true,
        _nugs_video:       isVideo,
        _nugs_trackId:     String(t.trackID ?? ''),
        _nugs_skuId:       containerSkuId,       // kept for video (vidStreamUrl)
        _nugs_containerId: String(containerId),  // kept for video
      };
    });

    const artColor = artistColor(artist.name);
    $('contentInner').innerHTML = `
      <div class="show-header" style="--hero-bg:${artColor}">
        <div class="show-header-wrap">
          <div class="show-art" id="nugsShowArt" style="background:${artColor}">
            <span class="art-init">${esc((artist.name[0] ?? 'N').toUpperCase())}</span>
          </div>
          <div class="show-header-info">
            <h1>${esc(displayDate)}</h1>
            ${venue ? `<div class="show-venue-full">${esc(venue)}</div>` : ''}
            <div class="show-tags">
              <span class="tag tag-green">nugs.net</span>
              ${isVideoRelease ? '<span class="tag">🎬 Video</span>' : `<span class="tag">${normTracks.length} tracks</span>`}
            </div>
            <div class="show-actions">
              ${isVideoRelease
                ? `<button class="action-btn primary" id="btnNugsWatchVideo">🎬 Watch Video</button>`
                : `<button class="action-btn primary" id="btnNugsPlayAll">&#9654; Play All</button>`}
            </div>
          </div>
        </div>
      </div>
      <div id="nugsTrackList">
        ${normTracks.map((t, i) => `
          <div class="track-row" data-track-uuid="${esc(t.uuid)}" data-track-pos="${i + 1}">
            <div class="track-num">${i + 1}</div>
            <div class="track-name">${esc(t.title)}${t._nugs_video ? ' 🎬' : ''}</div>
            <div class="track-dur">${fmt(t.duration)}</div>
          </div>`).join('')}
      </div>`;
    fadeIn();

    const playShow = { display_date: displayDate, venue: { name: venue }, _nugs: true, _art: showArtUrl };

    // Load artist image from Last.fm (nugs show art requires web session cookies we don't have)
    lastfmArtistImage(artist.name).then(imgUrl => {
      const artEl = $('nugsShowArt');
      if (!artEl || !imgUrl) return;
      const img = new Image();
      img.alt = '';
      img.onload = () => { artEl.innerHTML = ''; artEl.appendChild(img); artEl.style.background = ''; playShow._artData = imgUrl; };
      img.src = imgUrl;
    });

    $('nugsTrackList').querySelectorAll('.track-row').forEach(row =>
      row.addEventListener('click', () => {
        const track = normTracks.find(t => t.uuid === row.dataset.trackUuid);
        if (!track) return;
        const audioTracks = normTracks.filter(t => !t._nugs_video);
        if (!track._nugs_video && audioTracks.length) {
          const startIdx = audioTracks.indexOf(track);
          state.originalQueue = audioTracks;
          state.queue    = state.shuffleOn ? [track, ...shuffle(audioTracks.filter(t => t !== track))] : audioTracks;
          state.queueIdx = state.shuffleOn ? 0 : startIdx;
          state.artist   = artist;
          state.show     = playShow;
        }
        nugsResolveAndPlay(track, artist, playShow);
      }));

    if (isVideoRelease) {
      $('btnNugsWatchVideo')?.addEventListener('click', async () => {
        const videoTrack = {
          uuid:              `nugs-vid-${containerId}`,
          title:             container.videoTitle || displayDate,
          duration:          0,
          stream_url:        containerVideoUrl || null,
          _nugs:             true,
          _nugs_video:       true,
          _nugs_skuId:       containerSkuId,
          _nugs_containerId: String(containerId),
        };
        nugsResolveAndPlay(videoTrack, artist, playShow);
      });
    } else {
      $('btnNugsPlayAll')?.addEventListener('click', () => {
        const audioTracks = normTracks.filter(t => !t._nugs_video);
        if (!audioTracks.length) return;
        state.originalQueue = audioTracks;
        state.queue    = state.shuffleOn ? shuffle(audioTracks) : audioTracks;
        state.queueIdx = 0;
        state.artist   = artist;
        state.show     = playShow;
        nugsResolveAndPlay(state.queue[0], artist, playShow);
      });
    }
  } catch (e) {
    if (e.message?.includes('nugs:')) { handleNugsAuthError(e); return; }
    $('contentInner').innerHTML = `<div class="error-state"><p>${esc(e.message)}</p></div>`;
  }
}

function nugsViewVideo(artist, show, track) {
  nav.record(nugsViewVideo, [artist, show, track]);
  setBreadcrumb([
    { label: artist.name, fn: () => nugsViewArtist(artist) },
    { label: show?.display_date ?? 'Video' },
    { label: track.title },
  ]);
  const url = track.stream_url;
  $('contentInner').innerHTML = `
    <div class="nugs-video-wrap">
      <video id="nugsVideoEl" class="nugs-video" controls></video>
      <div class="nugs-video-meta">
        <div class="section-title" style="font-size:14px">${esc(track.title)}</div>
        <div class="section-subtitle">${esc(artist.name)} · ${esc(show?.display_date ?? '')}</div>
      </div>
      <div style="display:flex;gap:8px;margin-top:4px">
        <button class="action-btn" id="btnVideoFS">&#x26F6; Fullscreen</button>
      </div>
    </div>`;
  const vid = $('nugsVideoEl');
  if (url.includes('.m3u8') && typeof Hls !== 'undefined' && Hls.isSupported()) {
    const vidHls = new Hls({ enableWorker: false });
    vidHls.loadSource(url);
    vidHls.attachMedia(vid);
    vidHls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) showToast('Video stream error'); });
  } else {
    vid.src = url;
  }
  vid.play().catch(() => {});
  $('btnVideoFS').addEventListener('click', () => vid.requestFullscreen?.());
  document.addEventListener('fullscreenchange', () => {
    const btn = $('btnVideoFS');
    if (btn) btn.textContent = document.fullscreenElement ? '✕ Exit Fullscreen' : '⛶ Fullscreen';
  }, { once: true });
}

/* ── Export / Import ───────────────────────────── */
function exportData() {
  // Collect all show notes (keys like db-note-{slug}-{date})
  const notes = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith('db-note-')) notes[k] = localStorage.getItem(k);
  }
  const data = {
    favorites:  store.getFavs(),
    history:    store.getHistory(),
    tapes:      tapes.getAll(),
    settings:   settings.get(),
    notes,
    exportedAt: new Date().toISOString(),
    version:    2,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `days-between-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Data exported!');
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      if (data.favorites) store.saveFavs(data.favorites);
      if (data.history)   localStorage.setItem('db-history',  JSON.stringify(data.history));
      if (data.tapes)     localStorage.setItem('db-tapes',    JSON.stringify(data.tapes));
      if (data.settings)  settings.set(data.settings);
      if (data.notes)     Object.entries(data.notes).forEach(([k, v]) => localStorage.setItem(k, v));
      showToast('Data imported successfully!');
      viewSettings();
    } catch { showToast('Import failed — invalid file'); }
  };
  reader.readAsText(file);
}

/* ── Sidebar ───────────────────────────────────── */
function renderArtists(artists) {
  if (sidebarSource === 'nugs') {
    // ── Nugs tab ──
    if (!nugsAuth.isValid()) {
      $('artistList').innerHTML = `<div class="sidebar-empty-nugs">Sign in to nugs.net in Settings ⚙</div>`;
      return;
    }
    const q = $('artistSearch').value.toLowerCase().trim();
    const nugsArtists = nugsArtistStore.get()
      .filter(a => !q || a.name.toLowerCase().includes(q));
    $('artistList').innerHTML = nugsArtists.length === 0
      ? `<div class="sidebar-empty-nugs">${q ? 'No matches' : 'Add artists in Settings ⚙'}</div>`
      : nugsArtists.map(a => {
          const count = nugsReleasesCache[a.id]?.length;
          return `<div class="artist-item nugs-artist-item" data-nugs-id="${esc(a.id)}" data-nugs-slug="${esc(a.slug)}">
            <div class="artist-avatar" style="background-color:${artistColor(a.name)}">
              <span>${esc((a.name[0] ?? 'N').toUpperCase())}</span>
            </div>
            <span class="artist-name">${esc(a.name)}</span>
            ${count != null ? `<span class="artist-count">${count}</span>` : ''}
          </div>`;
        }).join('');
    setTimeout(enrichArtistAvatars, 0);
    $('artistList').querySelectorAll('.nugs-artist-item').forEach(item =>
      item.addEventListener('click', () => {
        document.querySelectorAll('.artist-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        const artist = nugsArtistStore.get().find(a => a.slug === item.dataset.nugsSlug);
        if (artist) nugsViewArtist(artist);
      }));
    return;
  }

  // ── Relisten tab ──
  const favSlugs = new Set(store.getArtistFavs());
  const sorted   = [...artists].sort((a, b) => {
    const af = favSlugs.has(a.slug), bf = favSlugs.has(b.slug);
    if (af && !bf) return -1; if (bf && !af) return 1; return 0;
  });

  $('artistList').innerHTML = sorted.map(a => {
    const isFav = favSlugs.has(a.slug);
    const avatarStyle = a.image_url
      ? `background-image:url('${esc(a.image_url)}');background-color:${artistColor(a.name)}`
      : `background-color:${artistColor(a.name)}`;
    const avatarInner = a.image_url ? '' : `<span>${esc(a.name[0]?.toUpperCase() ?? '?')}</span>`;
    return `<div class="artist-item ${isFav ? 'favorited' : ''}" data-slug="${esc(a.slug)}">
      <div class="artist-avatar" style="${avatarStyle}">${avatarInner}</div>
      <span class="artist-name">${esc(a.name)}</span>
      ${a.show_count ? `<span class="artist-count">${a.show_count}</span>` : ''}
      <button class="artist-fav-btn ${isFav ? 'active' : ''}" data-slug="${esc(a.slug)}" title="${isFav ? 'Unfavorite' : 'Favorite'}">★</button>
    </div>`;
  }).join('');

  // Lazy-load Wikipedia artist photos after rendering
  setTimeout(enrichArtistAvatars, 0);

  $('artistList').querySelectorAll('.artist-item').forEach(item =>
    item.addEventListener('click', e => {
      if (e.target.classList.contains('artist-fav-btn')) return;
      document.querySelectorAll('.artist-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelector('[data-tab="artists"]').classList.add('active');
      const artist = state.artists.find(a => a.slug === item.dataset.slug);
      if (artist) viewYears(artist);
    }));

  $('artistList').querySelectorAll('.artist-fav-btn').forEach(btn =>
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const nowFav = store.toggleArtistFav(btn.dataset.slug);
      showToast(nowFav ? 'Artist favorited' : 'Removed from favorites');
      renderArtists(state.filteredArtists);
    }));
}

$('artistSearch').addEventListener('input', e => {
  const q = e.target.value.toLowerCase().trim();
  if (sidebarSource === 'nugs') {
    renderArtists(state.filteredArtists); // nugs filtering is done inside renderArtists
    return;
  }
  state.filteredArtists = q
    ? state.artists.filter(a => a.name.toLowerCase().includes(q))
    : state.artists;
  renderArtists(state.filteredArtists);
});

document.querySelectorAll('.nav-btn').forEach(btn =>
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    $('artistSearch').value = '';
    const tab = btn.dataset.tab;
    if (tab === 'artists')  { renderArtists(state.artists); viewWelcome(); }
    if (tab === 'today')    { renderArtists([]); viewToday(); }
    if (tab === 'trending') { renderArtists([]); viewTrending(); }
    if (tab === 'saved')    { renderArtists([]); viewSaved(); }
    if (tab === 'history')   { renderArtists([]); viewHistory(); }
    if (tab === 'bookmarks') { renderArtists([]); viewBookmarks(); }
    if (tab === 'stats')     { renderArtists([]); viewStats(); }
    if (tab === 'tapes')    { renderArtists([]); viewTapes(); }
  }));

/* ── Sidebar avatar enrichment (Wikipedia) ─────── */
async function enrichArtistAvatars() {
  const items = [...$('artistList').querySelectorAll('.artist-item')];
  for (const item of items) {
    const name = item.querySelector('.artist-name')?.textContent?.trim();
    if (!name) continue;
    const cached = _wikiImgCache.get(name);
    if (cached === null) continue; // already failed
    const imgUrl = cached ?? await lastfmArtistImage(name);
    if (!imgUrl) continue;
    const av = item.querySelector('.artist-avatar');
    if (!av || av.querySelector('img')) continue; // already has image
    const img = new Image();
    img.alt = name;
    img.onload = () => { av.innerHTML = ''; av.appendChild(img); av.style.backgroundImage = ''; };
    img.src = imgUrl;
  }
}

/* ── Window controls & IPC ─────────────────────── */
document.querySelector('.btn-min').addEventListener('click',   () => window.ipc?.send('wctl', 'min'));
document.querySelector('.btn-max').addEventListener('click',   () => window.ipc?.send('wctl', 'max'));
document.querySelector('.btn-close').addEventListener('click', () => window.ipc?.send('wctl', 'close'));

$('btnBack').addEventListener('click',    () => nav.back());
$('btnFwd').addEventListener('click',     () => nav.forward());

$('btnSettings').addEventListener('click', () => {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  renderArtists([]);
  viewSettings();
});

function enterMini() {
  document.body.classList.add('mini');
  $('miniRestore').style.display = 'flex';
  window.ipc?.send('mini-mode');
}
function exitMini() {
  document.body.classList.remove('mini');
  $('miniRestore').style.display = 'none';
  window.ipc?.send('full-mode');
}

$('btnMini').addEventListener('click',    enterMini);
$('btnFullMode').addEventListener('click', exitMini);
$('btnExpand').addEventListener('click',   exitMini);

window.ipc?.on('media', cmd => {
  if (cmd === 'play-pause') player.toggle();
  if (cmd === 'next')       player.next();
  if (cmd === 'prev')       player.prev();
});

window.ipc?.onMpris(cmd => {
  if (cmd === 'playpause') { player.toggle(); window.ipc?.mprisUpdate({ status: playing ? 'Paused' : 'Playing' }); }
  if (cmd === 'play')      { if (!playing) player.toggle(); window.ipc?.mprisUpdate({ status: 'Playing' }); }
  if (cmd === 'pause')     { if (playing)  player.toggle(); window.ipc?.mprisUpdate({ status: 'Paused' }); }
  if (cmd === 'stop')      { player.toggle(); window.ipc?.mprisUpdate({ status: 'Stopped' }); }
  if (cmd === 'next')      player.next();
  if (cmd === 'previous')  player.prev();
});
window.ipc?.on('cast-status', status => {
  if (status.state === 'DISCONNECTED') {
    cast.active = false; cast.paused = false; cast.deviceName = null;
    updateCastUI(); showToast('Cast session ended');
  } else if (status.state === 'PAUSED')  { cast.paused = true;  updateCastUI(); }
  else if (status.state === 'PLAYING')   { cast.paused = false; updateCastUI(); }
});

/* ── Theme ─────────────────────────────────────── */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'dark' ? '' : theme;
}

/* ── Boot ──────────────────────────────────────── */
async function init() {
  // Apply saved theme
  applyTheme(settings.getKey('theme', 'dark'));

  // Resume last position
  const resume = (() => { try { return JSON.parse(localStorage.getItem('db-resume') || 'null'); } catch { return null; } })();
  const resumeUrl = resume?.mp3_url ?? resume?.stream_url;
  if (resumeUrl && !resume?._nugs) {
    audio.src = resumeUrl;
    audio.volume = resume.volume ?? 0.8;
    $('volumeSlider').value = Math.round((resume.volume ?? 0.8) * 100);
    $('playerTitle').textContent = resume.title || 'Unknown Track';
    $('playerSub').textContent   = `${resume.artistName ?? ''} · ${resume.showDate ?? ''}`;
    // Seek once metadata loads
    audio.addEventListener('loadedmetadata', () => {
      if (resume.currentTime > 0 && resume.currentTime < audio.duration - 2) {
        audio.currentTime = resume.currentTime;
      }
      audio.play().catch(() => {});
      playing = true;
      $('btnPlay').innerHTML = '&#9646;&#9646;';
      syncEq();
    }, { once: true });
    // Restore art if artist known
    const resumeArtist = state.artists.find(a => a.slug === resume.artistSlug);
    if (resumeArtist) setPlayerArt(resumeArtist);
  }

  // Source tab handlers
  document.querySelectorAll('.source-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.source === sidebarSource);
    btn.addEventListener('click', () => {
      sidebarSource = btn.dataset.source;
      localStorage.setItem('db-sidebar-source', sidebarSource);
      document.querySelectorAll('.source-tab').forEach(b =>
        b.classList.toggle('active', b.dataset.source === sidebarSource));
      $('artistSearch').value = '';
      renderArtists(state.filteredArtists);
    });
  });

  viewWelcome();
  $('artistList').innerHTML = `<div class="loading" style="height:80px"><div class="spinner"></div></div>`;
  try {
    state.artists         = await api.artists();
    state.filteredArtists = state.artists;
    renderArtists(state.artists);
    // Re-apply now-playing indicator after artists render
    if (resume?.artistSlug) {
      document.querySelector(`.artist-item[data-slug="${CSS.escape(resume.artistSlug)}"]`)
        ?.classList.add('now-playing');
    }
  } catch(e) {
    $('artistList').innerHTML = `<div class="error-state"><p>Failed to load artists</p></div>`;
  }

  // Nugs token refresh — check every 5 minutes, refresh if within 30 min of expiry
  setInterval(async () => {
    const auth = nugsAuth.get();
    if (!auth?.refresh_token) return;
    if (auth.expires_at - Date.now() < 30 * 60 * 1000) {
      await nugsApi.refresh();
    }
  }, 5 * 60 * 1000);
}

init();
