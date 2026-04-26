/* ── utils.js — shared helpers, no dependencies ─── */

export const $ = (id) => document.getElementById(id);

export const fmt = (secs) => {
  if (!secs || isNaN(secs)) return '0:00';
  return `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;
};

export const stars = (r) => r ? `★ ${r.toFixed(1)}` : '';

export const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Infer a MIME type from a stream URL for Chromecast
export function castContentType(url) {
  const u = (url ?? '').split('?')[0].toLowerCase();
  if (u.endsWith('.m3u8')) return 'application/x-mpegURL';
  if (u.endsWith('.flac')) return 'audio/flac';
  if (u.endsWith('.m4a'))  return 'audio/mp4';
  if (u.endsWith('.mp4') || u.endsWith('.m4v')) return 'video/mp4';
  return 'audio/mpeg';
}

// Deterministic hue from a string — used for art placeholders
export function artistColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return `hsl(${Math.abs(h) % 360}, 45%, 28%)`;
}

// Toast notification
let toastTimer = null;
export function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('visible'), 2200);
}

/**
 * Custom confirm dialog with optional "Don't show again" checkbox.
 * Resolves to { ok: boolean, skipFuture: boolean }.
 *
 * @param {Object}  opts
 * @param {string}  opts.title
 * @param {string}  opts.body            Plain text — set as textContent (no HTML injection).
 * @param {string}  [opts.okLabel="Continue"]
 * @param {string}  [opts.cancelLabel="Cancel"]
 * @param {boolean} [opts.allowSkip=true]  Show the "don't show again" checkbox
 */
export function confirmDialog(opts = {}) {
  const {
    title       = 'Confirm',
    body        = '',
    okLabel     = 'Continue',
    cancelLabel = 'Cancel',
    allowSkip   = true,
  } = opts;

  return new Promise(resolve => {
    const dlg     = $('confirmDialog');
    const skipBox = $('confirmDialogSkip');
    const okBtn   = $('confirmDialogOk');
    const cancel  = $('confirmDialogCancel');

    $('confirmDialogTitle').textContent = title;
    $('confirmDialogBody').textContent  = body;
    okBtn.textContent     = okLabel;
    cancel.textContent    = cancelLabel;
    skipBox.checked       = false;
    skipBox.parentElement.style.display = allowSkip ? '' : 'none';
    dlg.style.display     = 'flex';

    const finish = ok => {
      dlg.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      resolve({ ok, skipFuture: !!skipBox.checked });
    };
    const onOk     = () => finish(true);
    const onCancel = () => finish(false);
    const onKey    = e => {
      if (e.key === 'Escape') onCancel();
      else if (e.key === 'Enter') onOk();
    };

    okBtn.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
    okBtn.focus();
  });
}

/**
 * Archive progress pill — fixed bottom-right indicator that updates as
 * archive.js streams tracks to disk.  Returns an opaque controller.
 */
export function showArchiveStatus(title) {
  const root  = $('archiveStatus');
  const tEl   = $('archiveStatusTitle');
  const cEl   = $('archiveStatusCount');
  const fEl   = $('archiveStatusFill');
  const lEl   = $('archiveStatusLabel');
  tEl.textContent = title;
  cEl.textContent = '0/0';
  fEl.style.width = '0%';
  lEl.textContent = '';
  root.style.display = '';
  return {
    update(cur, total, label = '') {
      cEl.textContent = `${cur}/${total}`;
      fEl.style.width = total > 0 ? `${Math.min(100, (cur / total) * 100)}%` : '0%';
      lEl.textContent = label;
    },
    hide() { root.style.display = 'none'; },
  };
}

// Safe imperative DOM builder — no innerHTML
export function createEl(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className')        el.className   = v;
    else if (k === 'textContent') el.textContent = v;
    else el.setAttribute(k, v);
  }
  for (const child of children) {
    if (typeof child === 'string') el.append(document.createTextNode(child));
    else if (child) el.append(child);
  }
  return el;
}

// XSS-safe innerHTML — strips on* attributes and javascript: hrefs.
// Primary protection is always esc() at the call site; this is defence-in-depth.
// For new code prefer createEl; use this as a drop-in wrapper for template-string blocks.
//
// When targeting #contentInner we trigger a CSS enter-animation after the swap.
// The DOM update is always synchronous so event-listener wiring that follows the
// call works on the new DOM immediately.  The animation is a cosmetic overlay
// driven by toggling the .vt-enter class via requestAnimationFrame.
export function safeInnerHTML(el, html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  t.content.querySelectorAll('*').forEach(node => {
    [...node.attributes].forEach(a => {
      if (/^on/i.test(a.name)) node.removeAttribute(a.name);
      if (a.name === 'href' && /^javascript:/i.test(a.value)) node.removeAttribute(a.name);
    });
  });
  // Synchronous DOM update — must happen before any caller queries the new nodes
  el.innerHTML = '';
  el.appendChild(t.content);
  // Animate the new content in via CSS (rAF ensures class is added after paint)
  if (el?.id === 'contentInner' || el?.id === 'nugsContentInner') {
    el.classList.remove('vt-enter');
    requestAnimationFrame(() => el.classList.add('vt-enter'));
  }
}

// Simple debounce
export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Fisher-Yates shuffle — pure, returns a new array
export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Draw the image to a 1×1 canvas so the browser averages all pixels,
// returning an "rgb(r,g,b)" string. Returns null on CORS or decode errors.
export function getAverageRGB(imgEl) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1; canvas.height = 1;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgEl, 0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `rgb(${r},${g},${b})`;
  } catch {
    return null;
  }
}
