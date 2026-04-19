/* ── player.js — audio engine, player UI, overlay, queue, cast ─── */
import { $, fmt, esc, castContentType, artistColor, showToast, shuffle, safeInnerHTML } from './utils.js';
import { state, settings, store, tapes, nugsAuth } from './state.js';
import { nugsApi } from './api.js';
import { lfm } from './lastfm.js';
import { audio, preloadAudio, engine, CROSSFADE_SECS, getPrimaryElement } from './audio-engine.js';
import { initEq, setBypass, isBypassed } from './eq-engine.js';

export { audio, preloadAudio }; // re-export so existing importers (app.js) don't change

export let playing = false;
export function setPlaying(v) { playing = v; }

/* ── Cast state ──────────────────────────────────── */
export const cast = { active: false, paused: false, deviceName: null };

/* ── Radio mode ──────────────────────────────────── */
export let radioMode = false;
export function setRadioMode(v) {
  radioMode = v;
  $('btnRadio').classList.toggle('active', radioMode);
  $('btnRadio').title = radioMode ? 'Artist Radio ON — click to stop' : 'Artist Radio';
}

/* ── HLS ─────────────────────────────────────────── */
let hlsInstance = null;
function destroyHls() { if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; } }

/* ── Helpers ─────────────────────────────────────── */
export function flatTracks(src) {
  return (src.sets ?? []).flatMap(s => (s.tracks ?? []).filter(t => t.mp3_url));
}

export function syncEq() { $('eqBars')?.classList.toggle('playing', playing); }

export function preloadNext() {
  const nextIdx = state.queueIdx + 1;
  if (nextIdx < state.queue.length) {
    const next = state.queue[nextIdx];
    // Only pre-buffer direct MP3/FLAC URLs — not nugs (signed/expiring) or HLS
    const url  = (!next?._nugs && !next?.mp3_url?.includes('.m3u8'))
      ? (next?.mp3_url ?? null) : null;
    if (url && preloadAudio.src !== url) preloadAudio.src = url;
    else if (!url) preloadAudio.src = '';
  } else {
    preloadAudio.src = '';
  }
}

/* ── Player art / sub ────────────────────────────── */
export function setPlayerArt(artist, artUrl, show) {
  const el = $('playerArt');
  if (!el) return;
  const url = artUrl ?? artist?.image_url ?? artist?._wikiImg ?? null;
  if (url) {
    // Use imperative DOM to avoid inline onerror handler (stripped by safeInnerHTML)
    const img      = document.createElement('img');
    img.alt        = '';
    const fallbackBg   = artistColor(artist?.name ?? '');
    const fallbackInit = (artist?.name ?? '?')[0].toUpperCase();
    img.addEventListener('error', () => {
      el.innerHTML   = '';
      const span     = document.createElement('span');
      span.className = 'art-init';
      span.textContent = fallbackInit;
      el.appendChild(span);
      el.style.background = fallbackBg;
    });
    el.innerHTML        = '';
    el.style.background = '';
    el.appendChild(img);
    img.src = url; // assign after attaching so error event fires reliably
  } else {
    el.style.background = artistColor(artist?.name ?? '');
    const name  = esc(artist?.name ?? '');
    const date  = esc(show?.display_date ?? '');
    const venue = esc(show?.venue?.name  ?? '');
    // No external data in template — safeInnerHTML for consistency
    safeInnerHTML(el, `
      <div class="art-text-card">
        <span class="art-text-name">${name}</span>
        ${date  ? `<span class="art-text-date">${date}</span>`   : ''}
        ${venue ? `<span class="art-text-venue">${venue}</span>` : ''}
      </div>`);
  }
  if (nowPlayingOpen) syncNowPlayingContent();
}

export function setPlayerSub(artist, show) {
  const el = $('playerSub');
  if (!el) return;
  const name = esc(artist?.name ?? '');
  const date = esc(show?.display_date ?? '');
  safeInnerHTML(el, name
    ? `<span class="sub-artist clickable">${name}</span>${date ? ` · <span class="sub-date">${date}</span>` : ''}`
    : date);
}

/* ── Nugs helpers ────────────────────────────────── */
export function handleNugsAuthError(e) {
  if (e.message === 'nugs:no_subscription') {
    showToast('Nugs subscription not active — check nugs.net');
  } else if (e.message === 'nugs:unauthenticated' || e.message?.includes('401') || e.message?.includes('403')) {
    nugsAuth.clear();
    showToast('Nugs session expired — sign in again in Settings');
    document.dispatchEvent(new CustomEvent('player:nugs-auth-error'));
  } else if (e.message?.startsWith('nugs:policy:')) {
    showToast(e.message.replace('nugs:policy:', ''));
  } else {
    showToast(`Nugs error: ${e.message}`);
  }
}

export async function nugsResolveAndPlay(track, artist, show) {
  if (!track.stream_url) {
    $('playerTitle').textContent = track.title || '…';
    setPlayerSub(artist, show);
    setPlayerArt(artist, show?._artData ?? show?._art ?? artist?._wikiImg ?? null, show);
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
    // Ask app.js to open the video view — player doesn't know about views
    document.dispatchEvent(new CustomEvent('player:nugs-video', { detail: { artist, show, track } }));
  } else {
    player.load(track, artist, show);
    preloadNextNugsStream();
  }
}

export async function preloadNextNugsStream() {
  const nextIdx = state.queueIdx + 1;
  if (nextIdx >= state.queue.length) return;
  const next = state.queue[nextIdx];
  if (!next?._nugs || next.stream_url || next._nugs_video) return;
  try {
    const url = await nugsApi.streamUrl(next._nugs_trackId);
    if (url) next.stream_url = url;
  } catch { /* silent — will retry on actual play */ }
}

/* ── Player object ───────────────────────────────── */

// UI-only track update — called by both player.load() and the gapless commit path.
// Never touches audio.src; assumes the element is already playing.
function _updateTrackUI(track, artist, show) {
  playing = true;
  syncEq();
  $('btnPlay').innerHTML = '&#9646;&#9646;';
  $('playerTitle').textContent = track.title || 'Unknown Track';
  $('playerTitle').classList.add('clickable');
  setPlayerSub(artist, show);
  window.ipc?.send('player-update', { title: `${track.title} — ${artist?.name}` });
  store.pushHistory(track, artist, show);
  lfm.onTrackStart(track, artist, show);
  window.ipc?.mprisUpdate({
    status: 'Playing',
    metadata: {
      'mpris:trackid': `/tracks/${track.id ?? track.slug ?? 0}`,
      'mpris:length':  (track.duration ?? 0) * 1000000,
      'xesam:title':   track.title ?? 'Unknown',
      'xesam:artist':  [artist?.name ?? ''],
      'xesam:album':   show?.display_date ?? '',
    },
  });
  setPlayerArt(artist, show?._artData ?? show?._art ?? artist?._wikiImg ?? null, show);
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
  const activeRow = document.querySelector(`[data-track-uuid="${track.uuid}"]`);
  if (activeRow) { activeRow.classList.add('playing'); activeRow.querySelector('.track-num').textContent = '▶'; }
  document.querySelectorAll('.artist-item').forEach(el => el.classList.remove('now-playing'));
  if (artist?.slug) {
    const npSel = artist._nugs
      ? `.artist-item[data-nugs-slug="${CSS.escape(artist.slug)}"]`
      : `.artist-item[data-slug="${CSS.escape(artist.slug)}"]`;
    document.querySelector(npSel)?.classList.add('now-playing');
  }
  saveResumeStateExt();
}

export const player = {
  async load(track, artist, show) {
    if (cast.active) {
      state.artist = artist; state.show = show;
      state.playingArtist = artist; state.playingShow = show;
      $('playerTitle').textContent = track.title || 'Unknown Track';
      setPlayerSub(artist, show);
      window.ipc?.send('player-update', { title: `${track.title} — ${artist?.name}` });
      setPlayerArt(artist, show?._artData ?? show?._art ?? artist?._wikiImg ?? null, show);
      const url = track.stream_url ?? track.mp3_url;
      if (url) window.ipc?.castLoad(url, castContentType(url), track.title ?? '', '').catch(() => {});
      return;
    }
    state.artist = artist; state.show = show;
    state.playingArtist = artist; state.playingShow = show;
    const url = track?.stream_url ?? track?.mp3_url;
    if (!url) return;
    engine.cancel(); // abort any in-progress gapless crossfade

    // Initialise (or resume) the AudioContext and connect both audio elements
    // to the EQ filter chain BEFORE touching the element src/play.  This must
    // be awaited so the context is running and MediaElementSources are wired
    // up before audio starts decoding — otherwise Chromium routes audio to
    // speakers directly and then goes silent once the graph is connected.
    await initEq().catch(err => console.error('[player] initEq:', err));

    destroyHls();
    // getPrimaryElement() returns the _primary DOM element from audio-engine.js,
    // which may be either audioEl or preloadEl after a gapless swap.
    const primaryEl = getPrimaryElement();
    if (url.includes('.m3u8') && typeof Hls !== 'undefined' && Hls.isSupported()) {
      hlsInstance = new Hls({ enableWorker: false, maxBufferLength: 30, maxMaxBufferLength: 60 });
      hlsInstance.loadSource(url);
      hlsInstance.attachMedia(primaryEl); // must use actual DOM element, not proxy
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => audio.play().catch(() => {}));
      hlsInstance.on(Hls.Events.ERROR, (_, d) => {
        if (d.fatal) { destroyHls(); showToast('Stream error — try again'); }
      });
    } else {
      audio.src = url; // proxy routes to _primary (= primaryEl)
      audio.play().catch(() => {});
    }
    _updateTrackUI(track, artist, show);
    preloadNext();
    renderQueuePanel();
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
    engine.cancel(); // abort any in-progress crossfade
    if (state.queueIdx < state.queue.length - 1) {
      state.queueIdx++;
      if (cast.active) castAdvanceTrack();
      else player._playQueued(state.queueIdx);
    } else if (state.repeatMode === 'all' && state.queue.length) {
      state.queueIdx = 0;
      if (cast.active) castAdvanceTrack();
      else player._playQueued(0);
    } else {
      document.dispatchEvent(new CustomEvent('player:queue-ended'));
    }
  },

  prev() {
    engine.cancel(); // abort any in-progress crossfade
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
      state.queue    = [first, ...rest];
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

// Set queue from flat tracks array and start playing — used by views for "Play All" and radio
export function queueAndPlay(tracks, artist, show, startIdx = 0) {
  state.artist = artist;
  state.show   = show;
  player._setQueue(tracks, startIdx);
  player.load(state.queue[state.queueIdx], artist, show);
}

/* ── Save resume state ───────────────────────────── */
// Stub replaced by app.js at boot (needs access to audio.currentTime)
let saveResumeStateExt = () => {};
export function setSaveResumeState(fn) { saveResumeStateExt = fn; }

/* ── Audio event handlers ────────────────────────── */
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
    return;
  }
  if (engine.commit()) {
    // Gapless handoff — engine swapped _primary/_staging; new track is already playing
    state.queueIdx++;
    if (state.queueIdx >= state.queue.length) {
      playing = false; syncEq();
      document.dispatchEvent(new CustomEvent('player:queue-ended'));
      return;
    }
    const track = state.queue[state.queueIdx];
    _updateTrackUI(track, state.artist, state.show);
    preloadNext();
    renderQueuePanel();
  } else {
    playing = false; syncEq();
    player.next();
  }
});

/* ── Progress helpers ────────────────────────────── */
export function showProgressData() {
  const q = state.queue;
  if (q.length <= 1) return null;
  const totalDur = q.reduce((s, t) => s + (t.duration ?? 0), 0);
  if (!totalDur) return null;
  const completedDur = q.slice(0, state.queueIdx).reduce((s, t) => s + (t.duration ?? 0), 0);
  return { totalDur, completedDur };
}

function trackAtShowTime(targetTime) {
  let cum = 0;
  for (let i = 0; i < state.queue.length; i++) {
    cum += state.queue[i].duration ?? 0;
    if (cum >= targetTime) {
      return { track: state.queue[i], idx: i, offset: targetTime - (cum - (state.queue[i].duration ?? 0)) };
    }
  }
  const last = state.queue[state.queue.length - 1];
  return { track: last, idx: state.queue.length - 1, offset: last?.duration ?? 0 };
}

export function seekToShowPct(pct) {
  engine.cancel(); // abort any in-progress crossfade before seeking
  if (audio.duration) audio.currentTime = Math.max(0, Math.min(audio.duration, pct * audio.duration));
}

export function updateProgressMarkers() {
  const el = $('progressMarkers');
  if (!el) return;
  const sp = showProgressData();
  if (!sp) { el.innerHTML = ''; return; }
  let html = '', cum = 0;
  for (let i = 0; i < state.queue.length - 1; i++) {
    cum += state.queue[i].duration ?? 0;
    const pct = (cum / sp.totalDur) * 100;
    html += `<div class="progress-marker" style="left:${pct}%"></div>`;
  }
  el.innerHTML = html; // no user data — static geometry
}

function updateProgressTooltip(clientX) {
  const bar     = $('progressBar');
  const tooltip = $('progressTooltip');
  const thumb   = $('progressThumb');
  if (!bar || !tooltip) return;
  const r      = bar.getBoundingClientRect();
  const pct    = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  const pctStr = `${pct * 100}%`;
  tooltip.style.left = pctStr;
  if (thumb) thumb.style.left = pctStr;
  tooltip.textContent = fmt(pct * (audio.duration || 0));
}

audio.addEventListener('timeupdate', () => {
  if (!audio.duration) return;
  const pct = `${(audio.currentTime / audio.duration) * 100}%`;
  $('progressFill').style.width  = pct;
  $('timeCur').textContent       = fmt(audio.currentTime);
  $('timeDur').textContent       = fmt(audio.duration);
  if (!$('progressBar')?.matches(':hover') && !_scrubbing) {
    const thumb = $('progressThumb');
    if (thumb) thumb.style.left = pct;
  }
  if (nowPlayingOpen) {
    $('npoFill').style.width    = pct;
    $('npoTimeCur').textContent = fmt(audio.currentTime);
    $('npoTimeDur').textContent = fmt(audio.duration);
  }
  // Gapless trigger — arm crossfade when close to end of a direct-URL track
  const remaining = audio.duration - audio.currentTime;
  if (isFinite(remaining) && remaining > 0 && remaining <= CROSSFADE_SECS
      && state.repeatMode !== 'one') {
    const next = state.queue[state.queueIdx + 1];
    if (engine.canFire(next)) engine.arm(remaining);
  }
});

/* ── Now Playing Overlay ─────────────────────────── */
export let nowPlayingOpen = false;

export function syncNowPlayingContent() {
  const artEl   = $('playerArt');
  const artWrap = $('npoArtWrap');
  if (artWrap && artEl) artWrap.innerHTML = artEl.innerHTML;
  if (artWrap && artEl?.style.background) artWrap.style.background = artEl.style.background;

  const bg = $('npoBg');
  if (bg) {
    const img = artEl?.querySelector('img');
    if (img?.src) {
      bg.style.backgroundImage = `url(${img.src})`;
      bg.style.background      = '';
    } else {
      bg.style.backgroundImage = 'none';
      bg.style.background      = artEl?.style.background ?? 'var(--bg)';
    }
  }

  if ($('npoTitle')) $('npoTitle').textContent = $('playerTitle')?.textContent ?? '';
  if ($('npoSub'))   $('npoSub').innerHTML     = $('playerSub')?.innerHTML     ?? '';

  if (audio.duration) {
    const pct = `${(audio.currentTime / audio.duration) * 100}%`;
    if ($('npoFill'))    $('npoFill').style.width    = pct;
    if ($('npoTimeCur')) $('npoTimeCur').textContent = fmt(audio.currentTime);
    if ($('npoTimeDur')) $('npoTimeDur').textContent = fmt(audio.duration);
  }

  if ($('npoPlay')) $('npoPlay').innerHTML = playing ? '&#9646;&#9646;' : '&#9654;';
  $('npoShuffle')?.classList.toggle('active', state.shuffleOn);
  $('npoRepeat')?.classList.toggle('active', state.repeatMode !== 'off');
  if ($('npoVolume')) $('npoVolume').value = $('volumeSlider')?.value ?? '80';

  const setlistEl = $('npoSetlist');
  if (setlistEl && state.queue.length) {
    safeInnerHTML(setlistEl, state.queue.map((t, i) => {
      const active = i === state.queueIdx;
      return `<div class="npo-setlist-row ${active ? 'active' : ''}" data-idx="${i}">
        <span class="npo-setlist-num">${active ? '▶' : i + 1}</span>
        <span class="npo-setlist-title">${esc(t.title ?? 'Unknown Track')}</span>
        ${t.duration ? `<span class="npo-setlist-dur">${fmt(t.duration)}</span>` : ''}
      </div>`;
    }).join(''));
    setlistEl.querySelectorAll('.npo-setlist-row').forEach(row =>
      row.addEventListener('click', () => {
        const idx = +row.dataset.idx;
        state.queueIdx = idx;
        player._playQueued(idx);
        syncNowPlayingContent();
      }));
    const activeRow = setlistEl.querySelector('.npo-setlist-row.active');
    if (activeRow) activeRow.scrollIntoView({ block: 'nearest' });
  } else if (setlistEl) {
    setlistEl.innerHTML = '';
  }
}

export function openNowPlaying() {
  const overlay = $('nowPlayingOverlay');
  if (!overlay) return;
  syncNowPlayingContent();
  overlay.style.display = 'flex';
  nowPlayingOpen = true;
}

export function closeNowPlaying() {
  const overlay = $('nowPlayingOverlay');
  if (!overlay) return;
  overlay.style.display = 'none';
  nowPlayingOpen = false;
}

// Wire overlay controls
$('npoClose').addEventListener('click', closeNowPlaying);
$('npoSub').addEventListener('click', () => {
  closeNowPlaying();
  document.dispatchEvent(new CustomEvent('player:navigate-artist'));
});
$('nowPlayingOverlay').addEventListener('click', e => {
  if (e.target === $('nowPlayingOverlay')) closeNowPlaying();
});
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
audio.addEventListener('play',  () => { if (nowPlayingOpen && $('npoPlay')) $('npoPlay').innerHTML = '&#9646;&#9646;'; });
audio.addEventListener('pause', () => { if (nowPlayingOpen && $('npoPlay')) $('npoPlay').innerHTML = '&#9654;'; });

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
  showToast(`Bookmarked at ${fmt(pos)}`);
});

$('playerArt').addEventListener('click', openNowPlaying);

/* ── Progress bar scrubbing ──────────────────────── */
let _scrubbing = false;
let _scrubPct  = 0;

function getBarPct(clientX) {
  const r = $('progressBar').getBoundingClientRect();
  return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
}

$('progressBar').addEventListener('mousemove',  e => updateProgressTooltip(e.clientX));
$('progressBar').addEventListener('mouseleave', () => {
  if (_scrubbing) return;
  const sp  = showProgressData();
  const pct = sp
    ? `${((sp.completedDur + audio.currentTime) / sp.totalDur) * 100}%`
    : audio.duration ? `${(audio.currentTime / audio.duration) * 100}%` : '0%';
  const thumb = $('progressThumb');
  if (thumb) thumb.style.left = pct;
});
$('progressBar').addEventListener('mousedown', e => {
  e.preventDefault();
  _scrubbing = true;
  _scrubPct  = getBarPct(e.clientX);
  $('progressBar').classList.add('scrubbing');
  $('progressFill').style.width = `${_scrubPct * 100}%`;
  updateProgressTooltip(e.clientX);
});
document.addEventListener('mousemove', e => {
  if (!_scrubbing) return;
  _scrubPct = getBarPct(e.clientX);
  $('progressFill').style.width = `${_scrubPct * 100}%`;
  updateProgressTooltip(e.clientX);
});
document.addEventListener('mouseup', () => {
  if (!_scrubbing) return;
  _scrubbing = false;
  $('progressBar').classList.remove('scrubbing');
  seekToShowPct(_scrubPct);
});

$('volumeSlider').addEventListener('input', e => { audio.volume = e.target.value / 100; });
audio.volume = 0.8;

$('btnPlay').addEventListener('click', () => player.toggle());
$('btnNext').addEventListener('click', () => player.next());
$('btnPrev').addEventListener('click', () => player.prev());

// Player title click → navigate to show
$('playerTitle').addEventListener('click', () => {
  const artist = state.playingArtist;
  const show   = state.playingShow;
  if (!artist || !show) return;
  document.dispatchEvent(new CustomEvent('player:navigate-show', { detail: { artist, show } }));
});

// Artist sub line click → navigate to artist page
$('playerSub').addEventListener('click', () => {
  document.dispatchEvent(new CustomEvent('player:navigate-artist'));
});

/* ── Shuffle / Repeat / Queue controls ───────────── */
$('btnShuffle').addEventListener('click', () => {
  state.shuffleOn = !state.shuffleOn;
  $('btnShuffle').classList.toggle('active', state.shuffleOn);
  if (state.shuffleOn && state.originalQueue.length) {
    const cur  = state.queue[state.queueIdx];
    const rest = shuffle(state.originalQueue.filter(t => t.uuid !== cur?.uuid));
    state.queue    = cur ? [cur, ...rest] : rest;
    state.queueIdx = 0;
  } else if (!state.shuffleOn && state.originalQueue.length) {
    const cur      = state.queue[state.queueIdx];
    state.queue    = state.originalQueue;
    state.queueIdx = Math.max(0, state.originalQueue.findIndex(t => t.uuid === cur?.uuid));
  }
  preloadNext();
  renderQueuePanel();
});

$('btnRepeat').addEventListener('click', () => {
  const cycle    = { off: 'one', one: 'all', all: 'off' };
  state.repeatMode = cycle[state.repeatMode];
  const btn = $('btnRepeat');
  btn.classList.toggle('active', state.repeatMode !== 'off');
  btn.title    = state.repeatMode === 'off' ? 'Repeat' : state.repeatMode === 'one' ? 'Repeat One' : 'Repeat All';
  btn.textContent = state.repeatMode === 'one' ? '①' : '↺';
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

/* ── Sleep Timer ─────────────────────────────────── */
export const sleepTimer = {
  _timer:        null,
  _fadeInterval: null,
  _endAt:        0,
  _tickInterval: null,

  set(mins) {
    this.cancel();
    this._endAt       = Date.now() + mins * 60 * 1000;
    this._timer       = setTimeout(() => this._expire(), mins * 60 * 1000);
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
  const panel  = $('sleepPicker');
  const active = sleepTimer._endAt > 0;
  $('sleepCancelBtn').style.display = active ? '' : 'none';
  panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
});
$('sleepPickerClose').addEventListener('click', () => { $('sleepPicker').style.display = 'none'; });
$('sleepPicker').addEventListener('click', e => { if (e.target === $('sleepPicker')) $('sleepPicker').style.display = 'none'; });
$('sleepCancelBtn').addEventListener('click', () => { sleepTimer.cancel(); showToast('Sleep timer cancelled'); $('sleepPicker').style.display = 'none'; });
$('sleepPicker').querySelectorAll('.sleep-opt').forEach(btn =>
  btn.addEventListener('click', () => sleepTimer.set(+btn.dataset.mins)));

/* ── Concert Companion panel ─────────────────────── */
export function openCompanion(src, show) {
  const panel   = $('companionPanel');
  const body    = $('companionBody');
  const noteKey = `db-note-${show?.artist_slug ?? 'unknown'}-${show?.display_date ?? ''}`;

  const infoHtml = [
    src?.taper       ? `<div class="companion-section"><div class="companion-section-title">Taper</div><p>${esc(src.taper)}</p></div>`             : '',
    src?.lineage     ? `<div class="companion-section"><div class="companion-section-title">Lineage</div><p>${esc(src.lineage)}</p></div>`           : '',
    src?.taper_notes ? `<div class="companion-section"><div class="companion-section-title">Taper Notes</div><p>${esc(src.taper_notes)}</p></div>`  : '',
    src?.description ? `<div class="companion-section"><div class="companion-section-title">Info</div><p>${esc(src.description)}</p></div>`          : '',
    (!src?.taper && !src?.lineage && !src?.taper_notes && !src?.description)
      ? `<div class="companion-section"><p style="color:var(--text3)">No recording info available for this source.</p></div>` : '',
  ].join('');

  // Set textarea value via property — never via innerHTML — to avoid injection risk
  safeInnerHTML(body, `
    ${infoHtml}
    <div class="companion-section">
      <div class="companion-section-title">My Notes</div>
      <textarea class="companion-notes-ta" id="companionNotes" placeholder="Add your notes about this show…"></textarea>
      <div class="companion-notes-hint">Auto-saved · included in data export</div>
    </div>`);
  $('companionNotes').value = localStorage.getItem(noteKey) ?? '';

  let noteDebounce = null;
  $('companionNotes').addEventListener('input', e => {
    clearTimeout(noteDebounce);
    noteDebounce = setTimeout(() => localStorage.setItem(noteKey, e.target.value), 600);
  });

  panel.classList.add('open');
}

export function closeCompanion() { $('companionPanel').classList.remove('open'); }
$('companionClose').addEventListener('click', closeCompanion);

/* ── Saved queues ────────────────────────────────── */
function getSavedQueues() { try { return JSON.parse(localStorage.getItem('db-saved-queues') || '[]'); } catch { return []; } }
function saveQueues(qs)   { localStorage.setItem('db-saved-queues', JSON.stringify(qs)); }

export function renderSavedQueues() {
  const qs  = getSavedQueues();
  const sec = $('savedQueuesSection');
  if (!qs.length) { sec.style.display = 'none'; return; }
  sec.style.display = 'block';
  safeInnerHTML($('savedQueuesList'), qs.map((q, i) => `
    <div class="saved-queue-row">
      <div class="saved-queue-info" data-qi="${i}">
        <div class="saved-queue-name">${esc(q.name)}</div>
        <div class="saved-queue-meta">${q.tracks.length} tracks</div>
      </div>
      <button class="saved-queue-del" data-qi="${i}" title="Delete">✕</button>
    </div>`).join(''));
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
      const qs2 = getSavedQueues(); qs2.splice(+btn.dataset.qi, 1); saveQueues(qs2);
      renderSavedQueues();
    }));
}

/* ── Queue panel ─────────────────────────────────── */
let dragSrcIdx = null;

export function renderQueuePanel() {
  if (!$('queuePanel').classList.contains('open')) return;
  const q = state.queue;
  if (!q.length) {
    $('queueList').innerHTML = `<div class="loading" style="height:60px;font-size:12px">No tracks queued</div>`;
    renderSavedQueues(); return;
  }
  safeInnerHTML($('queueList'), q.map((t, i) => `
    <div class="queue-item ${i === state.queueIdx ? 'current' : ''}" data-qi="${i}" draggable="true">
      <div class="queue-drag-handle">⠿</div>
      <div class="queue-item-num">${i === state.queueIdx ? '▶' : i + 1}</div>
      <div class="queue-item-name">${esc(t.title || 'Unknown')}</div>
      <div class="queue-item-dur">${fmt(t.duration)}</div>
    </div>`).join(''));

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
      if      (state.queueIdx === dragSrcIdx)                                   state.queueIdx = destIdx;
      else if (dragSrcIdx < state.queueIdx && destIdx >= state.queueIdx)        state.queueIdx--;
      else if (dragSrcIdx > state.queueIdx && destIdx <= state.queueIdx)        state.queueIdx++;
      dragSrcIdx = null;
      renderQueuePanel();
    });
  });

  const cur = $('queueList').querySelector('.current');
  if (cur) cur.scrollIntoView({ block: 'nearest' });
  renderSavedQueues();
}

/* ── Cast management ─────────────────────────────── */
export function updateCastUI() {
  const btn = $('btnCast');
  if (!btn) return;
  btn.classList.toggle('active', cast.active);
  btn.title = cast.active ? `Casting to ${cast.deviceName} — click to stop` : 'Cast';
  if (cast.active) $('btnPlay').innerHTML = cast.paused ? '&#9654;' : '&#9646;&#9646;';
}

function showCastPicker(devices) {
  const list = $('castPickerList');
  safeInnerHTML(list, devices.map((d, i) =>
    `<div class="cast-device-item" data-idx="${i}">${esc(d.name)}</div>`).join(''));
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
    } catch (e) { handleNugsAuthError(e); return; }
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
    } catch (e) { console.error('[player] castAdvanceTrack', e); return; }
  }
  if (!url) return;
  $('playerTitle').textContent = track.title || '';
  setPlayerSub(state.artist, state.show);
  window.ipc?.send('player-update', { title: `${track.title} — ${state.artist?.name}` });
  await window.ipc?.castLoad(url, castContentType(url), track.title ?? '', '');
  cast.paused = false; updateCastUI();
}

/* ── Shortcuts modal ─────────────────────────────── */
export function openShortcuts()  { $('shortcutsModal').style.display = 'flex'; }
export function closeShortcuts() { $('shortcutsModal').style.display = 'none'; }
$('shortcutsClose').addEventListener('click', closeShortcuts);
$('btnHelp').addEventListener('click', openShortcuts);
$('shortcutsModal').addEventListener('click', e => {
  if (e.target === $('shortcutsModal') || e.target.classList.contains('shortcuts-backdrop')) closeShortcuts();
});

/* ── Keyboard shortcuts ──────────────────────────── */
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'Escape') {
    if ($('shortcutsModal').style.display !== 'none') { closeShortcuts(); return; }
    if (nowPlayingOpen) { closeNowPlaying(); return; }
  }
  if (e.key === '?')                    { e.preventDefault(); openShortcuts(); return; }
  if (e.altKey && e.key === 'ArrowLeft')  { e.preventDefault(); document.dispatchEvent(new CustomEvent('player:nav-back'));    return; }
  if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); document.dispatchEvent(new CustomEvent('player:nav-forward')); return; }
  switch (e.key) {
    case ' ':
      e.preventDefault(); player.toggle(); break;
    case 'ArrowLeft':
      e.preventDefault();
      if (audio.duration) audio.currentTime = Math.max(0, audio.currentTime - (e.shiftKey ? 60 : 15));
      break;
    case 'ArrowRight':
      e.preventDefault();
      if (audio.duration) audio.currentTime = Math.min(audio.duration, audio.currentTime + (e.shiftKey ? 60 : 15));
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
    case '[': e.preventDefault(); player.prev(); break;
    case ']': e.preventDefault(); player.next(); break;
    case 's': case 'S': e.preventDefault(); state.shuffleOn = !state.shuffleOn; $('btnShuffle').classList.toggle('active', state.shuffleOn); break;
    case 'r': case 'R': e.preventDefault(); $('btnRepeat').click(); break;
    case 'q': case 'Q': e.preventDefault(); $('btnQueue').click();  break;
    case '/': e.preventDefault(); $('searchToggle').click(); break;
    case 'm': case 'M': if (!e.altKey) { e.preventDefault(); $('btnMini').click(); } break;
    case 'e': case 'E':
      if (e.ctrlKey) {
        e.preventDefault();
        const nowBypassed = !isBypassed();
        setBypass(nowBypassed).catch(err => console.error('[player] setBypass:', err));
        showToast(nowBypassed ? 'EQ bypassed' : 'EQ enabled');
        // Sync the toggle if Settings is open
        const toggleEl = document.getElementById('toggleEq');
        if (toggleEl) toggleEl.checked = !nowBypassed;
      }
      break;
  }
});

/* ── Context menu ────────────────────────────────── */
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
  menu.style.left    = `${Math.min(e.clientX, window.innerWidth  - 170)}px`;
  menu.style.top     = `${Math.min(e.clientY, window.innerHeight -  60)}px`;
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
  const track = ctxTrackData; hideCtx();
  showTapePickerForTrack(track);
});

/* ── Tape picker ─────────────────────────────────── */
let _tapePickerTrack = null;

export function showTapePickerForTrack(track) {
  _tapePickerTrack = track;
  renderTapePickerList();
  const picker = $('tapePicker');
  picker.style.display = 'block';
  picker.style.left    = `${Math.round(window.innerWidth  / 2 - 110)}px`;
  picker.style.top     = `${Math.round(window.innerHeight / 2 -  80)}px`;
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
    safeInnerHTML($('tapePickerList'), all.map(t => `
      <div class="tape-picker-item" data-tid="${esc(t.id)}">
        ${esc(t.name)} <span style="color:var(--text3);font-size:11px">(${t.tracks.length})</span>
      </div>`).join(''));
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
