/* ── archive.js — Local archival queue for full shows ─────────────────────────
 * Sequential, non-blocking download orchestrator. Drives the main-process
 * `download-track` IPC bridge one file at a time so the renderer never blocks
 * and we never trip rate-limit / abuse heuristics on the upstream CDN.
 *
 * Design notes:
 *  • The queue is a plain `for…of` loop over the tracklist with `await` per
 *    download — there's no parallelism by design.
 *  • The progress callback fires BEFORE every `await`, so the caller can
 *    update UI before the renderer yields to the event loop. This is what
 *    keeps the UI from appearing frozen during long shows.
 *  • Random 1.5–4.0 s sleep between tracks mimics human click cadence.
 *  • Cover art is downloaded first (item 1 of N+1) so the folder is "alive"
 *    before any tracks land — handy for live monitoring with a file manager.
 *  • Failures on individual tracks are logged and reported via `onError` but
 *    DO NOT abort the queue — partial archives are useful.
 * ───────────────────────────────────────────────────────────────────────── */

import { showToast, showArchiveStatus } from './utils.js';
import { nugsApi } from './api.js';
import { audio } from './audio-engine.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Strip path-hostile characters from a filename / folder segment. */
function sanitizeSegment(s) {
  return String(s ?? '')
    .replace(/[\/\\\0:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '')
    .slice(0, 120) || 'untitled';
}

/** Pull the file extension off a URL (ignoring query string). */
function extFromUrl(url, fallback = 'mp3') {
  const m = String(url ?? '').split('?')[0].match(/\.([a-z0-9]{2,5})$/i);
  return (m?.[1] ?? fallback).toLowerCase();
}

/** "01 - Sugar Magnolia.flac" — zero-padded track number, sanitized title. */
function trackFilename(idx, title, url) {
  return `${String(idx).padStart(2, '0')} - ${sanitizeSegment(title)}.${extFromUrl(url)}`;
}

/**
 * Archive every track of a show plus its cover art into
 *   <Music>/Days Between/[Artist Name]/[Date - Venue]/
 *
 * Works for Relisten sources (`source.sets[].tracks[]` with `mp3_url`) and
 * Nugs releases (synthetic source `{ _nugs: true, tracks: [...] }` whose
 * tracks may need on-demand stream URL resolution).
 *
 * @param {Object}   artist            { name, slug, ... }
 * @param {Object}   show              { display_date, venue: { name }, ... }
 * @param {Object}   source            Relisten source OR Nugs release wrapper
 * @param {Object}   [opts]
 * @param {string}   [opts.coverUrl]   URL of the cover image to save as cover.jpg
 * @param {Function} [opts.onProgress] (current, total, label) — called BEFORE each download await
 * @param {Function} [opts.onError]    (Error) — called when a single track fails
 * @returns {Promise<{ ok: boolean, folder?: string, error?: string }>}
 */
export async function downloadFullShow(artist, show, source, opts = {}) {
  const { coverUrl, onProgress = () => {}, onError = () => {} } = opts;
  const isNugs = !!(source?._nugs || show?._nugs);

  // ── Collect downloadable tracks ──────────────────────────────────────────
  const tracks = isNugs
    ? (source?.tracks ?? [])
    : (source?.sets ?? []).flatMap(s => (s.tracks ?? []).filter(t => t.mp3_url));

  if (!tracks.length) {
    showToast('No downloadable tracks found');
    return { ok: false, error: 'no tracks' };
  }

  // ── Build the destination folder ─────────────────────────────────────────
  const date     = sanitizeSegment(show?.display_date ?? 'unknown');
  const venue    = sanitizeSegment(show?.venue?.name ?? '');
  const showDir  = venue ? `${date} - ${venue}` : date;
  const folder   = `${sanitizeSegment(artist?.name ?? 'Unknown Artist')}/${showDir}`;
  const fetchMode = isNugs ? 'nugs' : 'plain';

  const total = tracks.length + (coverUrl ? 1 : 0);
  let done = 0;

  // Nugs enforces a single-active-stream policy per account, so a download
  // (which is itself a stream from their perspective) will bump live audio
  // playback. Pause now, remember whether to resume when we finish.
  let resumeAfter = false;
  if (isNugs && audio && !audio.paused && audio.currentTime > 0) {
    resumeAfter = true;
    try { audio.pause(); } catch {}
  }

  // Persistent progress pill — visible for the whole archive run.
  const status = showArchiveStatus(`Archiving ${artist?.name ?? 'show'} — ${date}`);
  showToast(`📥 Archiving "${date}" — ${tracks.length} tracks`);

  // ── STEP 1: Cover art ────────────────────────────────────────────────────
  // Always saved as cover.jpg unless the source is webp/png/avif (in which
  // case we keep the native ext so it actually decodes).
  if (coverUrl) {
    const ext = extFromUrl(coverUrl, 'jpg');
    const coverFn = (ext === 'webp' || ext === 'avif' || ext === 'png')
      ? `cover.${ext}` : 'cover.jpg';

    onProgress(done + 1, total, coverFn);
    status.update(done + 1, total, coverFn);
    // Yield to the event loop so the UI text update actually paints
    // before we start the network request.
    await sleep(0);

    try {
      const r = await window.ipc.downloadTrack({
        url:      coverUrl,
        filename: coverFn,
        subdir:   folder,
        mode:     fetchMode,
      });
      if (!r?.ok) console.warn('[archive] cover failed:', r?.error);
    } catch (err) {
      console.warn('[archive] cover threw:', err);
    }
    done++;
  }

  // ── STEP 2: Tracks (sequential, randomized delay between) ────────────────
  for (let i = 0; i < tracks.length; i++) {
    const t   = tracks[i];
    const num = i + 1;

    // Resolve URL — Relisten tracks have it inline; Nugs may need a lookup.
    let url = t.stream_url ?? t.mp3_url ?? null;
    if (isNugs && !url && t._nugs_trackId) {
      try {
        url = await nugsApi.streamUrl(t._nugs_trackId);
      } catch (err) {
        console.warn('[archive] nugs streamUrl failed:', t.title, err);
      }
    }

    if (!url) {
      onError(new Error(`No URL for "${t.title ?? `Track ${num}`}"`));
      done++;
      continue;
    }

    const filename = trackFilename(num, t.title ?? `Track ${num}`, url);

    // Update UI BEFORE awaiting the download — this is what keeps the
    // button text live and the app feeling responsive.
    onProgress(done + 1, total, filename);
    status.update(done + 1, total, filename);
    await sleep(0); // let the UI paint

    try {
      const r = await window.ipc.downloadTrack({ url, filename, subdir: folder, mode: fetchMode });
      if (!r?.ok) {
        console.warn('[archive] track failed:', t.title, r?.error);
        onError(new Error(`${t.title ?? `Track ${num}`}: ${r?.error ?? 'unknown'}`));
      }
    } catch (err) {
      console.warn('[archive] track threw:', t.title, err);
      onError(err);
    }
    done++;

    // Randomized human-cadence delay — skip after the last track so the user
    // doesn't wait an extra few seconds for the "done" toast.
    if (i < tracks.length - 1) {
      await sleep(1500 + Math.random() * 2500);
    }
  }

  status.hide();
  if (resumeAfter) {
    try { await audio.play(); } catch (err) { console.warn('[archive] resume failed:', err); }
  }

  showToast(`✅ Archived: ${artist?.name ?? 'Show'} — ${date}`);
  return { ok: true, folder };
}
