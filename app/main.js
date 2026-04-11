const {
  app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, globalShortcut, Notification,
} = require('electron');
const path = require('path');
const cast = require('./cast');

let win = null;
let tray = null;
let isMini = false;

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    frame: false,
    backgroundColor: '#0d0f14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
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

  // Nugs.net CORS fix — inject required headers for nugs API/stream requests only
  const { session } = require('electron');
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['*://streamapi.nugs.net/*', '*://id.nugs.net/*', '*://subscriptions.nugs.net/*'] },
    (details, callback) => {
      const url = details.url;
      if (url.includes('bigriver/') || url.includes('bigriver')) {
        details.requestHeaders['User-Agent'] = 'nugsnetAndroid';
      } else {
        details.requestHeaders['User-Agent'] = 'NugsNet/3.26.724 (Android; 7.1.2; Asus; ASUS_Z01QD; Scale/2.0; en)';
      }
      details.requestHeaders['Origin'] = 'https://play.nugs.net';
      details.requestHeaders['Referer'] = 'https://play.nugs.net/';
      callback({ requestHeaders: details.requestHeaders });
    }
  );

  // Allow nugs.net image loads — loosen CORS on image responses
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['*://www.nugs.net/images/*', '*://cdn.nugs.net/images/*'] },
    (details, callback) => {
      const headers = { ...details.responseHeaders };
      headers['access-control-allow-origin']  = ['*'];
      headers['access-control-allow-headers'] = ['*'];
      // Rewrite CSP to allow specific image domains rather than deleting the policy
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
ipcMain.on('open-url', (_, url) => require('electron').shell.openExternal(url));

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

// Image proxy — fetch image from main process via net.request (bypasses renderer CORS)
ipcMain.handle('fetch-image', (_, url, bearerToken) => {
  const { net } = require('electron');
  return new Promise(resolve => {
    try {
      const req = net.request({ url, redirect: 'follow' });
      req.setHeader('User-Agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36');
      req.setHeader('Referer', 'https://www.nugs.net/');
      if (bearerToken) req.setHeader('Authorization', `Bearer ${bearerToken}`);
      req.on('redirect', () => req.followRedirect());
      req.on('response', res => {
        if (res.statusCode < 200 || res.statusCode >= 300) { resolve(null); return; }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (buf.length < 500) { resolve(null); return; } // reject placeholder GIFs
          const mime = [].concat(res.headers['content-type'] ?? [])[0] ?? 'image/jpeg';
          resolve(`data:${mime};base64,${buf.toString('base64')}`);
        });
      });
      req.on('error', err => { console.error('[fetch-image]', err.message); resolve(null); });
      req.end();
    } catch (e) {
      console.error('[fetch-image] catch:', e.message); resolve(null);
    }
  });
});
