/* ── video-player.js — live HLS webcast player ────────────────────
   Architecture
   ────────────
   main.js onBeforeRequest intercepts nugs master.m3u8?hdntl= URLs when
   a <media> element tries to load them directly, blocks the native load,
   and sends 'start-live-stream' IPC → renderer.

   Here we:
     1. Receive the URL via window.ipc.on('start-live-stream')
     2. Show a glassmorphic video panel over the content area
     3. Feed the URL into hls.js (already loaded as a global in index.html)
     4. Route the <video> element's audio through the existing 5-band EQ
        by calling connectElement() from eq-engine — the same filter chain
        the music player uses.  EQ presets work on live video too.
     5. Wire a Cast button that reuses the app's existing castv2 IPC stack
        (discover → picker → connect → load with contentType m3u8/LIVE).

   Note: casting bypasses the local Web Audio API / EQ — this is expected
   because the Cast receiver plays the stream independently.
   ─────────────────────────────────────────────────────────────────── */

import { initEq, connectElement } from './eq-engine.js';
import { $, esc, showToast } from './utils.js';

let _hls         = null;   // active Hls instance
let _url         = null;   // current stream URL
let _castActive  = false;  // true while a cast session owns this stream

/* ── DOM references (set in init) ───────────────────────────────── */
let panel, videoEl, statusEl, titleEl;

/* ── Public init — called once from app.js ──────────────────────── */
export function initVideoPlayer() {
  panel    = $('liveVideoPanel');
  videoEl  = $('liveVideoEl');
  statusEl = $('liveVideoStatus');
  titleEl  = $('liveVideoTitle');
  if (!panel || !videoEl) return;

  // Main process sends this when it intercepts a nugs HLS URL
  window.ipc?.on('start-live-stream', url => _startStream(url));

  // ── Controls ─────────────────────────────────────────────────────
  $('liveVideoClose')    ?.addEventListener('click', _closeStream);
  $('liveVideoBackdrop') ?.addEventListener('click', _closeStream);
  $('liveVideoPlayPause')?.addEventListener('click', _togglePlayPause);
  $('liveVideoMute')     ?.addEventListener('click', _toggleMute);
  $('liveVideoFullscreen')?.addEventListener('click', () => videoEl.requestFullscreen?.().catch(() => {}));
  $('liveVideoCast')     ?.addEventListener('click', _castStream);

  // Sync play/pause button with actual video state
  videoEl.addEventListener('play',    () => _setPlayBtn(false));
  videoEl.addEventListener('pause',   () => _setPlayBtn(true));
  videoEl.addEventListener('waiting', () => { if (statusEl) statusEl.textContent = 'Buffering…'; });
  videoEl.addEventListener('playing', () => { if (statusEl) statusEl.textContent = 'Live'; });
  videoEl.addEventListener('error',   () => { if (statusEl) statusEl.textContent = 'Stream error'; });

  // Listen for cast status updates (disconnected externally, etc.)
  window.ipc?.on('cast-status', status => {
    if (_castActive && status?.state === 'DISCONNECTED') {
      _castActive = false;
      $('liveVideoCast')?.classList.remove('active');
    }
  });

  // Keyboard: Escape closes the panel
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && panel.style.display !== 'none') _closeStream();
  });
}

/* ── Stream lifecycle ───────────────────────────────────────────── */

async function _startStream(url) {
  _url = url;

  // Route audio through the existing 5-band EQ filter chain.
  // initEq() is idempotent — safe to call even if EQ is already running.
  try {
    await initEq();
    connectElement(videoEl);
  } catch (err) {
    console.error('[video-player] EQ routing failed:', err);
  }

  // Destroy any previous HLS instance cleanly
  if (_hls) { _hls.destroy(); _hls = null; }

  if (typeof Hls !== 'undefined' && Hls.isSupported()) {
    _hls = new Hls({
      enableWorker:   true,
      lowLatencyMode: true,
      backBufferLength: 60,
    });

    _hls.loadSource(url);
    _hls.attachMedia(videoEl);

    _hls.on(Hls.Events.MANIFEST_PARSED, () => {
      videoEl.play().catch(err => console.error('[video-player] play:', err));
      if (statusEl) statusEl.textContent = 'Live';
    });

    _hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      console.error('[video-player] HLS fatal:', data.type, data.details);
      if (statusEl) statusEl.textContent = 'Stream error — try reloading';
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        // Try to recover once
        _hls.startLoad();
      } else {
        _hls.destroy(); _hls = null;
      }
    });
  } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
    // Fallback: native HLS (unlikely in Electron but covered)
    videoEl.src = url;
    videoEl.play().catch(console.error);
  } else {
    showToast('HLS not supported in this environment');
    return;
  }

  // Show the panel
  panel.style.display = 'flex';
  if (statusEl) statusEl.textContent = 'Connecting…';
  _setPlayBtn(false);
}

function _closeStream() {
  if (_hls)     { _hls.destroy(); _hls = null; }
  videoEl.pause();
  videoEl.removeAttribute('src');
  videoEl.load();
  panel.style.display = 'none';
  _url = null;
  _castActive = false;
}

/* ── Playback controls ──────────────────────────────────────────── */

function _togglePlayPause() {
  if (videoEl.paused) videoEl.play().catch(console.error);
  else videoEl.pause();
}

function _toggleMute() {
  videoEl.muted = !videoEl.muted;
  const btn = $('liveVideoMute');
  if (btn) btn.innerHTML = videoEl.muted ? '&#128263;' : '&#128266;';
}

function _setPlayBtn(paused) {
  const btn = $('liveVideoPlayPause');
  if (btn) btn.innerHTML = paused ? '&#9654;' : '&#9646;&#9646;';
}

/* ── Cast ───────────────────────────────────────────────────────── */
// Reuses the app's existing castv2-client IPC infrastructure.
// Discovers devices → shows a picker → connects → loads the HLS URL
// with contentType 'application/x-mpegURL' and streamType LIVE.

async function _castStream() {
  if (!_url) return;

  if (_castActive) {
    await window.ipc?.castStop();
    _castActive = false;
    $('liveVideoCast')?.classList.remove('active');
    showToast('Cast stopped');
    return;
  }

  const castBtn = $('liveVideoCast');
  if (castBtn) castBtn.style.opacity = '0.5';
  showToast('Searching for Cast devices…');

  const res = await window.ipc?.castDiscover();
  if (castBtn) castBtn.style.opacity = '';

  if (!res?.ok || !res.devices?.length) {
    showToast('No Cast devices found on this network');
    return;
  }

  _showLiveCastPicker(res.devices);
}

function _showLiveCastPicker(devices) {
  // Reuse the existing cast-picker panel already in the DOM
  const list = $('castPickerList');
  if (!list) return;

  // Temporarily replace the list content with live-stream devices
  list.innerHTML = devices.map((d, i) =>
    `<div class="cast-device-item" data-idx="${i}">${esc(d.name)}</div>`
  ).join('');

  const picker = $('castPicker');
  picker.style.display = 'flex';

  list.querySelectorAll('.cast-device-item').forEach(el =>
    el.addEventListener('click', async () => {
      picker.style.display = 'none';
      const device = devices[+el.dataset.idx];
      showToast(`Connecting to ${device.name}…`);

      const conn = await window.ipc?.castConnect(device.host, device.port);
      if (!conn?.ok) { showToast(`Cast failed: ${conn?.error}`); return; }

      // Load as an HLS LIVE stream — castv2-client will set streamType LIVE
      const loadRes = await window.ipc?.castLoad(
        _url,
        'application/x-mpegURL',
        titleEl?.textContent ?? 'Live Webcast',
        ''
      );
      if (!loadRes?.ok) { showToast(`Cast load failed: ${loadRes?.error}`); return; }

      _castActive = true;
      $('liveVideoCast')?.classList.add('active');
      showToast(`Casting live to ${device.name}`);

      // Mute local video — audio is now on the TV
      videoEl.muted = true;
      const muteBtn = $('liveVideoMute');
      if (muteBtn) muteBtn.innerHTML = '&#128263;';
    })
  );
}

/* ── Public helpers ─────────────────────────────────────────────── */

/** Programmatically start a live stream from renderer code (e.g. nugs views). */
export function startLiveStream(url, title = 'Live Webcast') {
  if (titleEl) titleEl.textContent = title;
  _startStream(url);
}

export function getLiveStreamUrl() { return _url; }
export function isLivePanelOpen()  { return panel?.style.display !== 'none'; }
