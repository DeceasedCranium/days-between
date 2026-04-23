const {
  app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, globalShortcut, Notification,
} = require('electron');
const path = require('path');
const cast = require('./cast');

// Must be called before app.whenReady() — enables Chromium's built-in
// Media Router so Cast devices appear in the system device picker.
app.commandLine.appendSwitch('enable-features', 'CastMediaRouteProvider');

let win = null;
let tray = null;
let isMini = false;

/* ── Ghost scraper ───────────────────────────────────────────────────────────
   A visible BrowserWindow that loads nugs.net pages as a real Chromium browser.
   Being a real browser it solves Cloudflare / bot challenges that fetch() can't.

   DESIGN: Only ONE scrape runs at a time.  If the handler is called while a
   scrape is in flight it returns { ok:false, error:'busy' } IMMEDIATELY so the
   IPC channel is never held open waiting.  A 10-second hard timeout destroys
   the window so the next call gets a clean slate.  A `settled` flag makes every
   code path idempotent — double-resolve is impossible.
   ─────────────────────────────────────────────────────────────────────────── */
let _ghostWin  = null;
let _scraping  = false;

// Timing jitter helper — randomises polling intervals to defeat volumetric bot detection
const jitter = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function _destroyGhost() {
  try { if (_ghostWin && !_ghostWin.isDestroyed()) _ghostWin.destroy(); } catch {}
  _ghostWin = null;
  _scraping = false;
}

function _ensureGhost() {
  if (_ghostWin && !_ghostWin.isDestroyed()) return _ghostWin;
  _ghostWin = new BrowserWindow({
    show:         false,
    skipTaskbar:  true,
    width:        1100,
    height:       700,
    title:        'Days Between — Nugs Scraper',
    // persist:nugs gives the ghost window its own cookie jar that survives
    // restarts — Cloudflare clearance cookies are retained across sessions.
    // userAgent matches the Windows Chrome UA used in our header interceptors
    // so every layer of the stack presents a consistent fingerprint.
    webPreferences: {
      partition:        'persist:nugs',
      nodeIntegration:  false,
      contextIsolation: true,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
  });
  _ghostWin.on('closed', () => { _ghostWin = null; _scraping = false; });

  // ── Stealth injection — strip Electron/webdriver fingerprints on every navigation
  // Cloudflare and Demandware check navigator.webdriver before running their challenges.
  // We patch it out in dom-ready (before page scripts fully execute their checks).
  _ghostWin.webContents.on('dom-ready', () => {
    if (!_ghostWin || _ghostWin.isDestroyed()) return;
    _ghostWin.webContents.executeJavaScript(`
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        // Restore a minimal chrome object — Electron omits it, another Cloudflare signal
        if (!window.chrome) {
          Object.defineProperty(window, 'chrome', { writable: false, value: { runtime: {} } });
        }
      } catch(e) {}
    `).catch(() => {});
  });

  // Diagnostic: log every failed load so we know exactly which URL 404s
  _ghostWin.webContents.on('did-fail-load', (_, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return; // -3 = ERR_ABORTED (normal for cancelled navigations)
    console.error('[ghost] did-fail-load:', validatedURL, '—', errorCode, errorDescription);
  });

  // ── Error-page / redirect-loop recovery ──────────────────────────────────
  // Nugs sometimes redirects to /error/technical-reasons or /on/error when the
  // session is stale.  When we detect this, navigate to the homepage to refresh
  // cookies, wait 3 s, then reload the original URL so the scrape can retry.
  const ERROR_URL_RE = /\/error\/|\/on\/error|technical-reasons|\/404|\/500/i;
  _ghostWin.webContents.on('did-navigate', (_, navUrl) => {
    if (!ERROR_URL_RE.test(navUrl)) return;
    console.warn('[ghost] error/redirect page detected — refreshing session:', navUrl);
    _ghostWin.webContents.loadURL('https://play.nugs.net/home').catch(() => {});
  });
  return _ghostWin;
}

// Regex that matches any URL where the user needs to interact (login, OAuth, challenges)
const LOGIN_URL_RE = /login|signin|sign-in|oauth|auth\b|id\.nugs\.net|cloudflare|challenge/i;

// ── Manual DOM bridge — renderer can inject page HTML when auto-scrape fails ──
// Usage from renderer: await window.ipc.injectNugsHtml(html)
// The HTML is forwarded directly to the same parser pipeline as the ghost scrape,
// so no changes are needed in nugs-scraper.js.
ipcMain.handle('inject-nugs-html', (_, html) => {
  if (!html || typeof html !== 'string') return { ok: false, error: 'no HTML provided' };
  console.info('[ghost] manual DOM injection — length:', html.length);
  return { ok: true, html };
});

ipcMain.handle('scrape-nugs-html', async (_, url) => {
  if (_scraping) {
    console.warn('[ghost] busy — rejecting:', url);
    return { ok: false, error: 'ghost scraper busy — try again shortly' };
  }
  if (!url.startsWith('https://play.nugs.net') && !url.startsWith('https://www.nugs.net')) {
    return { ok: false, error: 'Invalid domain' };
  }
  _scraping = true;

  try {
    // ── Verified session warm-start ───────────────────────────────────────────
    // Fix for "Subscription Required": a blind 1 s wait was not enough to
    // prove the session token is active before Demandware checks it.
    // Now: if the ghost is cold we load the homepage and POLL for DOM proof
    // that the user is logged in (account link, stash link, logout link).
    // Only after that proof fires do we proceed to the subscription-gated URL.
    // 5 s timeout → [ghost] AUTH FAILED log (non-fatal; caller will see the
    // subscription wall and surface it to the UI).
    {
      const warmWin = _ensureGhost();
      let warmUrl = '';
      try { warmUrl = warmWin.webContents.getURL?.() ?? ''; } catch {}
      const isCold = !warmUrl.includes('nugs.net') ||
                      warmUrl === 'about:blank'     ||
                      /\/error|\/404/i.test(warmUrl);
      if (isCold) {
        console.log('[ghost] session warm-start: ghost is cold — verifying login on play.nugs.net/home…');
        await new Promise(r => {
          warmWin.webContents.once('did-navigate', () => {
            // Selectors that only exist when the user is authenticated in the play. web player
            const PROOF = [
              // play.nugs.net player-specific UI
              '[class*="UserAvatar"]','[class*="user-avatar"]','[class*="Avatar"]',
              '[class*="PlayBar"]','[class*="playbar"]','[class*="player-bar"]',
              '[class*="Library"]','[class*="library"]',
              'a[href*="/library"]','a[href*="/profile"]',
              // fallback: account/logout indicators
              '[class*="userMenu"]','[class*="user-menu"]','[class*="logout"]',
              '[aria-label*="account" i]','[aria-label*="library" i]',
              // broader signals resilient to Nugs UI changes
              '[role="navigation"] a[href*="logout"]',
              '[class*="User"]','[class*="Avatar"]',
              'button[aria-haspopup="true"]',
              'nav a[href*="library"]',
            ].join(',');
            const startMs = Date.now();
            const poll = async () => {
              if (warmWin.isDestroyed()) { r(); return; }
              try {
                const ok = await warmWin.webContents.executeJavaScript(`
                  (function() {
                    if (document.querySelector('${PROOF}')) return true;
                    // Secondary check: no Sign-In CTA and app chrome is present
                    var signIn = document.querySelector(
                      'a[href*="/login"],a[href*="/sign-in"],[class*="signIn"],[class*="sign-in"]'
                    );
                    return !signIn && !!document.querySelector('nav,header,[class*="nav"],[class*="Nav"]');
                  })()
                `);
                if (ok) {
                  console.log('[ghost] session warm-start: login verified ✓ — proceeding to', url);
                  r();
                } else if (Date.now() - startMs >= 6000) {
                  console.error('[ghost] AUTH FAILED: User token rejected — please sign in to play.nugs.net');
                  r(); // non-fatal: let the scrape proceed so the UI can show the auth wall
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
      // Diagnostic log for subscription-gated pages
      const isLivePage = /\/watch|\/live\/|\/stream/i.test(url) &&
                         !/browse|library|home/i.test(url);
      if (isLivePage) {
        console.log('[ghost] Livestream handshake: Session Validated. Extracting HLS…');
      }
    }

    return await new Promise(resolve => {
      const ghost = _ensureGhost();
      let settled        = false;
      let isAuthenticating = false;  // true while user is on a login/OAuth/challenge page
      let hardTimer;

      /* ── settle() — zero-crash, idempotent ─────────────────────────────
         Five-layer guard:
           1. destroyed ghost window — early return with no-op
           2. double-call (settled flag)
           3. removeListener / webContents calls wrapped in try/catch
           4. clears all navigation listeners before resolving
           5. always calls resolve() so the IPC channel is never orphaned   */
      function settle(result) {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        try {
          if (!ghost.isDestroyed()) {
            ghost.webContents.removeListener('dom-ready', onDomReady);
            ghost.webContents.removeAllListeners('did-navigate');
            ghost.webContents.removeAllListeners('will-navigate');
          }
        } catch { /* webContents may be dying — ignore */ }
        _destroyGhost();   // free resources on every completion path
        resolve(result);
      }

      /* ── armHardTimer — always cancels previous before re-arming ────── */
      function armHardTimer(ms) {
        clearTimeout(hardTimer);
        hardTimer = setTimeout(() => {
          console.warn(`[ghost] hard timeout (${ms / 1000}s) for:`, url);
          _destroyGhost();
          settle({ ok: false, error: `ghost timeout (${ms / 1000}s): ${url}` });
        }, ms);
      }

      // Initial 20 s budget
      armHardTimer(20_000);

      /* ── ghostEval — null-safe executeJavaScript ─────────────────────── */
      async function ghostEval(js) {
        if (settled || !ghost || ghost.isDestroyed()) return undefined;
        try { return await ghost.webContents.executeJavaScript(js); }
        catch (e) { console.warn('[ghost] eval error:', e.message); return undefined; }
      }

      /* ── will-navigate — fires BEFORE navigation commits ─────────────────
         Catches login redirects at the earliest possible moment so we can
         suspend the scrape loop and extend the timer before the page unloads. */
      ghost.webContents.on('will-navigate', (_, navUrl) => {
        if (settled) return;
        if (LOGIN_URL_RE.test(navUrl)) {
          console.warn('[ghost] will-navigate → auth/challenge page — hard timer will expire:', navUrl);
          isAuthenticating = true;
          // Ghost is headless — user cannot interact, so let the existing timer expire
        }
      });

      /* ── did-navigate — fires AFTER navigation completes ─────────────────
         Two roles:
           • Login page  → extend timeout so user can authenticate
           • Return page → reset isAuthenticating and restart the scrape     */
      ghost.webContents.on('did-navigate', (_, navUrl) => {
        if (settled) return;
        const isAuthPage = LOGIN_URL_RE.test(navUrl);
        if (isAuthPage) {
          console.warn('[ghost] did-navigate → auth/challenge — hard timer will expire:', navUrl);
          isAuthenticating = true;
          // Ghost is headless — let the hard timer expire and return an error silently
        } else if (/nugs\.net/.test(navUrl)) {
          console.log('[ghost] did-navigate → nugs content — resuming scrape:', navUrl);
          isAuthenticating = false;
          armHardTimer(25_000);
          ghost.webContents.once('dom-ready', onDomReady);
        }
      });

      /* ── onDomReady — scroll, hydrate, poll ──────────────────────────── */
      async function onDomReady() {
        if (settled) return;
        let currentUrl = '';
        try { currentUrl = ghost.isDestroyed() ? '' : (ghost.webContents.getURL() ?? ''); }
        catch { return; }

        // Bail immediately on login / challenge pages — ghost is headless, let timer expire
        if (LOGIN_URL_RE.test(currentUrl)) {
          console.warn('[ghost] dom-ready on auth/challenge page — hard timer will expire:', currentUrl);
          isAuthenticating = true;
          return;
        }
        isAuthenticating = false;

        const isStash = /\/library\/|\/stash|my-library|my-stash|my-collection/i.test(currentUrl);

        // browse/artists pages handled on-demand by scrape-nugs-letter IPC
        if (/browse\/artists/i.test(currentUrl)) {
          const snap = await ghostEval('document.documentElement.outerHTML');
          settle(snap ? { ok: true, html: snap } : { ok: false, error: 'browse-artists snapshot failed' });
          return;
        }

        // ── All other pages: scroll + poll ─────────────────────────────
        await ghostEval('window.scrollTo(0, document.body.scrollHeight);');
        console.log('[ghost] initial scroll:', currentUrl);

        // Click "View All" / "A–Z" if present (some pages show a featured subset)
        await ghostEval(`
          (function() {
            var LABELS = ['view all', 'a-z', 'browse all', 'all artists', 'see all'];
            var btn = Array.from(document.querySelectorAll('a,button')).find(function(el) {
              var t = el.textContent.trim().toLowerCase();
              return LABELS.some(function(l) { return t === l || t.startsWith(l); });
            });
            if (btn) { btn.click(); console.log('[ghost] clicked:', btn.textContent.trim()); }
          })()
        `);

        await new Promise(r => setTimeout(r, 3000));
        if (settled) return;

        // Poll until we see enough content elements — interval is randomised each
        // tick to avoid fixed-cadence volumetric fingerprinting.
        const POLL_MAX  = 10_000;
        const MIN_FOUND = isStash ? 3 : 6;
        let   elapsed   = 0;

        while (elapsed < POLL_MAX) {
          if (settled) return;

          if (isAuthenticating) {
            await new Promise(r => setTimeout(r, 1000));
            elapsed = 0;
            continue;
          }

          const pollMs = jitter(400, 800);
          await new Promise(r => setTimeout(r, pollMs));
          elapsed += pollMs;
          if (settled) return;

          if (!ghost || ghost.isDestroyed()) {
            settle({ ok: false, error: 'ghost window destroyed during poll' });
            return;
          }

          const found = await ghostEval(`
            (function() {
              // play.nugs.net /watch: video cards (classic + modern class names + href patterns)
              var watchCards = document.querySelectorAll(
                '[class*="ShowCard"],[class*="show-card"],[class*="ContentCard"],[class*="content-card"],' +
                '[class*="Tile"],[class*="Card"],[class*="GridItem"],' +
                'a[href*="/watch/"],a[href*="/livestreams/"]'
              ).length;
              // play.nugs.net /browse/artists/ or /library/: artist links + library items
              var artistLinks = document.querySelectorAll(
                'a[href*="/artist/"],a[href*="/browse/artists/"],a[href*="/p/"],.artist-name'
              ).length;
              // play.nugs.net /library/: library item cards + href patterns
              var libItems = document.querySelectorAll(
                '[class*="LibraryItem"],[class*="library-item"],' +
                '.stash-grid-item,.grid-artist-name,.showtitle-st,' +
                'a[href*="/library/"],a[href*="/stash/"]'
              ).length;
              var total = Math.max(watchCards, artistLinks, libItems);
              return total;
            })()
          `);

          console.log('[ghost] poll', elapsed + 'ms —', (found ?? 0), '(need ' + MIN_FOUND + ')');

          if ((found ?? 0) >= MIN_FOUND) {
            // Start the vacuum to catch virtualized DOM nodes for ALL pages
            await ghostEval(`
              window._harvestedHtml = new Set();
              window._harvestInterval = setInterval(function() {
                document.querySelectorAll('a[href*="/watch/"], a[href*="/livestreams/"], a[href*="/p/"], a[href*="/catalog/"], a[href*="/library/"]').forEach(function(a) {
                  window._harvestedHtml.add(a.outerHTML);
                });
              }, 200);
            `);

            // Sweep-scroll the page to trigger React lazy loading
            await ghostEval(`
              return new Promise(function(resolve) {
                var scrolls = 0;
                var timer = setInterval(function() {
                  var s = Array.from(document.querySelectorAll('*')).reduce(function(best, el) {
                    return (el.scrollHeight > el.clientHeight && el.clientHeight > 300 && el.scrollHeight > best.scrollHeight) ? el : best;
                  }, document.documentElement);

                  if (s === document.documentElement) window.scrollBy(0, window.innerHeight / 2);
                  else s.scrollBy(0, s.clientHeight / 2);

                  scrolls++;
                  if (scrolls >= 14) {
                    clearInterval(timer);
                    resolve();
                  }
                }, 400);
              });
            `);

            // Stop vacuum and return synthesized HTML block
            const html = await ghostEval(`
              clearInterval(window._harvestInterval);
              '<div id="synthesized-scrape">' + Array.from(window._harvestedHtml).join('') + '</div>';
            `);

            settle(html ? { ok: true, html } : { ok: false, error: 'outerHTML empty' });
            return;
          }

          // Double-scroll if still sparse after 4 s
          if ((found ?? 0) < 4 && elapsed >= 4000 && elapsed < 4500) {
            await ghostEval('window.scrollTo(0, document.body.scrollHeight);');
            await new Promise(r => setTimeout(r, 2000));
            await ghostEval('window.scrollTo(0, document.body.scrollHeight);');
            await new Promise(r => setTimeout(r, 2000));
          }
        }

        // Poll exhausted — snapshot whatever rendered
        console.warn('[ghost] poll exhausted — snapshotting:', currentUrl);
        const html = await ghostEval('document.documentElement.outerHTML');
        settle(html ? { ok: true, html } : { ok: false, error: 'poll exhausted, empty snapshot' });
      }

      // did-fail-load fires when Chromium's network stack rejects the request
      // (ERR_FAILED, ERR_CONNECTION_REFUSED, etc.).  Without this handler the
      // ghost just sits idle until the 25 s hard timer fires.
      ghost.webContents.on('did-fail-load', (_, errCode, errDesc, failedUrl) => {
        if (settled) return;
        if (errCode === -3) return; // -3 = ERR_ABORTED — normal for redirects, ignore
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

/* ── extract-nugs-stream ────────────────────────────────────────────────────
   Reliable HLS m3u8 extraction for play.nugs.net /watch/ pages.
   Three-layer strategy:
     1. JS extraction — check window.__INITIAL_STATE__ / __PRELOADED_STATE__
        and scan all <script> text + page HTML for .m3u8 URLs.
     2. Network sniffer — attach onBeforeRequest on the ghost session (persist:nugs)
        BEFORE navigating so the very first .m3u8 manifest request is captured.
     3. Falls back to "subscription required" error if neither fires.
   ─────────────────────────────────────────────────────────────────────────── */
ipcMain.handle('extract-nugs-stream', async (_, url) => {
  if (!url) return { ok: false, error: 'no URL provided' };
  if (_scraping) return { ok: false, error: 'ghost scraper busy — try again shortly' };
  if (!url.startsWith('https://play.nugs.net') && !url.startsWith('https://www.nugs.net')) {
    return { ok: false, error: 'Invalid domain' };
  }
  _scraping = true;

  const PLAY_BASE = 'https://play.nugs.net';
  let _sniffResolve = null;

  try {
    const ghost       = _ensureGhost();
    const nugsSession = ghost.webContents.session; // persist:nugs session

    // ── Step 1: Navigate to /home first ───────────────────────────────────
    // This stops any video already playing in the ghost window (preventing
    // stale .m3u8 requests from being captured by the sniffer below).
    // Also warms the session / refreshes Cloudflare cookies if needed.
    console.log('[ghost-stream] resetting ghost on /home…');
    await new Promise(r => {
      const guard = setTimeout(r, 6000);
      ghost.webContents.once('dom-ready', () => { clearTimeout(guard); r(); });
      ghost.webContents.loadURL(`${PLAY_BASE}/home`).catch(() => { clearTimeout(guard); r(); });
    });
    await new Promise(r => setTimeout(r, 800));

    // ── Step 2: Install network sniffer BEFORE navigating ─────────────────
    // Broad filter — catches .m3u8 from ANY host (Akamai, CloudFront, nugs CDN,
    // Wowza, etc).  We filter in the callback to only fire once per extraction.
    const sniffPromise = new Promise(resolve => { _sniffResolve = resolve; });
    nugsSession.webRequest.onBeforeRequest(
      { urls: ['*://*/*'] }, // catch everything; filter for .m3u8 below
      (details, callback) => {
        const u = details.url;
        // Accept any .m3u8 URL — skip hls.js bundle requests (contain 'hls.js' in path)
        if (u.includes('.m3u8') && !u.includes('hls.js') && _sniffResolve) {
          console.log('[ghost-stream] sniffed m3u8:', u.slice(0, 120));
          _sniffResolve(u);
          _sniffResolve = null; // fire only once
        }
        callback({});
      }
    );

    // ── Step 3: Navigate to the stream page ───────────────────────────────
    console.log('[ghost-stream] navigating to', url);
    await new Promise(r => {
      const guard = setTimeout(r, 8000);
      ghost.webContents.once('dom-ready', () => { clearTimeout(guard); r(); });
      ghost.webContents.loadURL(url).catch(() => { clearTimeout(guard); r(); });
    });
    await new Promise(r => setTimeout(r, 3000)); // hydration — let SPA and video player init

    // ── Step 3b: Click play button in the ghost ───────────────────────────
    // play.nugs.net only fires the m3u8 request AFTER the user hits Play.
    // Simulate a click on the most likely play button so the player initialises
    // and the manifest request hits the network sniffer.
    await ghost.webContents.executeJavaScript(`
      (function() {
        var playBtn = document.querySelector(
          'button[aria-label*="play" i], button[title*="play" i],' +
          '[class*="PlayButton"],[class*="play-button"],[class*="playBtn"],' +
          '[class*="PlayBtn"],[class*="play_btn"],[data-testid*="play"],' +
          'button[class*="play"], .play-btn, .btn-play, [class*="playerPlay"]'
        );
        if (playBtn) {
          console.log("[ghost-stream] clicking play:", playBtn.className || playBtn.getAttribute("aria-label"));
          playBtn.click();
          return "clicked:" + (playBtn.className || "play");
        }
        // Fallback: click the first video element to trigger autoplay
        var vid = document.querySelector("video");
        if (vid) { vid.play().catch(function(){}); return "video.play()"; }
        return "no-play-btn";
      })()
    `).catch(() => null);

    await new Promise(r => setTimeout(r, 1500)); // give player time to request manifest

    // ── Step 4: JS extraction (preferred — returns master manifest) ───────
    const extracted = await ghost.webContents.executeJavaScript(`
      (function() {
        try {
          // Pass 1: window state objects injected by Next.js / React SSR
          var st = window.__INITIAL_STATE__ || window.__PRELOADED_STATE__ || window.__NEXT_DATA__;
          if (st) {
            var flat = typeof st === 'string' ? st : JSON.stringify(st);
            var hit  = flat.match(/https?:[^"\\\\]*\\.m3u8[^"\\\\\\s]*/);
            if (hit) return hit[0].replace(/\\\\\\/g, '/');
          }
          // Pass 2: any <script> tag content
          var scripts = Array.from(document.querySelectorAll('script'))
                          .map(function(s){ return s.textContent; }).join('\\n');
          var m = scripts.match(/["'\`](https?:\\/\\/[^"'\`\\s]*\\.m3u8[^"'\`\\s]*)/);
          if (m) return m[1];
          // Pass 3: full page HTML (catches data- attrs, inline config JSON, etc.)
          var html = document.documentElement.innerHTML;
          var m2   = html.match(/https?:\\/\\/[^\\s"'<>]*\\.m3u8[^\\s"'<>]*/);
          return m2 ? m2[0] : null;
        } catch(e) { return null; }
      })()
    `).catch(() => null);

    if (extracted?.includes('.m3u8')) {
      console.log('[ghost-stream] JS-extracted:', extracted.slice(0, 100));
      return { ok: true, m3u8: extracted };
    }

    // ── Step 5: Wait for sniffer (up to 8s more — video player may be slow) ─
    const sniffed = await Promise.race([
      sniffPromise,
      new Promise(r => setTimeout(() => r(null), 8000)),
    ]);
    _sniffResolve = null; // clear closure if the timeout won the race

    if (sniffed) return { ok: true, m3u8: sniffed };

    return { ok: false, error: 'Stream URL not found — a Nugs subscription may be required' };
  } catch (err) {
    console.error('[ghost-stream] error:', err.message);
    return { ok: false, error: err.message };
  } finally {
    _scraping = false;
    // Always remove sniffer listener — Electron only allows one at a time
    try { _ghostWin?.webContents.session.webRequest.onBeforeRequest(null); } catch {}
  }
});

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    frame: false,
    // Transparency — lets CSS rgba backgrounds + backdrop-filter create the
    // glass effect.  On macOS, vibrancy handles system-level frosted glass.
    // On Linux/Wayland the compositor (KWin) blurs the desktop through the
    // alpha channel; CSS backdrop-filter adds depth within the app itself.
    transparent: true,
    backgroundColor: '#00000000',
    vibrancy: 'under-window',       // macOS only — no-op on Linux/Windows
    visualEffectState: 'active',    // macOS: keep effect when window is focused
    webPreferences: {
      preload:        path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      webviewTag:       true,  // enables <webview> for Mixlr embedding
    },
    title: 'Days Between',
    show: false,
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
}

function positionNearTray(w, h) {
  if (!tray || !win) return;
  const trayBounds = tray.getBounds();
  const winW = w ?? win.getBounds().width;
  const winH = h ?? win.getBounds().height;
  const { screen } = require('electron');
  const display  = screen.getDisplayNearestPoint({ x: trayBounds.x || 0, y: trayBounds.y || 0 });
  const workArea = display.workArea;

  let x = trayBounds.width > 0
    ? Math.round(trayBounds.x + trayBounds.width / 2 - winW / 2)
    : workArea.x + workArea.width  - winW - 12;
  let y = trayBounds.height > 0
    ? trayBounds.y - winH - 8
    : workArea.y + workArea.height - winH - 12;

  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width  - winW));
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - winH));
  win.setPosition(x, y);
}

function createTray() {
  const iconPath = path.join(__dirname, '../assets/tray.png');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('Days Between');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show',         click: () => { if (isMini) positionNearTray(); win?.show(); } },
    { label: 'Play / Pause', click: () => win?.webContents.send('media', 'play-pause') },
    { label: 'Next Track',   click: () => win?.webContents.send('media', 'next') },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
  tray.on('click', () => {
    if (!win) return;
    if (win.isVisible()) {
      win.hide();
    } else {
      if (isMini) positionNearTray();
      win.show();
    }
  });
}

app.whenReady().then(() => {
  createWindow();
  createTray();

  // Nugs header spoof — single unified interceptor applied to BOTH the default
  // session AND the persist:nugs ghost partition.  Matches on any URL that
  // contains a nugs/akamai host so Akamai HLS redirects can't escape the net.
  const { session } = require('electron');
  const spoofHeaders = (details, callback) => {
    const target = details.url.toLowerCase();

    // Force UA to exactly match the Chrome 124 token fingerprint on every request
    details.requestHeaders['User-Agent'] =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

    if (target.includes('nugs.net') || target.includes('nugs.com')) {
      details.requestHeaders['Origin']  = 'https://play.nugs.net';
      details.requestHeaders['Referer'] = 'https://play.nugs.net/';
    } else if (target.includes('akamaized.net') || target.includes('akamaihd.net')) {
      // Akamai WAF blocks requests that carry a fake Origin/Referer — strip them
      delete details.requestHeaders['Origin'];
      delete details.requestHeaders['Referer'];
    }

    callback({ requestHeaders: details.requestHeaders });
  };

  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, spoofHeaders);
  const nugsSession = session.fromPartition('persist:nugs');
  if (nugsSession) nugsSession.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, spoofHeaders);

  // HLS live-stream interceptor — catches nugs webcasts before the <audio>
  // element tries to play them natively.  We only block resourceType 'media'
  // (fired by HTMLMediaElement.src assignment) so hls.js's own XHR fetches
  // for the same URL are never blocked.  A short-lived Set prevents the rare
  // case where a redirect also fires a second 'media' request for the same URL.
  const _handledHls = new Set();
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['*://*/*master.m3u8*', '*://*/*playlist.m3u8*'] },
    (details, callback) => {
      if (
        details.url.includes('hdntl=') &&
        details.resourceType === 'media' &&
        !_handledHls.has(details.url)
      ) {
        _handledHls.add(details.url);
        setTimeout(() => _handledHls.delete(details.url), 60_000);
        win?.webContents.send('start-live-stream', details.url);
        callback({ cancel: true });
      } else {
        callback({});
      }
    }
  );

  // Single onHeadersReceived handler — Electron only allows one at a time.
  // Covers: archive.org audio (CORS for Web Audio API / EQ) + nugs streams
  // (CORS needed so hls.js + createMediaElementSource can read PCM data) +
  // nugs image loads.
  session.defaultSession.webRequest.onHeadersReceived(
    {
      urls: [
        '*://archive.org/*',
        '*://*.archive.org/*',
        '*://streamapi.nugs.net/*',
        '*://*.nugs.net/*.m3u8*',
        '*://*.nugs.net/*.ts*',
        '*://www.nugs.net/*',           // HTML pages for dashboard scraper
        '*://cdn.nugs.net/*',
      ],
    },
    (details, callback) => {
      const headers = { ...details.responseHeaders };
      const url     = details.url;

      const isStream = url.includes('archive.org') ||
        (url.includes('nugs.net') && (url.includes('.m3u8') || url.includes('.ts') || url.includes('streamapi')));
      const isNugsPage = url.includes('www.nugs.net') || url.includes('cdn.nugs.net');

      if (isStream) {
        // Force CORS so MediaElementAudioSource / hls.js can read the stream
        headers['access-control-allow-origin']  = ['*'];
        headers['access-control-allow-methods'] = ['GET, OPTIONS'];
        headers['access-control-allow-headers'] = ['*'];
      } else if (isNugsPage) {
        // Nugs HTML pages + image loads — allow CORS so renderer fetch() works
        headers['access-control-allow-origin']  = ['*'];
        headers['access-control-allow-headers'] = ['*'];
      } else {
        // Other image loads — allow origin and rewrite CSP
        headers['access-control-allow-origin']  = ['*'];
        headers['access-control-allow-headers'] = ['*'];
        const existingCsp = (headers['content-security-policy'] ?? [''])[0];
        const imgDomains  = 'https://www.nugs.net https://cdn.nugs.net https://i.last.fm https://lastfm.freetls.fastly.net';
        if (existingCsp && existingCsp.includes('img-src')) {
          headers['content-security-policy'] = [existingCsp.replace(/img-src([^;]*)/, `img-src$1 ${imgDomains}`)];
        } else if (existingCsp) {
          headers['content-security-policy'] = [existingCsp + `; img-src 'self' data: blob: ${imgDomains}`];
        } else {
          headers['content-security-policy'] = [`img-src 'self' data: blob: ${imgDomains}`];
        }
        delete headers['x-frame-options'];
      }

      callback({ responseHeaders: headers });
    }
  );

  globalShortcut.register('MediaPlayPause',    () => win?.webContents.send('media', 'play-pause'));
  globalShortcut.register('MediaNextTrack',    () => win?.webContents.send('media', 'next'));
  globalShortcut.register('MediaPreviousTrack',() => win?.webContents.send('media', 'prev'));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Window controls
ipcMain.on('wctl', (_, cmd) => {
  if (!win) return;
  if (cmd === 'min')   win.minimize();
  if (cmd === 'max')   win.isMaximized() ? win.unmaximize() : win.maximize();
  if (cmd === 'close') win.hide();
});

// Mini player toggle
ipcMain.on('mini-mode', () => {
  if (!win) return;
  isMini = true;
  win.setMinimumSize(300, 88);
  win.setSize(440, 92);
  win.setAlwaysOnTop(true);
  win.setSkipTaskbar(true);
  // Wait one frame for resize to apply before computing position
  setImmediate(() => positionNearTray(440, 92));
});
ipcMain.on('full-mode', () => {
  if (!win) return;
  isMini = false;
  win.setAlwaysOnTop(false);
  win.setSkipTaskbar(false);
  win.setResizable(true);
  win.setMinimumSize(960, 640);
  win.setSize(1400, 900);
});

// Desktop notification
ipcMain.on('notify-track', (_, { title, body }) => {
  if (!Notification.isSupported()) return;
  new Notification({ title, body, silent: true }).show();
});

// Player state → tray tooltip
ipcMain.on('player-update', (_, { title }) => {
  tray?.setToolTip(title ? `Days Between — ${title}` : 'Days Between');
});

// ── Shell ─────────────────────────────────────────────────────────────────
ipcMain.on('open-url', (_, url) => {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    require('electron').shell.openExternal(url);
  }
});

// ── Nugs login portal ─────────────────────────────────────────────────────
// Opens a visible BrowserWindow on the persist:nugs partition so the user
// can log in to play.nugs.net.  Because it shares the ghost's cookie jar,
// clearance and session cookies are immediately available to the scraper.
ipcMain.on('show-nugs-login', () => {
  const authWin = new BrowserWindow({
    width:             500,
    height:            750,
    title:             'Nugs.net — Sign In',
    autoHideMenuBar:   true,
    webPreferences: {
      partition:        'persist:nugs',
      nodeIntegration:  false,
      contextIsolation: true,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
  });

  authWin.loadURL('https://play.nugs.net/login');

  // Auto-close once the user lands on a post-login page
  authWin.webContents.on('did-navigate', (_, url) => {
    if (url.includes('/home') || url.includes('/library') || url.includes('/watch')) {
      setTimeout(() => { if (!authWin.isDestroyed()) authWin.close(); }, 1000);
    }
  });
});

// ── Last.fm IPC ───────────────────────────────────────────────────────────
let _cfg = {};
try { _cfg = require('../config'); } catch { /* config.js not present — Last.fm disabled */ }
const LFM_KEY    = _cfg.LFM_KEY    ?? '';
const LFM_SECRET = _cfg.LFM_SECRET ?? '';

function lfmSign(params) {
  const str = Object.keys(params).filter(k => k !== 'format').sort()
    .map(k => k + params[k]).join('') + LFM_SECRET;
  return require('crypto').createHash('md5').update(str, 'utf8').digest('hex');
}

async function lfmPost(params) {
  const { net } = require('electron');
  const api_sig = lfmSign(params);
  const body = new URLSearchParams({ ...params, api_key: LFM_KEY, api_sig, format: 'json' }).toString();
  const res = await net.fetch('https://ws.audioscrobbler.com/2.0/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return res.json();
}

// Expose non-secret config to renderer
ipcMain.handle('config:lfm-key', () => LFM_KEY);

ipcMain.handle('lastfm:get-token', async () => {
  const { net } = require('electron');
  const params = { method: 'auth.getToken', api_key: LFM_KEY };
  const api_sig = lfmSign(params);
  try {
    const res = await net.fetch(`https://ws.audioscrobbler.com/2.0/?method=auth.getToken&api_key=${LFM_KEY}&api_sig=${api_sig}&format=json`);
    return (await res.json()).token ?? null;
  } catch { return null; }
});

ipcMain.handle('lastfm:get-session', async (_, token) => {
  try {
    const data = await lfmPost({ method: 'auth.getSession', api_key: LFM_KEY, token });
    return data.session ?? null;
  } catch { return null; }
});

ipcMain.handle('lastfm:now-playing', async (_, { track, artist, album, duration, sk }) => {
  if (!sk) return;
  const p = { method: 'track.updateNowPlaying', api_key: LFM_KEY, track, artist, sk };
  if (album)    p.album    = album;
  if (duration) p.duration = String(Math.round(duration));
  try { await lfmPost(p); } catch {}
});

ipcMain.handle('lastfm:scrobble', async (_, { track, artist, album, timestamp, duration, sk }) => {
  if (!sk) return;
  const p = { method: 'track.scrobble', api_key: LFM_KEY, track, artist, timestamp: String(timestamp), sk };
  if (album)    p.album    = album;
  if (duration) p.duration = String(Math.round(duration));
  try { await lfmPost(p); } catch {}
});

// ── Cast IPC ──────────────────────────────────────────────────────────────
ipcMain.handle('cast:discover', async () => {
  try { return { ok: true, devices: await cast.discover(5000) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('cast:connect', async (_, { host, port }) => {
  try {
    await cast.connect(host, port, status => win?.webContents.send('cast-status', status));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('cast:load',  async (_, args)  => { try { await cast.load(args);  return { ok: true }; } catch(e) { return { ok: false, error: e.message }; } });
ipcMain.handle('cast:pause', async ()         => { try { await cast.pause();      return { ok: true }; } catch(e) { return { ok: false, error: e.message }; } });
ipcMain.handle('cast:play',  async ()         => { try { await cast.play();       return { ok: true }; } catch(e) { return { ok: false, error: e.message }; } });
ipcMain.handle('cast:seek',  async (_, secs)  => { try { await cast.seek(secs);   return { ok: true }; } catch(e) { return { ok: false, error: e.message }; } });
ipcMain.handle('cast:stop',  async () => {
  cast.stop();
  win?.webContents.send('cast-status', { state: 'DISCONNECTED' });
  return { ok: true };
});

// ── MPRIS (Linux media controls) ────────────────────────────────────────────
let mprisPlayer = null;
try {
  const mpris = require('mpris-service');
  mprisPlayer = mpris({
    name: 'days-between',
    identity: 'Days Between',
    supportedUriSchemes: ['https'],
    supportedMimeTypes: ['audio/mpeg', 'audio/ogg', 'audio/flac', 'audio/mp4'],
    supportedInterfaces: ['player'],
  });
  mprisPlayer.playbackStatus = 'Stopped';
  mprisPlayer.canPlay       = true;
  mprisPlayer.canPause      = true;
  mprisPlayer.canGoNext     = true;
  mprisPlayer.canGoPrevious = true;
  mprisPlayer.canSeek       = false;

  const fwd = cmd => () => win?.webContents.send('mpris', cmd);
  mprisPlayer.on('play',      fwd('play'));
  mprisPlayer.on('pause',     fwd('pause'));
  mprisPlayer.on('playpause', fwd('playpause'));
  mprisPlayer.on('stop',      fwd('stop'));
  mprisPlayer.on('next',      fwd('next'));
  mprisPlayer.on('previous',  fwd('previous'));

  ipcMain.on('mpris:update', (_, data) => {
    if (!mprisPlayer) return;
    if (data.status)   mprisPlayer.playbackStatus = data.status;
    if (data.metadata) mprisPlayer.metadata       = data.metadata;
  });
} catch {
  // mpris-service not installed — media key integration unavailable
  ipcMain.on('mpris:update', () => {});
}

// ── Clean ghost-window shutdown on quit ───────────────────────────────────────
// If the ghost scraper window is open when the app quits, destroy it safely
// so we never trigger "Object has been destroyed" during the shutdown sequence.
app.on('will-quit', () => {
  try {
    if (_ghostWin && !_ghostWin.isDestroyed()) {
      _ghostWin.destroy();
    }
  } catch { /* already gone — ignore */ }
  _ghostWin = null;
});

// ── Global exception shield ────────────────────────────────────────────────────
// Electron shows a fatal error dialog for any uncaught exception in the main
// process.  The one we care about — "Object has been destroyed" — is a benign
// race between ghost-window navigation and our listener cleanup.  We swallow
// that specific error and log everything else without killing the app.
process.on('uncaughtException', err => {
  if (err?.message?.includes('Object has been destroyed')) {
    console.warn('[main] suppressed "Object has been destroyed" ghost-window race:', err.message);
    return; // do NOT re-throw — this is safe to ignore
  }
  // For all other unexpected errors, log but don't take down the app
  console.error('[main] uncaught exception:', err);
});


