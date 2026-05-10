/* ── nugs-scraper.js — main-process headless scraper for nugs.net ─────────────
 *
 * Extracted from main.js as part of the v1.7 stabilisation pass:
 *   1. Modularises ~600 lines of ghost-window plumbing out of main.js so the
 *      core process boot sequence is readable again.
 *   2. Replaces the global `uncaughtException` swallow with a per-scrape
 *      AbortController, eliminating the orphaned-async race that was
 *      surfacing as "Object has been destroyed" crashes.
 *   3. Augments the DOM-snapshot scrape with a Chrome DevTools Protocol
 *      response-body capture so subscription-gated JSON endpoints can be
 *      consumed directly instead of inferring shape from rendered HTML.
 *
 * IPC contract (unchanged for backwards compatibility — renderer parser at
 * app/renderer/nugs-scraper.js is opt-in for the JSON path):
 *
 *   scrape-nugs-html(url) →
 *     { ok: true,  html, stashItems?, jsonResponses? }
 *     { ok: false, error }
 *
 *   inject-nugs-html(html) →
 *     { ok: true, html } | { ok: false, error }
 *
 *   extract-nugs-stream(url) →
 *     { ok: true, m3u8 } | { ok: false, error }
 *
 * Usage from main.js:
 *
 *   const { initNugsScraper, destroyGhostOnQuit } = require('./nugs-scraper');
 *   app.whenReady().then(() => { ...; initNugsScraper(); });
 *   app.on('will-quit', () => destroyGhostOnQuit());
 * ─────────────────────────────────────────────────────────────────────────── */

const { BrowserWindow, ipcMain } = require('electron');

let _ghostWin = null;
let _scraping = false;

// Verbose-trace gate — production users see a clean console; set
// DAYS_BETWEEN_DEBUG=1 in the environment (or via the wrapper script) to
// re-enable per-poll / per-click ghost tracing.
const _DEBUG = process.env.DAYS_BETWEEN_DEBUG === '1';
const dlog   = (...a) => { if (_DEBUG) console.log(...a); };
const dinfo  = (...a) => { if (_DEBUG) console.info(...a); };

// Timing jitter — randomises polling/scroll cadence to defeat volumetric bot
// detection. Used both in the main process (between ghostEval polls) and
// inlined into the in-page harvest loop (see ghostEval JS string below).
const jitter = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// URLs where the user would normally need to interact (login, OAuth, captcha).
// Triggering one in the headless ghost is fatal — the hard timer must expire
// and the IPC must return an error so the renderer can prompt the user to
// sign in via the in-app Settings flow.
const LOGIN_URL_RE = /login|signin|sign-in|oauth|auth\b|id\.nugs\.net|cloudflare|challenge/i;

// Nugs sometimes redirects to error pages when the session is stale. We catch
// these in did-navigate and bounce back to /home to refresh cookies.
const ERROR_URL_RE = /\/error\/|\/on\/error|technical-reasons|\/404|\/500/i;

// Endpoints that return JSON the renderer would otherwise have to parse out of
// rendered HTML. Captured via CDP Network.getResponseBody — see startCdpCapture.
//
// Coverage notes:
//   • streamapi.nugs.net  → catalog.containers*, catalog.container, user.* etc.
//                           (also reached directly by renderer-side nugsApi)
//   • subscriptions / id  → auth + entitlement payloads
//   • play.nugs.net /api  → SPA-side endpoints (recently-added, popular,
//                           playlists, recommendations) when the ghost loads
//                           a /play page. The artist tabs feature uses these
//                           if/when the page hits them; otherwise the renderer
//                           falls back to deriving categories from the per-
//                           artist catalog it already paginated.
//   • www.nugs.net /api   → legacy site endpoints used by the dashboard
//                           scraper.
const JSON_ENDPOINT_RE = new RegExp([
  '\\bstreamapi\\.nugs\\.net\\b',
  '\\bsubscriptions\\.nugs\\.net\\b',
  '\\bid\\.nugs\\.net/connect',
  '\\bplay\\.nugs\\.net/api',
  '\\bwww\\.nugs\\.net/api',
].join('|'), 'i');

/* ── Ghost lifecycle ──────────────────────────────────────────────────────── */

function destroyGhost() {
  try { if (_ghostWin && !_ghostWin.isDestroyed()) _ghostWin.destroy(); } catch {}
  _ghostWin = null;
  _scraping = false;
}

function ensureGhost() {
  if (_ghostWin && !_ghostWin.isDestroyed()) return _ghostWin;
  _ghostWin = new BrowserWindow({
    show:        false,
    skipTaskbar: true,
    width:       1100,
    height:      700,
    title:       'Days Between — Nugs Scraper',
    webPreferences: {
      partition:        'persist:nugs',
      nodeIntegration:  false,
      contextIsolation: true,
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    },
  });

  _ghostWin.on('closed', () => { _ghostWin = null; _scraping = false; });

  // Strip Electron/webdriver fingerprints on every navigation. Cloudflare and
  // Demandware check `navigator.webdriver` before running their challenges.
  _ghostWin.webContents.on('dom-ready', () => {
    if (!_ghostWin || _ghostWin.isDestroyed()) return;
    _ghostWin.webContents.executeJavaScript(`
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        if (!window.chrome) {
          Object.defineProperty(window, 'chrome', { writable: false, value: { runtime: {} } });
        }
      } catch(e) {}
    `).catch(() => {});
  });

  _ghostWin.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return; // ERR_ABORTED — normal for cancelled redirects
    console.error('[ghost] did-fail-load:', validatedURL, '—', errorCode, errorDescription);
  });

  _ghostWin.webContents.on('did-navigate', (_e, navUrl) => {
    if (!ERROR_URL_RE.test(navUrl)) return;
    console.warn('[ghost] error/redirect page detected — refreshing session:', navUrl);
    _ghostWin.webContents.loadURL('https://play.nugs.net/home').catch(() => {});
  });

  return _ghostWin;
}

/* ── CDP JSON-body capture ────────────────────────────────────────────────────
 * Electron's webRequest API exposes URLs and headers but NOT response bodies.
 * To capture the actual JSON nugs.net pages fetch from their backend we have
 * to attach the Chrome DevTools Protocol debugger and use Network.getResponseBody.
 *
 * webRequest.onCompleted is still useful as a notification rail — we get the
 * URL/status, then cross-reference it against our recorded responseReceived
 * events to fetch the matching body. Either signal alone is insufficient.
 *
 * Detach is best-effort: if the ghost window has already been destroyed when
 * we try to detach, we swallow the error.
 * ─────────────────────────────────────────────────────────────────────────── */

function startCdpCapture(ghost, signal) {
  const captured = [];                 // [{ url, status, type, body, parsed? }]
  const requestIndex = new Map();      // requestId → { url, status, type }
  let detached = false;

  let dbg;
  try {
    dbg = ghost.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
  } catch (err) {
    console.warn('[ghost-cdp] attach failed (capture disabled):', err.message);
    return { captured, stop: () => {} };
  }

  const onMessage = async (_event, method, params) => {
    if (signal.aborted || detached) return;
    if (method === 'Network.responseReceived') {
      const { requestId, response } = params ?? {};
      if (!response?.url || !JSON_ENDPOINT_RE.test(response.url)) return;
      requestIndex.set(requestId, {
        url:    response.url,
        status: response.status,
        type:   response.mimeType,
      });
    } else if (method === 'Network.loadingFinished') {
      const { requestId } = params ?? {};
      const meta = requestIndex.get(requestId);
      if (!meta) return;
      try {
        const { body, base64Encoded } = await dbg.sendCommand('Network.getResponseBody', { requestId });
        const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
        let parsed = null;
        if (text && (meta.type?.includes('json') || text.trimStart().startsWith('{') || text.trimStart().startsWith('['))) {
          try { parsed = JSON.parse(text); } catch { /* not JSON after all */ }
        }
        captured.push({ ...meta, body: text, parsed });
      } catch (err) {
        // getResponseBody fails for redirects, no-content responses, or after
        // detach. Not worth surfacing — the DOM snapshot path is still active.
      } finally {
        requestIndex.delete(requestId);
      }
    }
  };

  try {
    dbg.on('message', onMessage);
    dbg.sendCommand('Network.enable').catch(() => {});
  } catch (err) {
    console.warn('[ghost-cdp] enable failed:', err.message);
  }

  const stop = () => {
    if (detached) return;
    detached = true;
    try { dbg.removeListener('message', onMessage); } catch {}
    try { if (dbg.isAttached?.()) dbg.detach(); } catch {}
  };

  // Also stop on abort — keeps capture cleanup tied to the same lifecycle as
  // the polling loop instead of leaking the listener across scrapes.
  signal.addEventListener('abort', stop, { once: true });

  return { captured, stop };
}

/* ── IPC: inject-nugs-html ────────────────────────────────────────────────────
 * Manual fallback — renderer can paste page HTML when auto-scrape is broken.
 * No ghost window touched, so no abort/cleanup is needed.
 * ─────────────────────────────────────────────────────────────────────────── */

function registerInjectHandler() {
  ipcMain.handle('inject-nugs-html', (_e, html) => {
    if (!html || typeof html !== 'string') return { ok: false, error: 'no HTML provided' };
    dinfo('[ghost] manual DOM injection — length:', html.length);
    return { ok: true, html };
  });
}

/* ── IPC: scrape-nugs-html ────────────────────────────────────────────────────
 * The main entry point. Loads `url` in the ghost, scrolls/polls until enough
 * content has rendered, then snapshots `outerHTML` (and for /library/ pages,
 * a structured `stashItems` array).
 *
 * AbortController plumbing (Step 3):
 *   • One controller per call.
 *   • armHardTimer aborts on timeout AND tears down the ghost.
 *   • Every ghostEval and every awaited delay checks signal.aborted before
 *     touching the ghost — this kills the orphaned-async race that the old
 *     `uncaughtException` swallow was hiding.
 *
 * CDP capture (Step 4):
 *   • Started before the first navigation, stopped on settle.
 *   • Captured JSON is forwarded back as `result.jsonResponses` so the
 *     renderer parser can prefer it over re-parsing rendered HTML.
 * ─────────────────────────────────────────────────────────────────────────── */

function registerScrapeHandler() {
  ipcMain.handle('scrape-nugs-html', async (_e, url) => {
    if (_scraping) {
      console.warn('[ghost] busy — rejecting:', url);
      return { ok: false, error: 'ghost scraper busy — try again shortly' };
    }
    if (!url.startsWith('https://play.nugs.net') && !url.startsWith('https://www.nugs.net')) {
      return { ok: false, error: 'Invalid domain' };
    }
    _scraping = true;

    try {
      // ── Verified session warm-start ─────────────────────────────────────
      // If the ghost is cold, prove the user is signed in BEFORE hitting any
      // subscription-gated URL. Avoids the "Subscription Required" wall that
      // a blind 1s sleep used to ride into.
      {
        const warmWin = ensureGhost();
        let warmUrl = '';
        try { warmUrl = warmWin.webContents.getURL?.() ?? ''; } catch {}
        const isCold = !warmUrl.includes('nugs.net') ||
                        warmUrl === 'about:blank'    ||
                        /\/error|\/404/i.test(warmUrl);
        if (isCold) {
          dlog('[ghost] session warm-start: ghost is cold — verifying login on play.nugs.net/home…');
          await new Promise(r => {
            warmWin.webContents.once('did-navigate', () => {
              const PROOF = [
                '[class*="UserAvatar"]','[class*="user-avatar"]','[class*="Avatar"]',
                '[class*="PlayBar"]','[class*="playbar"]','[class*="player-bar"]',
                '[class*="Library"]','[class*="library"]',
                'a[href*="/library"]','a[href*="/profile"]',
                '[class*="userMenu"]','[class*="user-menu"]','[class*="logout"]',
                '[aria-label*="account" i]','[aria-label*="library" i]',
              ].join(',');
              const startMs = Date.now();
              const poll = async () => {
                if (warmWin.isDestroyed()) { r(); return; }
                try {
                  const ok = await warmWin.webContents.executeJavaScript(`
                    (function() {
                      if (document.querySelector('${PROOF}')) return true;
                      var signIn = document.querySelector(
                        'a[href*="/login"],a[href*="/sign-in"],[class*="signIn"],[class*="sign-in"]'
                      );
                      return !signIn && !!document.querySelector('nav,header,[class*="nav"],[class*="Nav"]');
                    })()
                  `);
                  if (ok) {
                    dlog('[ghost] session warm-start: login verified ✓ — proceeding to', url);
                    r();
                  } else if (Date.now() - startMs >= 6000) {
                    console.error('[ghost] AUTH FAILED: User token rejected — please sign in to play.nugs.net');
                    r();
                  } else {
                    setTimeout(poll, jitter(300, 600));
                  }
                } catch { r(); }
              };
              setTimeout(poll, jitter(300, 600));
            });
            warmWin.webContents.loadURL('https://play.nugs.net/home').catch(() => r());
          });
        }
        if (/\/watch|\/live\/|\/stream/i.test(url) && !/browse|library|home/i.test(url)) {
          dlog('[ghost] Livestream handshake: Session Validated. Extracting HLS…');
        }
      }

      return await new Promise(resolve => {
        const ghost = ensureGhost();
        const ac    = new AbortController();    // Step 3 — per-scrape lifecycle
        const cdp   = startCdpCapture(ghost, ac.signal);
        let settled = false;
        let isAuthenticating = false;
        let hardTimer;

        function settle(result) {
          if (settled) return;
          settled = true;
          clearTimeout(hardTimer);
          ac.abort();                            // tears down all in-flight awaits
          cdp.stop();                            // detach CDP debugger
          try {
            if (!ghost.isDestroyed()) {
              ghost.webContents.removeListener('dom-ready', onDomReady);
              ghost.webContents.removeAllListeners('did-navigate');
              ghost.webContents.removeAllListeners('will-navigate');
            }
          } catch { /* webContents may be dying — ignore */ }

          // Attach CDP-captured JSON to the result so the renderer parser can
          // skip its HTML decode path when the JSON is more reliable.
          if (cdp.captured.length && result?.ok) {
            result = { ...result, jsonResponses: cdp.captured };
          }

          destroyGhost();
          resolve(result);
        }

        function armHardTimer(ms) {
          clearTimeout(hardTimer);
          hardTimer = setTimeout(() => {
            console.warn(`[ghost] hard timeout (${ms / 1000}s) for:`, url);
            settle({ ok: false, error: `ghost timeout (${ms / 1000}s): ${url}` });
          }, ms);
        }

        // Initial 20s budget — armHardTimer aborts the controller on fire.
        armHardTimer(20_000);

        // ── ghostEval — abort-aware, null-safe executeJavaScript ───────────
        async function ghostEval(js) {
          if (ac.signal.aborted || settled) return undefined;
          if (!ghost || ghost.isDestroyed()) return undefined;
          try { return await ghost.webContents.executeJavaScript(js); }
          catch (e) {
            // If we were aborted mid-eval, swallow — that's the expected race.
            if (ac.signal.aborted) return undefined;
            console.warn('[ghost] eval error:', e.message);
            return undefined;
          }
        }

        // ── abort-aware sleep — every delay in this scope MUST go through
        // this helper so a hard-timer fire interrupts the loop immediately. ─
        function abortableSleep(ms) {
          return new Promise(resolve => {
            if (ac.signal.aborted) return resolve();
            const t = setTimeout(resolve, ms);
            ac.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
          });
        }

        ghost.webContents.on('will-navigate', (_ev, navUrl) => {
          if (settled) return;
          if (LOGIN_URL_RE.test(navUrl)) {
            console.warn('[ghost] will-navigate → auth/challenge page — hard timer will expire:', navUrl);
            isAuthenticating = true;
          }
        });

        ghost.webContents.on('did-navigate', (_ev, navUrl) => {
          if (settled) return;
          const isAuthPage = LOGIN_URL_RE.test(navUrl);
          if (isAuthPage) {
            console.warn('[ghost] did-navigate → auth/challenge — hard timer will expire:', navUrl);
            isAuthenticating = true;
          } else if (/nugs\.net/.test(navUrl)) {
            dlog('[ghost] did-navigate → nugs content — resuming scrape:', navUrl);
            isAuthenticating = false;
            armHardTimer(25_000);
            ghost.webContents.once('dom-ready', onDomReady);
          }
        });

        async function onDomReady() {
          if (settled || ac.signal.aborted) return;
          let currentUrl = '';
          try { currentUrl = ghost.isDestroyed() ? '' : (ghost.webContents.getURL() ?? ''); }
          catch { return; }

          if (LOGIN_URL_RE.test(currentUrl)) {
            console.warn('[ghost] dom-ready on auth/challenge page — hard timer will expire:', currentUrl);
            isAuthenticating = true;
            return;
          }
          isAuthenticating = false;

          const isStash = /\/library\/|\/stash|my-library|my-stash|my-collection/i.test(currentUrl);

          if (/browse\/artists/i.test(currentUrl)) {
            const snap = await ghostEval('document.documentElement.outerHTML');
            settle(snap ? { ok: true, html: snap } : { ok: false, error: 'browse-artists snapshot failed' });
            return;
          }

          await ghostEval('window.scrollTo(0, document.body.scrollHeight);');
          dlog('[ghost] initial scroll:', currentUrl);

          await ghostEval(`
            (function() {
              var LABELS = ['view all', 'a-z', 'browse all', 'all artists', 'see all'];
              var btn = Array.from(document.querySelectorAll('a,button')).find(function(el) {
                var t = el.textContent.trim().toLowerCase();
                return LABELS.some(function(l) { return t === l || t.startsWith(l); });
              });
              if (btn) { btn.click(); dlog('[ghost] clicked:', btn.textContent.trim()); }
            })()
          `);

          await abortableSleep(3000);
          if (settled || ac.signal.aborted) return;

          const POLL_MAX  = 10_000;
          const MIN_FOUND = isStash ? 3 : 6;
          let   elapsed   = 0;

          while (elapsed < POLL_MAX) {
            if (settled || ac.signal.aborted) return;

            if (isAuthenticating) {
              await abortableSleep(1000);
              elapsed = 0;
              continue;
            }

            const pollMs = jitter(400, 800);
            await abortableSleep(pollMs);
            elapsed += pollMs;
            if (settled || ac.signal.aborted) return;

            if (!ghost || ghost.isDestroyed()) {
              settle({ ok: false, error: 'ghost window destroyed during poll' });
              return;
            }

            const found = await ghostEval(`
              (function() {
                var watchCards = document.querySelectorAll(
                  '[class*="ShowCard"],[class*="show-card"],[class*="ContentCard"],[class*="content-card"]'
                ).length;
                var artistLinks = document.querySelectorAll(
                  'a[href*="/artist/"],a[href*="/browse/artists/"],.artist-name'
                ).length;
                var libItems = document.querySelectorAll(
                  '[class*="LibraryItem"],[class*="library-item"],' +
                  '.stash-grid-item,.grid-artist-name,.showtitle-st'
                ).length;
                return Math.max(watchCards, artistLinks, libItems);
              })()
            `);

            dlog('[ghost] poll', elapsed + 'ms —', (found ?? 0), '(need ' + MIN_FOUND + ')');

            if ((found ?? 0) >= MIN_FOUND) {
              if (isStash) {
                armHardTimer(120_000);
                dlog('[ghost] stash: starting scroll+harvest');

                const stashJson = await ghostEval(`
                  (function() {
                    var PLAY_BASE = 'https://play.nugs.net';
                    return new Promise(function(resolve) {
                      var all = new Map();
                      function harvest() {
                        var ITEM_SEL = [
                          '.stash-grid-item',
                          '[class*="LibraryItem"]', '[class*="library-item"]',
                          '[class*="ShowCard"]',    '[class*="show-card"]',
                          '[class*="ContentCard"]', '[class*="content-card"]',
                        ].join(',');
                        document.querySelectorAll(ITEM_SEL).forEach(function(item) {
                          var a    = item.querySelector('a[href]');
                          var href = a ? (a.getAttribute('href') || '') : '';
                          if (!href) return;
                          var key  = href.split('?')[0];
                          if (all.has(key)) return;
                          var abs  = href.startsWith('http') ? href : PLAY_BASE + (href.startsWith('/') ? href : '/' + href);
                          var q    = function(sel) { var el = item.querySelector(sel); return el ? el.textContent.trim() : ''; };
                          var img  = item.querySelector('img');
                          var title  = q('[class*="title"],[class*="Title"]') || q('.showtitle-st') || q('[class*="name"],[class*="Name"]');
                          var artist = q('[class*="artist"],[class*="Artist"]') || q('.grid-artist-name');
                          var date   = q('[class*="date"],[class*="Date"],time') || q('.grid-launch-date');
                          var venue  = q('[class*="venue"],[class*="Venue"]') || q('.grid-venue');
                          all.set(key, {
                            title:    title || artist,
                            artist:   artist,
                            date:     date,
                            venue:    venue,
                            imageUrl: img ? (img.src || img.dataset.src || '') : '',
                            linkUrl:  abs,
                            isLive:   false,
                          });
                        });
                      }
                      function findLoadMore() {
                        return Array.from(document.querySelectorAll('button,a[role="button"],a'))
                          .find(function(el) {
                            var t = (el.textContent || '').trim().toLowerCase();
                            return t === 'load more' || t === 'view more' || t.startsWith('load more');
                          }) || null;
                      }
                      function isAtBottom() {
                        return window.scrollY + window.innerHeight >=
                               document.documentElement.scrollHeight - 10;
                      }
                      function nextStep() {
                        return Math.max(
                          Math.floor(window.innerHeight / 2) + Math.floor(Math.random() * 120) - 60,
                          200
                        );
                      }
                      function rnd(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
                      var cooldown = false;
                      function tick() {
                        harvest();
                        if (isAtBottom()) {
                          if (cooldown) { setTimeout(tick, rnd(200, 500)); return; }
                          var btn = findLoadMore();
                          if (btn) {
                            dlog('[ghost-stash] clicking Load More — harvested so far:', all.size);
                            btn.click();
                            cooldown = true;
                            new Promise(function(res) {
                              var debounce = null;
                              function reset() { clearTimeout(debounce); debounce = setTimeout(res, rnd(400, 700)); }
                              var ob = new MutationObserver(reset);
                              ob.observe(document.body, { childList: true, subtree: true });
                              reset();
                              setTimeout(function() { ob.disconnect(); clearTimeout(debounce); res(); }, 2000);
                            }).then(function() {
                              cooldown = false;
                              harvest();
                              window.scrollBy(0, nextStep());
                              setTimeout(tick, rnd(200, 500));
                            });
                          } else {
                            harvest();
                            dlog('[ghost-stash] harvest complete:', all.size, 'items');
                            resolve(JSON.stringify(Array.from(all.values())));
                          }
                          return;
                        }
                        window.scrollBy(0, nextStep());
                        setTimeout(tick, rnd(200, 500));
                      }
                      window.scrollTo(0, 0);
                      setTimeout(tick, rnd(400, 700));
                    });
                  })()
                `);

                if (settled || ac.signal.aborted) return;
                let stashItems = null;
                try { if (stashJson) stashItems = JSON.parse(stashJson); }
                catch (e) { console.warn('[ghost] stash JSON parse failed:', e.message); }

                if (stashItems?.length > 0) {
                  dlog(`[ghost] stash harvest: ${stashItems.length} items`);
                  settle({ ok: true, html: '', stashItems });
                } else {
                  console.warn('[ghost] stash scroll+harvest got 0 items — falling back to HTML');
                  const snapHtml = await ghostEval('document.documentElement.outerHTML');
                  settle(snapHtml ? { ok: true, html: snapHtml } : { ok: false, error: 'stash harvest failed' });
                }
                return;
              }

              await ghostEval('window.scrollTo(0, document.body.scrollHeight);');
              await abortableSleep(500);
              const html = await ghostEval('document.documentElement.outerHTML');
              settle(html ? { ok: true, html } : { ok: false, error: 'outerHTML empty' });
              return;
            }

            if ((found ?? 0) < 4 && elapsed >= 4000 && elapsed < 4500) {
              await ghostEval('window.scrollTo(0, document.body.scrollHeight);');
              await abortableSleep(2000);
              await ghostEval('window.scrollTo(0, document.body.scrollHeight);');
              await abortableSleep(2000);
            }
          }

          console.warn('[ghost] poll exhausted — snapshotting:', currentUrl);
          const html = await ghostEval('document.documentElement.outerHTML');
          settle(html ? { ok: true, html } : { ok: false, error: 'poll exhausted, empty snapshot' });
        }

        ghost.webContents.on('did-fail-load', (_ev, errCode, errDesc, failedUrl) => {
          if (settled) return;
          if (errCode === -3) return;
          console.warn(`[ghost] did-fail-load: ${errDesc} (${errCode}) for ${failedUrl}`);
          settle({ ok: false, error: `${errDesc} (${errCode}) loading '${failedUrl}'` });
        });

        ghost.webContents.once('dom-ready', onDomReady);
        ghost.loadURL(url).catch(e => settle({ ok: false, error: e.message }));
      });
    } catch (err) {
      console.error('[ghost] setup error:', err);
      return { ok: false, error: err.message };
    } finally {
      _scraping = false;
    }
  });
}

/* ── IPC: extract-nugs-stream ─────────────────────────────────────────────────
 * HLS m3u8 extraction for play.nugs.net /watch/ pages — left functionally
 * untouched for the v1.7 stabilisation pass except for cooperating with the
 * shared ghost lifecycle. It does NOT use the AbortController/CDP capture
 * because its happy path is "first .m3u8 we sniff wins" — adding the same
 * scaffolding for one short-lived listener would be over-engineered.
 * ─────────────────────────────────────────────────────────────────────────── */

function registerExtractStreamHandler() {
  ipcMain.handle('extract-nugs-stream', async (_e, url) => {
    if (!url) return { ok: false, error: 'no URL provided' };
    if (_scraping) return { ok: false, error: 'ghost scraper busy — try again shortly' };
    if (!url.startsWith('https://play.nugs.net') && !url.startsWith('https://www.nugs.net')) {
      return { ok: false, error: 'Invalid domain' };
    }
    _scraping = true;

    const PLAY_BASE = 'https://play.nugs.net';
    let _sniffResolve = null;

    try {
      const ghost       = ensureGhost();
      const nugsSession = ghost.webContents.session;

      dlog('[ghost-stream] resetting ghost on /home…');
      await new Promise(r => {
        const guard = setTimeout(r, 6000);
        ghost.webContents.once('dom-ready', () => { clearTimeout(guard); r(); });
        ghost.webContents.loadURL(`${PLAY_BASE}/home`).catch(() => { clearTimeout(guard); r(); });
      });
      await new Promise(r => setTimeout(r, 800));

      const sniffPromise = new Promise(resolve => { _sniffResolve = resolve; });
      nugsSession.webRequest.onBeforeRequest(
        { urls: ['*://*/*'] },
        (details, callback) => {
          const u = details.url;
          if (u.includes('.m3u8') && !u.includes('hls.js') && _sniffResolve) {
            dlog('[ghost-stream] sniffed m3u8:', u.slice(0, 120));
            _sniffResolve(u);
            _sniffResolve = null;
          }
          callback({});
        }
      );

      dlog('[ghost-stream] navigating to', url);
      await new Promise(r => {
        const guard = setTimeout(r, 8000);
        ghost.webContents.once('dom-ready', () => { clearTimeout(guard); r(); });
        ghost.webContents.loadURL(url).catch(() => { clearTimeout(guard); r(); });
      });
      await new Promise(r => setTimeout(r, 3000));

      await ghost.webContents.executeJavaScript(`
        (function() {
          var playBtn = document.querySelector(
            'button[aria-label*="play" i], button[title*="play" i],' +
            '[class*="PlayButton"],[class*="play-button"],[class*="playBtn"],' +
            '[class*="PlayBtn"],[class*="play_btn"],[data-testid*="play"],' +
            'button[class*="play"], .play-btn, .btn-play, [class*="playerPlay"]'
          );
          if (playBtn) {
            dlog("[ghost-stream] clicking play:", playBtn.className || playBtn.getAttribute("aria-label"));
            playBtn.click();
            return "clicked:" + (playBtn.className || "play");
          }
          var vid = document.querySelector("video");
          if (vid) { vid.play().catch(function(){}); return "video.play()"; }
          return "no-play-btn";
        })()
      `).catch(() => null);

      await new Promise(r => setTimeout(r, 1500));

      const extracted = await ghost.webContents.executeJavaScript(`
        (function() {
          try {
            var st = window.__INITIAL_STATE__ || window.__PRELOADED_STATE__ || window.__NEXT_DATA__;
            if (st) {
              var flat = typeof st === 'string' ? st : JSON.stringify(st);
              var hit  = flat.match(/https?:[^"\\\\]*\\.m3u8[^"\\\\\\s]*/);
              if (hit) return hit[0].replace(/\\\\\\/g, '/');
            }
            var scripts = Array.from(document.querySelectorAll('script'))
                            .map(function(s){ return s.textContent; }).join('\\n');
            var m = scripts.match(/["'\`](https?:\\/\\/[^"'\`\\s]*\\.m3u8[^"'\`\\s]*)/);
            if (m) return m[1];
            var html = document.documentElement.innerHTML;
            var m2   = html.match(/https?:\\/\\/[^\\s"'<>]*\\.m3u8[^\\s"'<>]*/);
            return m2 ? m2[0] : null;
          } catch(e) { return null; }
        })()
      `).catch(() => null);

      if (extracted?.includes('.m3u8')) {
        dlog('[ghost-stream] JS-extracted:', extracted.slice(0, 100));
        return { ok: true, m3u8: extracted };
      }

      const sniffed = await Promise.race([
        sniffPromise,
        new Promise(r => setTimeout(() => r(null), 8000)),
      ]);
      _sniffResolve = null;

      if (sniffed) return { ok: true, m3u8: sniffed };
      return { ok: false, error: 'Stream URL not found — a Nugs subscription may be required' };
    } catch (err) {
      console.error('[ghost-stream] error:', err.message);
      return { ok: false, error: err.message };
    } finally {
      _scraping = false;
      try { _ghostWin?.webContents.session.webRequest.onBeforeRequest(null); } catch {}
    }
  });
}

/* ── Public API ─────────────────────────────────────────────────────────────── */

function initNugsScraper() {
  registerInjectHandler();
  registerScrapeHandler();
  registerExtractStreamHandler();
}

function destroyGhostOnQuit() {
  try {
    if (_ghostWin && !_ghostWin.isDestroyed()) _ghostWin.destroy();
  } catch { /* already gone */ }
  _ghostWin = null;
}

module.exports = { initNugsScraper, destroyGhostOnQuit };
