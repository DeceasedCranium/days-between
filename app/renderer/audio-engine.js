/* ── audio-engine.js — gapless dual-buffer, Phase 1 ──────────────
   MP3/direct-URL tracks only (Relisten). Nugs/HLS use normal playback.

   No Web Audio API — crossfade uses native element .volume so there
   is no AudioContext suspension race and basic playback is unaffected.

   Architecture
   ────────────
   _primary  — currently-playing HTMLAudioElement
   _staging  — pre-buffering the next track

   Event routing: both elements are bound to _routeEvent.
   _routeEvent only dispatches when event.target === _primary,
   so swapping _primary automatically reroutes — no rebinding needed.
   ──────────────────────────────────────────────────────────────── */

import { $ } from './utils.js';

/* ── Internal element references ─────────────────── */
let _primary = $('audioEl');
let _staging = $('preloadEl');

// crossOrigin must be set before any src is assigned so that every fetch is
// a CORS request.  This is required for createMediaElementSource() in the EQ
// engine — without it Chromium blocks Web Audio access to cross-origin audio.
_primary.crossOrigin = 'anonymous';
_staging.crossOrigin = 'anonymous';

/* ── Event routing ───────────────────────────────── */
const _listeners    = new Map(); // eventType → handler[]
const _routedEvents = new Set();

function _routeEvent(ev) {
  if (ev.target !== _primary) return;
  const handlers = _listeners.get(ev.type);
  if (handlers) for (const h of handlers) h.call(_primary, ev);
}

function _ensureRouted(type) {
  if (_routedEvents.has(type)) return;
  $('audioEl').addEventListener(type, _routeEvent);
  $('preloadEl').addEventListener(type, _routeEvent);
  _routedEvents.add(type);
}

/* ── Public proxy objects ────────────────────────── */
export const audio = {
  get src()          { return _primary.src; },
  set src(v)         { _primary.src = v; },
  get currentTime()  { return _primary.currentTime; },
  set currentTime(v) { _primary.currentTime = v; },
  get volume()       { return _primary.volume; },
  set volume(v)      { _primary.volume = v; },
  get duration()     { return _primary.duration; },
  get paused()       { return _primary.paused; },
  get readyState()   { return _primary.readyState; },
  get error()        { return _primary.error; },
  play()             { return _primary.play(); },
  pause()            { _primary.pause(); },
  load()             { _primary.load(); },
  // {once} listeners bind directly to _primary (used for one-shot resume in app.js)
  addEventListener(type, handler, opts) {
    if (opts?.once) { _primary.addEventListener(type, handler, opts); return; }
    if (!_listeners.has(type)) _listeners.set(type, []);
    _listeners.get(type).push(handler);
    _ensureRouted(type);
  },
  removeEventListener(type, handler) {
    const arr = _listeners.get(type);
    if (arr) { const i = arr.indexOf(handler); if (i >= 0) arr.splice(i, 1); }
  },
};

export const preloadAudio = {
  get src()        { return _staging.src; },
  set src(v)       { _staging.src = v; },
  get readyState() { return _staging.readyState; },
  get duration()   { return _staging.duration; },
  play()           { return _staging.play(); },
  pause()          { _staging.pause(); },
};

/* ── Gapless crossfade engine (element-volume based) ─────────────
   No AudioContext — avoids autoplay suspension race entirely.
   Volumes are ramped via setInterval at ~60 fps.
   ──────────────────────────────────────────────────────────────── */
const CROSSFADE_SECS = 0.4;

let _gaplessFired = false;
let _fadeTimer    = null;

export const engine = {
  get fired() { return _gaplessFired; },

  // No-op — kept so player.js call sites don't need changing
  init() {},

  // True when all conditions are met to start a crossfade
  canFire(nextTrack) {
    if (_gaplessFired)                         return false;
    if (!nextTrack || nextTrack._nugs)         return false; // Phase 1: Relisten MP3s only
    if (_primary.src?.includes('.m3u8'))       return false; // not from an HLS source
    if (!_staging.src)                         return false;
    return _staging.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
  },

  // Start crossfade — call from timeupdate when remaining ≤ CROSSFADE_SECS
  arm(remaining) {
    if (_gaplessFired) return;
    _gaplessFired = true;

    const targetVol = _primary.volume;
    _staging.volume = 0;
    _staging.play().catch(e => console.error('[audio-engine] arm.play:', e));

    // Ramp primary 1→0 and staging 0→1 over `remaining` seconds
    const startMs = performance.now();
    const durMs   = Math.max(remaining * 1000, 50); // minimum 50 ms
    clearInterval(_fadeTimer);
    _fadeTimer = setInterval(() => {
      const t = Math.min(1, (performance.now() - startMs) / durMs);
      _primary.volume = targetVol * (1 - t);
      _staging.volume = targetVol * t;
      if (t >= 1) clearInterval(_fadeTimer);
    }, 16);
  },

  // Swap elements on 'ended' — returns true if a gapless swap occurred
  commit() {
    if (!_gaplessFired) return false;
    _gaplessFired = false;
    clearInterval(_fadeTimer);
    _fadeTimer = null;

    // _staging is the element that's been playing during the crossfade;
    // its volume has been ramped to targetVol. Capture it before swap.
    const vol = _staging.volume;

    // Swap: new _primary is the element already playing the next track
    [_primary, _staging] = [_staging, _primary];

    // Silence and reset old primary (now staging)
    _staging.pause();
    _staging.src    = '';
    _staging.volume = vol; // restore for next preload cycle

    return true;
  },

  // Cancel crossfade — call on manual skip, seek, or new load
  cancel() {
    if (!_gaplessFired) return;
    _gaplessFired = false;
    clearInterval(_fadeTimer);
    _fadeTimer = null;
    // Restore primary volume (may have been partially ramped down)
    _primary.volume = Math.max(_primary.volume, _staging.volume);
    _staging.pause();
    _staging.src    = '';
    _staging.volume = _primary.volume;
  },
};

export { CROSSFADE_SECS };

// Gives player.js the real DOM element for hls.js attachMedia()
export function getPrimaryElement() { return _primary; }
