/* ── app.js — boot shell ────────────────────────── */
import { $, showToast }             from './utils.js';
import { state, settings, nugsAuth, nav, sidebarSource, setSidebarSource,
         loadAll, getResume, setResume } from './state.js';
import { api }                       from './api.js';
import { setLfmKey, lfm }            from './lastfm.js';
import {
  audio, playing, setPlaying, cast, setRadioMode,
  setPlayerArt, setPlayerSub, setSaveResumeState,
  syncEq, updateCastUI, player,
} from './player.js';
import { applyTheme, applyAccent, applyDensity, applyGlassTheme } from './theme.js';
import { initVideoPlayer } from './video-player.js';
import {
  viewWelcome, viewToday, viewTrending, viewRecent,
  renderArtists, navToCurrentArtist, tryRadio,
} from './views-core.js';
import {
  viewSaved, viewHistory, viewBookmarks, viewStats,
  viewTapes, viewSettings,
} from './views-user.js';
import { nugsViewVideo, viewNugsDashboard, viewNugsWelcome } from './views-nugs.js';
import { initMixlr, showMixlr, hideMixlr } from './mixlr-player.js';

/* ── LFM key — injected from main process ────────── */
window.ipc?.getLfmKey?.().then(k => { if (k) setLfmKey(k); }).catch(() => {});

/* ── saveResumeState — injected into player ─────── */
function saveResumeState() {
  const track = state.queue[state.queueIdx];
  const url   = track?.mp3_url ?? track?.stream_url;
  if (!url) return;
  setResume({
    mp3_url:     track.mp3_url    ?? null,
    stream_url:  track.stream_url ?? null,
    _nugs:       track._nugs      ?? false,
    title:       track.title || '',
    artistName:  state.artist?.name ?? '',
    artistSlug:  state.artist?.slug ?? '',
    showDate:    state.show?.display_date ?? '',
    currentTime: audio.currentTime,
    volume:      audio.volume,
  });
}
setSaveResumeState(saveResumeState);

// Persist position every 8 seconds while playing
setInterval(() => { if (playing && audio.currentTime > 0) saveResumeState(); }, 8000);

/* ── Player CustomEvent bridge ───────────────────── */
document.addEventListener('player:queue-ended',    () => tryRadio());
document.addEventListener('player:nugs-auth-error', () => renderArtists(state.filteredArtists));
document.addEventListener('player:nugs-video', e => {
  const { artist, show, track } = e.detail;
  nugsViewVideo(artist, show, track);
});
document.addEventListener('player:navigate-artist', () => navToCurrentArtist());
document.addEventListener('player:navigate-show', e => {
  const { artist, show } = e.detail ?? {};
  if (artist && show?.display_date) {
    import('./views-core.js').then(m => m.viewShow(artist, show.display_date));
  }
});
document.addEventListener('player:nav-back',    () => nav.back());
document.addEventListener('player:nav-forward', () => nav.forward());

/* ── Nav buttons ─────────────────────────────────── */
document.querySelectorAll('.nav-btn').forEach(btn =>
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    $('artistSearch').value = '';
    const tab = btn.dataset.tab;
    if (tab === 'artists')   { renderArtists(state.artists); viewWelcome(); }
    if (tab === 'today') {
      // Nugs: Live Hub   |  Relisten: On This Day
      if (sidebarSource === 'nugs') {
        import('./views-nugs.js').then(m => m.viewNugsDashboard('live'));
      } else { renderArtists([]); viewToday(); }
    }
    if (tab === 'trending') {
      // Nugs: Recent Streams   |  Relisten: Trending
      if (sidebarSource === 'nugs') {
        import('./views-nugs.js').then(m => m.viewNugsDashboard('recent'));
      } else { renderArtists([]); viewTrending(); }
    }
    if (tab === 'saved')     { renderArtists([]); viewSaved(); }
    if (tab === 'history')   { renderArtists([]); viewHistory(); }
    if (tab === 'bookmarks') { renderArtists([]); viewBookmarks(); }
    if (tab === 'stats')     { renderArtists([]); viewStats(); }
    if (tab === 'tapes')     { renderArtists([]); viewTapes(); }
  }));

/* ── Settings button — see init() for listener registration ── */

/* ── Radio button ────────────────────────────────── */
$('btnRadio').addEventListener('click', () => {
  const newMode = !$('btnRadio').classList.contains('active');
  setRadioMode(newMode);
  showToast(newMode
    ? 'Artist Radio on — will auto-play a related artist when queue ends'
    : 'Artist Radio off');
  if (newMode && !state.queue.length) tryRadio();
});

/* ── Nav back/forward ────────────────────────────── */
$('btnBack').addEventListener('click', () => nav.back());
$('btnFwd').addEventListener('click',  () => nav.forward());

/* ── Window controls ─────────────────────────────── */
document.querySelector('.btn-min').addEventListener('click',   () => window.ipc?.send('wctl', 'min'));
document.querySelector('.btn-max').addEventListener('click',   () => window.ipc?.send('wctl', 'max'));
document.querySelector('.btn-close').addEventListener('click', () => window.ipc?.send('wctl', 'close'));

function enterMini() { document.body.classList.add('mini');    $('miniRestore').style.display = 'flex'; window.ipc?.send('mini-mode'); }
function exitMini()  { document.body.classList.remove('mini'); $('miniRestore').style.display = 'none'; window.ipc?.send('full-mode'); }

$('btnMini').addEventListener('click',     enterMini);
$('btnFullMode').addEventListener('click', exitMini);
$('btnExpand').addEventListener('click',   exitMini);

/* ── Media / MPRIS / Cast IPC ───────────────────── */
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
  else if  (status.state === 'PLAYING')  { cast.paused = false; updateCastUI(); }
});

/* ── Boot ────────────────────────────────────────── */
async function init() {
  // ── Settings button — wired FIRST, before any async/network work ─────────
  // Settings must work regardless of which source tab (Relisten/Nugs/Mixlr) is
  // active. The trick: contentInner is hidden when Nugs is active, and the
  // entire content column is hidden when Mixlr is active. We always reveal
  // contentInner before calling viewSettings() so the view has a visible target.
  $('btnSettings').addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    // Ensure the main content pane is visible — source-specific panes step aside
    $('appBody')?.classList.remove('mixlr-active');
    const mi = $('mixlrPane');         if (mi) mi.style.display = 'none';
    const ci = $('contentInner');      if (ci) ci.style.display = 'block';
    const ni = $('nugsContentInner');  if (ni) ni.style.display = 'none';
    renderArtists([]);
    viewSettings();
  });

  // ── Home button ───────────────────────────────────────────────────────────
  $('btnHome').addEventListener('click', () => {
    activateSource('relisten');
    viewWelcome();
  });

  // ── Diagnostic click logger — identifies what element captures clicks ──────
  // Useful when debugging overlapping layers (Nugs/Mixlr webview, etc.)
  // Remove when the click-through issue is fully resolved.
  document.addEventListener('click', e => {
    const t = e.target;
    console.log('[CLICK]', {
      tag:   t.tagName,
      id:    t.id       || '(none)',
      cls:   (t.className && typeof t.className === 'string') ? t.className.slice(0, 60) : '(none)',
      text:  t.textContent?.trim().slice(0, 40) || '(none)',
    });
  }, { capture: true });

  // Load all IndexedDB stores into memory before touching any UI
  await loadAll();
  lfm.load();

  applyTheme(settings.getKey('theme', 'dark'));
  applyAccent(settings.getKey('accent', 'default'));
  applyDensity(settings.getKey('density', 'comfortable'));
  applyGlassTheme(settings.getKey('glassTheme', {}));
  initVideoPlayer();
  initMixlr();

  // Resume last position
  const resume = getResume();
  const resumeUrl = resume?.mp3_url ?? resume?.stream_url;
  if (resumeUrl && !resume?._nugs) {
    audio.src = resumeUrl;
    audio.volume = resume.volume ?? 0.8;
    $('volumeSlider').value = Math.round((resume.volume ?? 0.8) * 100);
    $('playerTitle').textContent = resume.title || 'Unknown Track';
    setPlayerSub({ name: resume.artistName }, { display_date: resume.showDate });
    audio.addEventListener('loadedmetadata', () => {
      if (resume.currentTime > 0 && resume.currentTime < audio.duration - 2) {
        audio.currentTime = resume.currentTime;
      }
      audio.play().catch(() => {});
      setPlaying(true);
      $('btnPlay').innerHTML = '&#9646;&#9646;';
      syncEq();
    }, { once: true });
    const resumeArtist = state.artists.find(a => a.slug === resume.artistSlug);
    if (resumeArtist) setPlayerArt(resumeArtist);
  }

  // Sidebar source tabs
  function activateSource(source) {
    try {
      setSidebarSource(source);
      document.querySelectorAll('.source-tab').forEach(b =>
        b.classList.toggle('active', b.dataset.source === source));
      const artistSearchEl = $('artistSearch');
      if (artistSearchEl) {
        artistSearchEl.value = '';
        // Update placeholder to reflect which source is active
        artistSearchEl.placeholder = source === 'nugs' ? 'Search Nugs artists…' : 'Search artists…';
      }

      const appBody          = $('appBody');
      const mixlrPane        = $('mixlrPane');
      const contentInner     = $('contentInner');
      const nugsContentInner = $('nugsContentInner');
      const isMixlr          = source === 'mixlr';
      const isNugs           = source === 'nugs';

      if (appBody)   appBody.classList.toggle('mixlr-active', isMixlr);
      if (mixlrPane) mixlrPane.style.display = isMixlr ? 'flex' : 'none';
      if (contentInner)     contentInner.style.display     = isNugs ? 'none' : '';
      if (nugsContentInner) nugsContentInner.style.display = isNugs ? ''     : 'none';

      // Sidebar header MUST stay visible at all times — enforce it here
      const sh = document.querySelector('.sidebar-header');
      if (sh) { sh.style.display = ''; sh.style.visibility = ''; sh.style.pointerEvents = ''; }

      if (isMixlr) {
        showMixlr();
        renderArtists([]);
      } else if (isNugs) {
        hideMixlr();
        viewNugsWelcome();
        renderArtists([]);
      } else {
        hideMixlr();
        if (!contentInner?.innerHTML?.trim()) viewWelcome();
        renderArtists(state.filteredArtists);
      }
    } catch (err) {
      console.error('[activateSource] error:', err);
    }
  }

  document.querySelectorAll('.source-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.source === sidebarSource);
    btn.addEventListener('click', () => activateSource(btn.dataset.source));
  });

  // Allow other modules (e.g. views-core runSearch) to switch source without a circular import
  window.addEventListener('days-between:activate-source', e => activateSource(e.detail));

  if (sidebarSource !== 'relisten') activateSource(sidebarSource);

  viewWelcome();
  $('artistList').innerHTML = `<div class="loading" style="height:80px"><div class="spinner"></div></div>`;
  try {
    state.artists         = await api.artists();
    state.filteredArtists = state.artists;
    if (sidebarSource === 'relisten') {
      renderArtists(state.artists);
      if (resume?.artistSlug) {
        document.querySelector(`.artist-item[data-slug="${CSS.escape(resume.artistSlug)}"]`)
          ?.classList.add('now-playing');
      }
    } else if (sidebarSource === 'nugs') {
      renderArtists([]);
    }
  } catch {
    $('artistList').innerHTML = `<div class="error-state"><p>Failed to load artists</p></div>`;
  }

  // Nugs sidebar shows Favorites instantly from localStorage — no boot scrape needed.
  // Artists are loaded on-demand when the user clicks a letter in the A-Z grid.

  // One-shot boot refresh — older app versions stored a synthetic
  // 10-hour `expires_at` that doesn't match the JWT's real `exp` claim, so
  // previously-signed-in users may launch with a stale `isValid()` even
  // though their refresh_token still works. Try a refresh once on boot.
  (async () => {
    const a = nugsAuth.get();
    if (a?.refresh_token && !nugsAuth.isValid()) {
      const { nugsApi } = await import('./api.js');
      await nugsApi.refresh();
    }
  })();

  // Nugs token refresh — every 5 min, refresh if within 30 min of expiry.
  // `nugsApi.refresh()` itself is responsible for clearing auth on a 4xx
  // (refresh-token rejected) and dispatching `nugs:logged-out` so the
  // Settings UI can flip to the sign-in form on its next render.
  setInterval(async () => {
    const { nugsApi } = await import('./api.js');
    const auth = nugsAuth.get();
    if (!auth?.refresh_token) return;
    if (auth.expires_at - Date.now() < 30 * 60 * 1000) await nugsApi.refresh();
  }, 5 * 60 * 1000);

  // If the refresh loop (or a 401 retry) clears auth, surface it to the user
  // and re-render Settings if it's currently the active view.
  window.addEventListener('nugs:logged-out', () => {
    showToast('Nugs session expired — please sign in again');
    if (nav.history[nav.cursor]?.fn === viewSettings) viewSettings();
  });
}

init();
