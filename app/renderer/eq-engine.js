/* ── eq-engine.js — 5-band graphic EQ ────────────────────────────
   Uses Web Audio API BiquadFilterNodes (peaking) connected in series.
   Both audioEl and preloadEl feed the same filter chain so gapless
   swaps stay in-band without any reconnection.

   Architecture
   ────────────
   $('audioEl')   ──┐
                    ├─→ filter[0] → filter[1] → filter[2] → filter[3] → filter[4] → ctx.destination
   $('preloadEl') ──┘

   Bypass is VIRTUAL — nodes are never disconnected.  When bypass is on,
   all filter gains are ramped to 0 dB (flat response); the saved slider
   positions are kept in _savedGains and restored when bypass is lifted.

   Idempotency guarantees
   ──────────────────────
   • createMediaElementSource() is only ever called once per element
     (tracked in _connectedEls); subsequent calls are safely skipped.
   • initEq() / ensureRunning() are safe to call on every player.load().

   Gains and bypass state are persisted via settings (IndexedDB).
   ──────────────────────────────────────────────────────────────── */

import { settings } from './state.js';

export const BAND_LABELS = ['60 Hz', '250 Hz', '1 kHz', '4 kHz', '12 kHz'];
export const BAND_FREQS  = [60, 250, 1000, 4000, 12000];

const RAMP_SECS = 0.01; // 10 ms — inaudible ramp prevents clicks on bypass toggle

let _ctx          = null;
let _filters      = [];
let _savedGains   = [0, 0, 0, 0, 0]; // user's slider positions — never zeroed by bypass
let _bypass       = false;
let _inited       = false;
const _connectedEls = new Set(); // tracks which elements have a MediaElementSource

/* ── Internal helpers ─────────────────────────────── */

function _rampToGains(targetValues) {
  const now = _ctx.currentTime;
  _filters.forEach((f, i) => {
    f.gain.cancelScheduledValues(now);
    f.gain.setValueAtTime(f.gain.value, now);
    f.gain.linearRampToValueAtTime(targetValues[i], now + RAMP_SECS);
  });
}

function _applyGainsNow() {
  _filters.forEach((f, i) => { f.gain.value = _bypass ? 0 : _savedGains[i]; });
}

/**
 * Connect an element to the filter chain.  createMediaElementSource() can
 * only be called once per element — _connectedEls guards against a second
 * call (which would throw InvalidStateError).
 */
function _connectElement(el) {
  if (!el || _connectedEls.has(el)) return;
  try {
    _ctx.createMediaElementSource(el).connect(_filters[0]);
    _connectedEls.add(el);
  } catch (err) {
    console.error('[eq-engine] createMediaElementSource failed:', err.message);
  }
}

/* ── Public API ───────────────────────────────────── */

/**
 * Resume the AudioContext if it is suspended.
 * Must be called (and awaited) from inside a user-gesture handler so that
 * Chromium's autoplay policy grants the resume.
 */
export async function ensureRunning() {
  if (_ctx && _ctx.state === 'suspended') {
    await _ctx.resume().catch(err => console.error('[eq-engine] resume:', err));
  }
}

/**
 * Initialise the EQ on first call, then resume on every subsequent call.
 * Safe to await on every player.load() — subsequent calls resolve in < 1 ms
 * when the context is already running.
 */
export async function initEq() {
  if (_inited) {
    await ensureRunning();
    return;
  }
  try {
    _ctx = new AudioContext();
    await _ctx.resume();

    // Load persisted state before building the chain so gains are applied
    // correctly even if the user changed settings before the first play.
    _savedGains = settings.getKey('eqGains',  [0, 0, 0, 0, 0]);
    _bypass     = settings.getKey('eqBypass', false);

    // Build filter chain
    _filters = BAND_FREQS.map(freq => {
      const f = _ctx.createBiquadFilter();
      f.type            = 'peaking';
      f.frequency.value = freq;
      f.Q.value         = 1.4;
      f.gain.value      = 0;
      return f;
    });

    // Connect filters in series: f[0] → f[1] → … → f[4] → destination
    for (let i = 0; i < _filters.length - 1; i++) {
      _filters[i].connect(_filters[i + 1]);
    }
    _filters[_filters.length - 1].connect(_ctx.destination);

    // Connect both audio elements — permanently, never disconnected
    _connectElement(document.getElementById('audioEl'));
    _connectElement(document.getElementById('preloadEl'));

    _applyGainsNow();
    _inited = true;
  } catch (err) {
    console.error('[eq-engine] initEq:', err);
  }
}

/**
 * Toggle bypass.  Nodes remain connected; gains are ramped to 0 (bypass ON)
 * or restored from _savedGains (bypass OFF).  Resumes a suspended context first.
 */
export async function setBypass(on) {
  _bypass = on;
  settings.setKey('eqBypass', on);
  if (!_inited) return;
  await ensureRunning();
  _rampToGains(on ? [0, 0, 0, 0, 0] : _savedGains);
}

/** Set gain (dB) for a single band and persist.  Respects bypass. */
export function setBand(index, gainDb) {
  _savedGains[index] = gainDb;
  settings.setKey('eqGains', [..._savedGains]);
  if (!_inited || _bypass) return;
  _filters[index].gain.value = gainDb;
}

/** Set all band gains at once and persist. */
export function setGains(gains) {
  gains.forEach((v, i) => { _savedGains[i] = v; });
  settings.setKey('eqGains', [..._savedGains]);
  if (!_inited || _bypass) return;
  _rampToGains(_savedGains);
}

/** Reset all bands to 0 dB. */
export function resetBands() {
  setGains([0, 0, 0, 0, 0]);
}

export function getGains()   { return [..._savedGains]; }
export function isBypassed() { return _bypass; }
export function isInited()   { return _inited; }

/**
 * Connect any HTMLMediaElement (e.g. a live <video>) to the EQ filter chain.
 * Initialises the AudioContext if it hasn't been already.
 * Safe to call multiple times for the same element — the internal Set guards
 * against duplicate createMediaElementSource() calls.
 */
export async function connectElement(el) {
  await initEq(); // idempotent — resolves immediately if already running
  _connectElement(el);
}
