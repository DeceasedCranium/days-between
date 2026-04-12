/* ── mixlr-player.js — Mixlr webview audio hijack + EQ routing ─────
   Strategy
   ────────
   Mixlr has no public API.  We embed their site in an Electron
   <webview> and intercept the audio stream before it reaches the
   speakers.

   Step 1 — Mute immediately
     As soon as the webview attaches we call setAudioMuted(true) so
     nothing leaks to the system audio device under any circumstances.

   Step 2 — Inject monitoring JS
     After the webview's DOM is ready we use executeJavaScript() to
     patch HTMLMediaElement.prototype.play.  The patch captures
     this.currentSrc (set by the browser just before play() fires)
     and writes it to window.__mixlrStream.

   Step 3 — Poll & route
     We poll window.__mixlrStream every 1.5 s via executeJavaScript().
     When a URL appears that looks like an audio stream (.m3u8, .mp3,
     /audio, /stream) we pipe it into the existing video-player.js /
     hls.js pipeline — which calls connectElement(el) so the Mixlr
     audio runs through the 5-band EQ.

   Step 4 — Cleanup
     When the Mixlr pane is hidden we stop the poll and close the
     active stream.
   ─────────────────────────────────────────────────────────────────── */

import { startLiveStream, getLiveStreamUrl, isLivePanelOpen } from './video-player.js';
import { $, showToast } from './utils.js';

let _webview     = null;
let _pollTimer   = null;
let _activeUrl   = null;
let _muted       = false;

/* ── Injection script — runs INSIDE the webview context ──────────── */
// Written as a string so it evaluates cleanly via executeJavaScript.
const INJECT_SRC = `
(function () {
  if (window.__mixlrInjected) return;
  window.__mixlrInjected = true;
  window.__mixlrStream   = null;

  function recordStream(url) {
    if (!url) return;
    // Only capture audio stream URLs — skip page navigations and images
    if (/\\.m3u8|audio\\/|stream|listen|\\.mp3|\\.aac/i.test(url)) {
      window.__mixlrStream = url;
    }
  }

  // Patch HTMLMediaElement.play — fires when user presses Play in Mixlr UI
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    recordStream(this.currentSrc || this.src);
    return origPlay.call(this);
  };

  // Patch XMLHttpRequest — catches HLS playlist fetches
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    recordStream(url);
    return origOpen.apply(this, arguments);
  };

  // Patch fetch — catches MPEG-DASH / HLS manifest fetches
  const origFetch = window.fetch;
  window.fetch = function (input, ...rest) {
    const url = typeof input === 'string' ? input : input?.url ?? '';
    recordStream(url);
    return origFetch.call(window, input, ...rest);
  };
})();
`;

/* ── Public API ──────────────────────────────────────────────────── */

export function initMixlr() {
  _webview = $('mixlrWebview');
  if (!_webview) return;

  // Mute the webview immediately — before any content loads — so audio
  // never reaches the system speakers no matter how fast Mixlr loads.
  _muteWebview();

  _webview.addEventListener('dom-ready', _onDomReady);
  _webview.addEventListener('did-navigate', _onNavigate);
  _webview.addEventListener('did-navigate-in-page', _onNavigate);

  // If the webview crashes or is reloaded, re-inject
  _webview.addEventListener('crashed', () => {
    console.warn('[mixlr] webview crashed — reloading');
    _webview.reload();
  });
}

export function showMixlr() {
  const pane = $('mixlrPane');
  if (pane) pane.style.display = 'flex';
  _muteWebview();
  _startPoll();
}

export function hideMixlr() {
  const pane = $('mixlrPane');
  if (pane) pane.style.display = 'none';
  _stopPoll();
  // Don't close the EQ stream — user might want audio to continue
}

/* ── Internal ────────────────────────────────────────────────────── */

function _muteWebview() {
  if (!_webview) return;
  try {
    _webview.setAudioMuted(true);
    _muted = true;
  } catch {
    // setAudioMuted not available until webview is attached — will retry in dom-ready
  }
}

function _onDomReady() {
  // Ensure mute is applied (setAudioMuted works reliably after dom-ready)
  _muteWebview();
  // Inject the monitoring script
  _webview.executeJavaScript(INJECT_SRC).catch(err =>
    console.warn('[mixlr] inject failed:', err));
}

function _onNavigate() {
  // Re-inject after navigation (SPA route changes don't re-fire dom-ready)
  _activeUrl = null;
  _webview.executeJavaScript(INJECT_SRC).catch(() => {});
}

function _startPoll() {
  _stopPoll();
  _pollTimer = setInterval(_poll, 1500);
}

function _stopPoll() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

async function _poll() {
  if (!_webview) return;

  let streamUrl = null;
  try {
    streamUrl = await _webview.executeJavaScript('window.__mixlrStream || null');
  } catch {
    return; // webview not ready yet
  }

  if (!streamUrl || streamUrl === _activeUrl) return;
  _activeUrl = streamUrl;

  console.info('[mixlr] stream detected:', streamUrl);

  // Show the indicator badge
  const indicator = $('mixlrStreamIndicator');
  if (indicator) indicator.style.display = 'flex';

  showToast('Mixlr stream routed through EQ');

  // Hand off to the video-player / hls.js pipeline — this calls
  // connectElement(videoEl) internally so the EQ filter chain handles it.
  startLiveStream(streamUrl, 'Mixlr Live');
}
