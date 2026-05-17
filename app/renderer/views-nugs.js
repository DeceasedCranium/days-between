/* ── views-nugs.js — Nugs.net browsing views ──────────────────── */
import { $, esc, fmt, artistColor, showToast, shuffle, confirmDialog, dlog, dinfo } from './utils.js';
import { state, nav, settings, store, nugsAuth, nugsArtistStore, nugsReleasesCache, sidebarSource } from './state.js';
import { nugsApi, nugsContainerImage } from './api.js';
import { buildSetlistFmSongMap } from './setlistfm.js';
// Pure helpers that don't touch DOM/state/network — live in shared/helpers.js
// for unit testability. See test/helpers.test.js.
import {
  nugsIsoDate,
  applyNugsFilters,
  sortByRecent,
  sortByPopular,
  aggregateNugsSongs,
  normaliseSongTitle,
  nugsSongsDiagnostics,
} from '../shared/helpers.js';
import { injectArtistBio, lastfmArtistImage } from './lastfm.js';
import { nugsResolveAndPlay, handleNugsAuthError, setPlayerArt } from './player.js';
import { scrapeLive, scrapeRecent, scrapeStash, extractContainerId } from './nugs-scraper.js';
import { startLiveStream } from './video-player.js';
// NOTE: setBreadcrumb, fadeIn, renderArtists come from views-core.js.
// ES module circular imports are safe here — functions are only called
// inside event handlers and async functions, never at module init time.
import { setBreadcrumb, fadeIn, renderArtists } from './views-core.js';
import { downloadFullShow } from './archive.js';

/* ── Content container helper ────────────────────── */
// When the Nugs source tab is active all views must write to #nugsContentInner
// (which is visible) rather than #contentInner (which is hidden).
const nugsCI = () =>
  sidebarSource === 'nugs'
    ? ($('nugsContentInner') ?? $('contentInner'))
    : $('contentInner');

/* ── Welcome / landing view ──────────────────────────────────────────────────
 * Four sections, each filling asynchronously and hiding itself if it has no
 * data to show:
 *   1. Live & Recent  — uses scrapeLive (live + recent webcasts)
 *   2. Pinned Artists — artist tiles from localStorage pins
 *   3. Recently Added — global recent containers (falls back to pinned-artist
 *                       cached releases if the global probe returns nothing)
 *   4. Discover       — random sample of catalog artists you haven't pinned
 *
 * Each card uses the same .show-card scaffold as the artist-page grid so
 * styling stays consistent. Rows are horizontal-scrolling flex containers
 * so the welcome view doesn't get arbitrarily tall.
 * ────────────────────────────────────────────────────────────────────────── */

const NUGS_PINS_KEY = 'nugs_pinned_artists';
function getNugsPins() {
  try { return JSON.parse(localStorage.getItem(NUGS_PINS_KEY) ?? '[]'); } catch { return []; }
}

/* ── Set delineation for Nugs track lists — via setlist.fm cross-reference ─
 *
 * Nugs's container API ships tracks as a flat array with no set / disc
 * structure — unlike Relisten, which gives us sets[].name from the source
 * payload. To add "Set 1 / Set 2 / Encore" headers on the Nugs side, we
 * look up the corresponding setlist.fm setlist for the same artist + date
 * (using the cache populated by v1.13's song-counts feature and v2.2's
 * Advanced Search). When found, each Nugs track is mapped to whichever
 * setlist.fm set it appears in.
 *
 * Coverage:
 *   • Works when the user has previously scanned the artist's setlist.fm
 *     data (i.e. opened a song-stats card or used Advanced Search for
 *     that artist). For modern jam-band catalogs that's the norm.
 *   • Falls back to a flat list with no set labels when the cache is
 *     empty or no matching setlist exists for the date.
 *   • Tracks that don't match any setlist.fm song (jam interludes,
 *     unlogged segues) inherit the most-recently-emitted set label, so
 *     a single missed match doesn't visually break the set boundary.
 *
 * Returns the rendered HTML string for the track list, with optional
 * `<div class="set-label">` headers interleaved.
 * ────────────────────────────────────────────────────────────────────── */
async function renderNugsTracksWithSetLabels(normTracks, artist, displayDate) {
  // Build the song-to-set map from setlist.fm (returns null gracefully on
  // any failure path — no setlist.fm key, no cache, no matching date).
  const songToSet = await buildSetlistFmSongMap(artist, displayDate);

  const out = [];
  let currentSet = null;
  normTracks.forEach((t, i) => {
    const key = normaliseSongTitle(t.title);
    const trackSet = songToSet?.get(key) ?? null;
    // Only emit a new header when we encounter a track that maps to a
    // DIFFERENT set than the running set. Tracks that don't match any
    // setlist.fm entry keep the current set context.
    if (trackSet && trackSet !== currentSet) {
      out.push(`<div class="set-label">${esc(trackSet)}</div>`);
      currentSet = trackSet;
    }
    out.push(`
      <div class="track-row" data-track-uuid="${esc(t.uuid)}" data-track-pos="${i + 1}">
        <div class="track-num">${i + 1}</div>
        <div class="track-name">${esc(t.title)}${t._nugs_video ? ' 🎬' : ''}</div>
        <div class="track-dur">${fmt(t.duration)}</div>
      </div>`);
  });
  return out.join('');
}

/* buildSetlistFmSongMap was moved to setlistfm.js (v2.3) so the Relisten
 * show-page renderer can use the same helper. Kept as an import above. */

export async function viewNugsWelcome() {
  const ci = $('nugsContentInner');
  if (!ci) return;
  nav.record(viewNugsWelcome, []);

  ci.style.overflow = '';
  ci.style.padding  = '';
  // Cold-install pitch: when there's no Nugs auth, the bottom 3 sections
  // (pinned, recently added, discover) all stay hidden — leaving the page
  // looking like it's broken. Surface the sign-in CTA so the user knows
  // what to do.
  const signedIn = nugsAuth.hasToken();
  ci.innerHTML = `
    <div class="nugs-welcome">
      <div class="nugs-welcome-hero">
        <div class="nugs-welcome-logo">🎵</div>
        <h1>Nugs.net</h1>
        <p>Live recordings from your favourite artists.</p>
      </div>

      ${signedIn ? '' : `
      <div class="nugs-welcome-cta" id="nugsWelcomeSignInCta">
        <div class="nugs-welcome-cta-text">
          <strong>Sign in to nugs.net</strong>
          <span>to see your library, pin artists, and stream subscription audio &amp; video.</span>
        </div>
        <button class="action-btn primary" id="nugsWelcomeSignInBtn">Open Settings</button>
      </div>`}

      <section class="nugs-welcome-section" id="nugsWelLiveSection">
        <div class="nugs-welcome-section-header">
          <h2>● Live &amp; Recent Webcasts</h2>
          <button class="nugs-welcome-link" id="nugsWelLiveAll">Live Hub →</button>
        </div>
        <div class="nugs-welcome-row" id="nugsWelLiveRow">
          <div class="loading" style="height:80px"><div class="spinner"></div></div>
        </div>
      </section>

      <section class="nugs-welcome-section" id="nugsWelPinnedSection" style="display:none">
        <div class="nugs-welcome-section-header">
          <h2>📌 Your Pinned Artists</h2>
        </div>
        <div class="nugs-welcome-row" id="nugsWelPinnedRow"></div>
      </section>

      <section class="nugs-welcome-section" id="nugsWelRecentSection" style="display:none">
        <div class="nugs-welcome-section-header">
          <h2>✨ Recently Added</h2>
          <span class="nugs-welcome-sub" id="nugsWelRecentSub"></span>
        </div>
        <div class="nugs-welcome-row" id="nugsWelRecentRow"></div>
      </section>

      <section class="nugs-welcome-section" id="nugsWelDiscoverSection" style="display:none">
        <div class="nugs-welcome-section-header">
          <h2>🎲 Discover Artists</h2>
          <button class="nugs-welcome-link" id="nugsWelShuffle">↻ Shuffle</button>
        </div>
        <div class="nugs-welcome-row" id="nugsWelDiscoverRow"></div>
      </section>
    </div>`;

  // Sign-in CTA (cold install only)
  $('nugsWelcomeSignInBtn')?.addEventListener('click', () => {
    import('./views-user.js').then(m => m.viewSettings?.());
  });

  // ── 1. Live & Recent ──────────────────────────────────────────────
  $('nugsWelLiveAll')?.addEventListener('click', () => viewNugsDashboard('live'));
  loadWelLiveSection();

  // ── 2. Pinned Artists ─────────────────────────────────────────────
  loadWelPinnedSection();

  // ── 3. Recently Added (global probe + fallback) ───────────────────
  loadWelRecentSection();

  // ── 4. Discover (random sample) ───────────────────────────────────
  loadWelDiscoverSection();
  $('nugsWelShuffle')?.addEventListener('click', () => loadWelDiscoverSection());
}

/* ── Section: Live & Recent webcasts ───────────────────────────────────── */
async function loadWelLiveSection() {
  const row = $('nugsWelLiveRow');
  if (!row) return;
  try {
    const cards = await scrapeLive();
    if (!cards?.length) {
      $('nugsWelLiveSection').style.display = 'none';
      return;
    }
    // Show up to 8 — Live cards first, then recent
    const sorted = [...cards].sort((a, b) => (b.isLive ? 1 : 0) - (a.isLive ? 1 : 0)).slice(0, 8);
    row.innerHTML = sorted.map((c, i) => welcomeShowCard(c, i)).join('');
    row.querySelectorAll('.nugs-welcome-card').forEach(el =>
      el.addEventListener('click', () => {
        const c = sorted[+el.dataset.idx];
        if (c?.linkUrl) {
          // Reuse the dashboard's click handler by routing through scrapeLive's data shape
          import('./nugs-scraper.js').then(m => {
            const cid = m.extractContainerId(c.linkUrl);
            if (cid) nugsViewRelease({ name: c.artist ?? 'Nugs', id: 'live', _nugs: true }, cid);
            else showToast('Could not open this show');
          });
        }
      }));
  } catch (err) {
    console.warn('[nugs-welcome] live section failed:', err.message);
    $('nugsWelLiveSection').style.display = 'none';
  }
}

/* ── Section: Pinned Artists ───────────────────────────────────────────── */
function loadWelPinnedSection() {
  const row = $('nugsWelPinnedRow');
  if (!row) return;
  const pins = getNugsPins();
  if (!pins.length) {
    $('nugsWelPinnedSection').style.display = 'none';
    return;
  }
  $('nugsWelPinnedSection').style.display = '';
  row.innerHTML = pins.map((p, i) => artistTileHtml(p.name, 'Pinned', i)).join('');
  row.querySelectorAll('.nugs-welcome-card').forEach((el, i) => {
    el.addEventListener('click', () => {
      const p = pins[+el.dataset.idx];
      if (!p) return;
      nugsViewArtist({ id: p.id, name: p.name, slug: `nugs-${p.id}`, _nugs: true });
    });
    swapArtistTileImage(el, pins[i]);
  });
}

/* ── Section: Recently Added ───────────────────────────────────────────────
 * Two-tier strategy:
 *   1. Try `streamapi.containersAll` with no artistList (global recents).
 *      If that returns enough rows we use them directly.
 *   2. Otherwise, build a pool from pinned artists. We proactively kick off
 *      `nugsApi.catalog()` fetches for any pinned artist we haven't already
 *      cached this session, in parallel, so the fallback pool isn't limited
 *      to whichever artist the user happened to open during this run.
 *
 * Race-safety: a token ensures only the LATEST call to this function ever
 * writes to the DOM. If the user navigates away and re-renders mid-fetch,
 * the stale call's writes become no-ops. DOM is also re-queried at write
 * time rather than captured up-front.
 * ────────────────────────────────────────────────────────────────────────── */
let _welRecentToken = 0;
async function loadWelRecentSection() {
  const myToken = ++_welRecentToken;
  const initialSec = $('nugsWelRecentSection');
  const initialRow = $('nugsWelRecentRow');
  if (!initialRow) return;

  // Show the section with a spinner immediately if we have any pinned
  // artists (we know we'll have data eventually). This avoids the awkward
  // "did the section disappear?" gap during the 15-artist pre-fetch.
  const havePins = getNugsPins().length > 0;
  if (havePins && initialSec) {
    initialSec.style.display = '';
    initialRow.innerHTML = `<div class="loading" style="height:80px;width:100%"><div class="spinner"></div></div>`;
  }

  // Tier 1: global probe.
  let containers = [];
  let source = '';
  try {
    const global = await nugsApi.recentlyAddedGlobal({ limit: 16 });
    dinfo('[nugs-welcome] recent: global probe returned', global.length, 'containers');
    if (global.length >= 4) {
      containers = global;
      source = 'across the catalog';
    }
  } catch (err) {
    console.warn('[nugs-welcome] recent: global probe threw:', err.message);
  }
  if (myToken !== _welRecentToken) return; // a newer call has superseded us

  // Tier 2: pinned-artist pool (with on-demand catalog fetch).
  if (!containers.length) {
    const pins = getNugsPins();
    if (!pins.length) {
      const s = $('nugsWelRecentSection'); if (s) s.style.display = 'none';
      return;
    }
    const missing = pins.filter(p => !nugsReleasesCache[p.id]);
    if (missing.length) {
      dinfo('[nugs-welcome] recent: pre-fetching', missing.length, 'pinned-artist catalogs');
      const queue = [...missing];
      async function worker() {
        while (queue.length) {
          if (myToken !== _welRecentToken) return; // bail on supersede
          const p = queue.shift();
          if (!p) return;
          try {
            const all = [];
            const PAGE = nugsApi.CATALOG_PAGE_SIZE;
            let offset = 1, batch, page = 0;
            do {
              page++;
              const data = await nugsApi.catalog(p.id, offset);
              batch = data?.Response?.containers ?? data?.response?.containers ?? [];
              all.push(...batch);
              dinfo('[nugs-catalog]', p.name, 'page', page, '— got', batch.length, 'containers (offset:', offset, ')');
              offset += PAGE;
            } while (batch.length === PAGE);
            dinfo('[nugs-catalog]', p.name, '— total fetched:', all.length);
            nugsReleasesCache[p.id] = all;
          } catch (err) {
            console.warn('[nugs-welcome] recent: catalog fetch failed for', p.name, err.message);
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
    }
    if (myToken !== _welRecentToken) return; // supersede check post-prefetch

    const pooled = [];
    for (const p of pins) {
      const cached = nugsReleasesCache[p.id];
      if (Array.isArray(cached)) pooled.push(...cached);
    }
    dinfo('[nugs-welcome] recent: pinned pool has', pooled.length, 'containers');
    if (pooled.length) {
      containers = pooled
        .sort((a, b) => Number(b.epochDateCreated ?? 0) - Number(a.epochDateCreated ?? 0))
        .slice(0, 12);
      source = 'from your pinned artists';
    }
  }

  if (myToken !== _welRecentToken) return;

  // Re-query DOM at write time — never trust the captured references after
  // any awaits (the user may have navigated, replacing the welcome DOM).
  const latestSec = $('nugsWelRecentSection');
  const latestRow = $('nugsWelRecentRow');
  const latestSub = $('nugsWelRecentSub');
  if (!latestSec || !latestRow) return;

  if (!containers.length) {
    latestSec.style.display = 'none';
    return;
  }
  latestSec.style.display = '';
  if (latestSub) latestSub.textContent = source;

  latestRow.innerHTML = containers.map((c, i) => welcomeContainerCard(c, i)).join('');
  latestRow.querySelectorAll('.nugs-welcome-card').forEach(el =>
    el.addEventListener('click', () => {
      const c = containers[+el.dataset.idx];
      if (!c?.containerID) return;
      const artist = { id: String(c.artistID ?? ''), name: c.artistName ?? 'Nugs', _nugs: true };
      nugsViewRelease(artist, String(c.containerID));
    }));
}

/* ── Section: Discover Artists (random sample) ─────────────────────────── */
function loadWelDiscoverSection() {
  const row = $('nugsWelDiscoverRow');
  if (!row) return;
  const cache = nugsApi._artistCache;
  if (!Array.isArray(cache) || cache.length < 8) {
    // Catalog hasn't loaded yet — try again shortly.
    setTimeout(loadWelDiscoverSection, 1500);
    $('nugsWelDiscoverSection').style.display = 'none';
    return;
  }
  const pinned  = new Set(getNugsPins().map(p => String(p.id)));
  const pool    = cache.filter(a => !pinned.has(String(a.artistID)));
  const sample  = shuffle(pool).slice(0, 12).map(a => ({
    id: String(a.artistID),
    name: a.artistName,
    numShows: a.numShows ?? 0,
  }));
  if (!sample.length) {
    $('nugsWelDiscoverSection').style.display = 'none';
    return;
  }
  $('nugsWelDiscoverSection').style.display = '';
  row.innerHTML = sample.map((a, i) =>
    artistTileHtml(a.name, `${a.numShows} show${a.numShows === 1 ? '' : 's'}`, i)
  ).join('');
  row.querySelectorAll('.nugs-welcome-card').forEach((el, i) => {
    el.addEventListener('click', () => {
      const a = sample[+el.dataset.idx];
      if (!a) return;
      nugsViewArtist({ id: a.id, name: a.name, slug: `nugs-${a.id}`, _nugs: true });
    });
    swapArtistTileImage(el, sample[i]);
  });
}

/* ── Artist tile (initials placeholder + lazy Nugs cover-art image swap) ───
 * The image strategy is dead simple: every Nugs artist has at least one
 * release, and every release has a CDN cover photo we already know how to
 * resolve via nugsContainerImage(). Use the artist's most recent release
 * cover as the tile image. No Wikipedia, no Last.fm, no 404s for obscure
 * artists — works for every artist in the Nugs catalog.
 *
 * Pinned artists usually have their full catalog cached already (welcome
 * pre-fetches them for the Recently Added section). Discover artists need
 * one cheap fetch — limit=1 — and the result lands in nugsReleasesCache so
 * subsequent renders are instant.
 * ──────────────────────────────────────────────────────────────────────── */

// Per-artist cover-image cache. Keyed by artistID. Value = url string or
// null (for "tried, no usable image"). Returned synchronously when known.
const _nugsTileImageCache = new Map();

async function getNugsArtistImage(artistId) {
  const id = String(artistId);
  if (_nugsTileImageCache.has(id)) return _nugsTileImageCache.get(id);

  const pickFromContainers = (containers) => {
    if (!Array.isArray(containers) || !containers.length) return null;
    const sorted = [...containers].sort(
      (a, b) => Number(b.epochDateCreated ?? 0) - Number(a.epochDateCreated ?? 0)
    );
    for (const c of sorted) {
      const url = nugsContainerImage(c, { width: 240 });
      if (url) return url;
    }
    return null;
  };

  // Use cached releases when we have them.
  const cached = nugsReleasesCache[id];
  if (cached?.length) {
    const url = pickFromContainers(cached);
    _nugsTileImageCache.set(id, url);
    return url;
  }

  // Otherwise fetch one batch (we keep what we get for future use).
  try {
    const data = await nugsApi.catalog(id, 1);
    const containers = data?.Response?.containers ?? data?.response?.containers ?? [];
    if (containers.length) nugsReleasesCache[id] = containers;
    const url = pickFromContainers(containers);
    _nugsTileImageCache.set(id, url);
    return url;
  } catch (err) {
    console.warn('[nugs-art] catalog fetch failed for artist', id, err.message);
    _nugsTileImageCache.set(id, null);
    return null;
  }
}

function artistTileHtml(name, sub, idx) {
  return `
    <div class="nugs-welcome-card nugs-welcome-card-artist" data-idx="${idx}">
      <div class="show-card-art typo" style="background:${artistColor(name)}">
        <span class="art-init">${esc((name[0] ?? 'N').toUpperCase())}</span>
        <div class="card-play">▶</div>
      </div>
      <div class="show-card-body">
        <div class="show-card-date" title="${esc(name)}">${esc(name)}</div>
        <div class="show-card-venue">${esc(sub)}</div>
      </div>
    </div>`;
}

/** Lazily resolve a Nugs cover-art image for the artist and swap it into
 *  the tile when the image actually loads. Failure (no catalog, network
 *  blip) leaves the colored initial in place — a perfectly fine fallback. */
function swapArtistTileImage(cardEl, artist) {
  if (!cardEl || !artist?.id) {
    console.warn('[nugs-art] swap skipped — missing card or artist.id', artist);
    return;
  }
  const artEl = cardEl.querySelector('.show-card-art');
  if (!artEl) {
    console.warn('[nugs-art] swap skipped — no .show-card-art element');
    return;
  }
  getNugsArtistImage(artist.id).then(url => {
    if (!url) return;
    if (!document.body.contains(artEl)) {
      dlog('[nugs-art] swap skipped — artEl detached for', artist.name);
      return;
    }
    // Detached <img> elements with `loading="lazy"` never trigger their
    // load (the lazy heuristic waits for them to be near the viewport,
    // which never happens for a memory-only element). Use eager loading.
    const img = new Image();
    img.alt = artist.name ?? '';
    img.onload = () => {
      if (!document.body.contains(artEl)) return;
      artEl.classList.remove('typo');
      artEl.innerHTML = '';
      artEl.appendChild(img);
      const play = document.createElement('div');
      play.className = 'card-play';
      play.textContent = '▶';
      artEl.appendChild(play);
    };
    img.onerror = () => {
      dlog('[nugs-art] image FAILED to load for', artist.name, '—', url);
    };
    img.src = url;
  }).catch(err => {
    console.warn('[nugs-art] swap promise rejected for', artist.name, err);
  });
}

/* ── Card renderers ────────────────────────────────────────────────────── */
function welcomeShowCard(card, idx) {
  const name  = card.title ?? card.name ?? 'Untitled';
  const sub   = [card.artist, card.date].filter(Boolean).join(' · ');
  const art   = card.imageUrl
    ? `<img src="${esc(card.imageUrl)}" alt="${esc(name)}" loading="lazy" onerror="this.parentElement.classList.add('typo');this.replaceWith(Object.assign(document.createElement('span'),{className:'art-init',textContent:'${esc((name[0]??'?').toUpperCase())}'}))">`
    : `<span class="art-init">${esc((name[0] ?? '?').toUpperCase())}</span>`;
  return `
    <div class="nugs-welcome-card${card.isLive ? ' is-live' : ''}" data-idx="${idx}">
      <div class="show-card-art${card.imageUrl ? '' : ' typo'}" style="background:var(--bg3)">
        ${art}
        ${card.isLive ? '<div class="nugs-live-badge">● LIVE</div>' : ''}
        <div class="card-play">▶</div>
      </div>
      <div class="show-card-body">
        <div class="show-card-date" title="${esc(name)}">${esc(name)}</div>
        ${sub ? `<div class="show-card-venue">${esc(sub)}</div>` : ''}
      </div>
    </div>`;
}

function welcomeContainerCard(c, idx) {
  const date  = nugsIsoDate(c.performanceDate) || '';
  const venue = [c.venueName, c.venueCity].filter(Boolean).join(' — ');
  const img   = nugsContainerImage(c, { width: 300 });
  const artist = c.artistName ?? '';
  const heroColor = artistColor(artist || 'Nugs');
  const art = img
    ? `<img src="${esc(img)}" alt="${esc(artist)}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'art-init',textContent:'${esc((artist[0] ?? '?').toUpperCase())}'}));this.parentElement.classList.add('typo')">`
    : `<span class="art-init">${esc((artist[0] ?? '?').toUpperCase())}</span>`;
  return `
    <div class="nugs-welcome-card" data-idx="${idx}">
      <div class="show-card-art${img ? '' : ' typo'}" style="background:${heroColor}">
        ${art}
        <div class="card-play">▶</div>
      </div>
      <div class="show-card-body">
        <div class="show-card-date" title="${esc(artist)}">${esc(artist)}</div>
        <div class="show-card-venue">${esc(date)}${venue ? ' · ' + esc(venue) : ''}</div>
      </div>
    </div>`;
}

/* ── Helpers ─────────────────────────────────────── */
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
// nugsIsoDate / applyNugsFilters / sortByRecent / sortByPopular are pure
// helpers — implementations live in app/shared/helpers.js (browser-free) so
// they can be unit-tested independently of the renderer. Imported at top.

/* ── Grid card render ──────────────────────────────────────────────────────
 * Reuses the Relisten `.show-cards` / `.show-card` styles (defined in style.css
 * around line 1747). Each container becomes a square-ish card with its CDN
 * cover art at top and date/venue text below — fallback to the typographic
 * date layout when no image is available, matching `.show-card-art.typo`.
 * ──────────────────────────────────────────────────────────────────────── */
function renderNugsReleaseGrid(releases, artist) {
  const el = $('nugsReleaseList');
  if (!el) return;
  if (releases.length === 0) {
    el.innerHTML = `<div class="empty-state" style="padding:24px;color:var(--text3);text-align:center">No releases match the current filters</div>`;
    return;
  }
  const heroColor = artistColor(artist.name);
  el.innerHTML = `<div class="show-cards" id="nugsReleaseGrid">${releases.map(c => {
    const isVideo  = !!(c.videoURL || c.videoChapters || c.vodPlayerImage
      || c.containerTypeStr?.toLowerCase().includes('video'));
    const date     = nugsIsoDate(c.performanceDate) || String(c.containerID);
    const venue    = [c.venueName, c.venueCity].filter(Boolean).join(' — ');
    const imgUrl   = nugsContainerImage(c, { width: 360 });
    const artBg    = imgUrl
      ? `background:${heroColor}`
      : `background:${heroColor}`;
    const artInner = imgUrl
      ? `<img src="${esc(imgUrl)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'art-init',textContent:'${esc((artist.name[0]??'?').toUpperCase())}'}))">`
      : (() => {
          const parts = date.split('-');
          const mn    = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
          const month = parts[1] ? (mn[parseInt(parts[1],10)-1] ?? '') : '';
          const day   = parts[2] ? String(parseInt(parts[2],10)) : '';
          const year  = parts[0] ?? '';
          return `<div class="typo-artist">${esc(artist.name)}</div>
                  <div class="typo-month">${esc(month)}</div>
                  <div class="typo-day">${esc(day)}</div>
                  <div class="typo-year">${esc(year)}</div>`;
        })();
    return `<div class="show-card" data-cid="${esc(String(c.containerID))}">
      <div class="show-card-art${imgUrl ? '' : ' typo'}" style="${artBg}">
        ${artInner}
        <div class="card-play">&#9654;</div>
      </div>
      <div class="show-card-body">
        <div class="show-card-date">${esc(date)}</div>
        <div class="show-card-venue">${esc(venue)}</div>
        <div class="show-card-badges">
          ${isVideo ? '<span class="badge" title="Video release">🎬</span>' : ''}
        </div>
      </div>
    </div>`;
  }).join('')}</div>`;
  el.querySelectorAll('.show-card').forEach(card =>
    card.addEventListener('click', () => nugsViewRelease(artist, card.dataset.cid)));
}

/* ── Nugs Songs tab — list view ─────────────────────────────────────────────
 * Renders the artist's full song catalog (aggregated client-side from the
 * cached release list — see aggregateNugsSongs). Each row shows the song
 * title, play count, and an optional 🎧 marker if the user has attended a
 * show containing the song. Click → drill into song detail (handled by
 * the caller via the onPick callback). */
function renderNugsSongsList(songCatalog, allReleases, artist, onPick) {
  const el = $('nugsReleaseList');
  if (!el) return;

  // Build a Set of normalised song keys the user has heard at attended Nugs
  // shows for this artist. Cheap because container.songs is already in cache.
  const attendedNugsDates = new Set(
    store.getAttended()
      .filter(a => a.artistSlug === `nugs-${artist.id}`)
      .map(a => a.date)
  );
  const heardKeys = new Set();
  for (const c of allReleases) {
    const isoDate = nugsIsoDate(c.performanceDate);
    if (!attendedNugsDates.has(isoDate)) continue;
    for (const s of (c.songs ?? [])) {
      const title = typeof s === 'string' ? s : (s.songTitle ?? s.title ?? '');
      const k = normaliseSongTitle(title);
      if (k) heardKeys.add(k);
    }
  }

  // Two sort modes — most-played and rarest. Track which is active locally.
  let sortMode = 'popular';
  function rendered() {
    const sorted = sortMode === 'rare'
      ? [...songCatalog].sort((a, b) => a.plays - b.plays || a.displayTitle.localeCompare(b.displayTitle))
      : [...songCatalog].sort((a, b) => b.plays - a.plays || a.displayTitle.localeCompare(b.displayTitle));
    return sorted;
  }

  function paint(filterText) {
    const list = rendered().filter(s =>
      !filterText || s.displayTitle.toLowerCase().includes(filterText));
    if (!list.length) {
      $('nugsSongList').innerHTML = `<div class="empty-state" style="padding:24px;color:var(--text3);text-align:center">No songs match.</div>`;
      return;
    }
    $('nugsSongList').innerHTML = list.map(s => {
      const heard = heardKeys.has(s.key);
      return `
        <div class="song-row" data-key="${esc(s.key)}">
          <div class="song-name">${heard ? '<span class="song-heard" title="Heard live">🎧</span> ' : ''}${esc(s.displayTitle)}</div>
          <div class="song-count">${s.plays} show${s.plays === 1 ? '' : 's'}</div>
        </div>`;
    }).join('');
    $('nugsSongList').querySelectorAll('.song-row').forEach(row =>
      row.addEventListener('click', () => onPick(row.dataset.key)));
  }

  el.innerHTML = `
    <div class="section-header" style="margin-top:0">
      <div></div>
      <div class="song-sort-tabs">
        <button class="song-sort-tab active" data-sort="popular">Most Played</button>
        <button class="song-sort-tab" data-sort="rare">🦄 Rarities</button>
      </div>
    </div>
    <input class="song-filter" id="nugsSongFilter" type="text" placeholder="Filter songs…" autocomplete="off" spellcheck="false">
    <div class="song-list" id="nugsSongList"></div>`;
  paint('');
  $('nugsSongFilter').addEventListener('input', e => paint(e.target.value.toLowerCase().trim()));
  el.querySelectorAll('.song-sort-tab').forEach(btn =>
    btn.addEventListener('click', () => {
      sortMode = btn.dataset.sort;
      el.querySelectorAll('.song-sort-tab').forEach(b => b.classList.toggle('active', b === btn));
      paint($('nugsSongFilter').value.toLowerCase().trim());
    }));
}

/* ── Nugs Songs tab — song detail view ─────────────────────────────────────
 * Stats card (debut / last / longest gap / longest run / top venues / attended
 * count) + album-cover grid of every container that contains the song.
 * Clicking a card opens the existing nugsViewRelease show detail. */
function renderNugsSongDetail(songEntry, allReleases, artist) {
  const el = $('nugsReleaseList');
  if (!el) return;

  // Pull the matching containers — newest first for the grid.
  const cidSet = new Set(songEntry.containerIDs);
  const containing = allReleases
    .filter(c => cidSet.has(String(c.containerID)))
    .sort((a, b) => Number(b.epochDateCreated ?? 0) - Number(a.epochDateCreated ?? 0));

  // Stats — debut, last, longest gap, longest run, top venues, attended count.
  const byDate = [...containing].sort((a, b) => {
    const da = nugsIsoDate(a.performanceDate);
    const db = nugsIsoDate(b.performanceDate);
    return da < db ? -1 : 1;
  });
  const debut = nugsIsoDate(byDate[0]?.performanceDate ?? '');
  const last  = nugsIsoDate(byDate[byDate.length - 1]?.performanceDate ?? '');

  // Longest gap.
  let longestGap = 0, gapRange = '';
  for (let i = 1; i < byDate.length; i++) {
    const a = new Date(nugsIsoDate(byDate[i - 1].performanceDate));
    const b = new Date(nugsIsoDate(byDate[i].performanceDate));
    const days = Math.round((b - a) / 86400000);
    if (days > longestGap) {
      longestGap = days;
      gapRange = `${nugsIsoDate(byDate[i - 1].performanceDate)} → ${nugsIsoDate(byDate[i].performanceDate)}`;
    }
  }
  const gapDisp = longestGap > 365 ? `${(longestGap / 365).toFixed(1)} years` : `${longestGap} days`;

  // Longest run of consecutive shows containing the song (chronological).
  const allByDate = [...allReleases].sort((a, b) => {
    const da = nugsIsoDate(a.performanceDate);
    const db = nugsIsoDate(b.performanceDate);
    return da < db ? -1 : 1;
  });
  const songDateSet = new Set(byDate.map(c => nugsIsoDate(c.performanceDate)));
  let longestRun = 0, currentRun = 0, runEndDate = '';
  for (const s of allByDate) {
    const iso = nugsIsoDate(s.performanceDate);
    if (songDateSet.has(iso)) {
      currentRun++;
      if (currentRun > longestRun) { longestRun = currentRun; runEndDate = iso; }
    } else {
      currentRun = 0;
    }
  }

  // Top venues.
  const venueCounts = new Map();
  for (const c of byDate) {
    const v = c.venueName ?? '';
    if (!v) continue;
    venueCounts.set(v, (venueCounts.get(v) ?? 0) + 1);
  }
  const topVenues = [...venueCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([n, k]) => `${esc(n)} (${k})`).join(' · ');

  // Attended count for shows containing this song.
  const attendedDates = new Set(
    store.getAttended()
      .filter(a => a.artistSlug === `nugs-${artist.id}`)
      .map(a => a.date)
  );
  const attendedCount = byDate.filter(c =>
    attendedDates.has(nugsIsoDate(c.performanceDate))).length;

  el.innerHTML = `
    <div class="section-header" style="margin-top:0">
      <div>
        <div class="section-title">${esc(songEntry.displayTitle)}</div>
        <div class="section-subtitle">${songEntry.plays} show${songEntry.plays === 1 ? '' : 's'} · ${esc(artist.name)}</div>
      </div>
      <button class="action-btn" id="btnNugsSongBack">← All Songs</button>
    </div>
    <div class="song-stats-card">
      <div class="song-stats-grid">
        <div class="song-stat"><div class="song-stat-num">${songEntry.plays}</div><div class="song-stat-label">Total plays</div></div>
        <div class="song-stat"><div class="song-stat-num">${esc(debut)}</div><div class="song-stat-label">Debut</div></div>
        <div class="song-stat"><div class="song-stat-num">${esc(last)}</div><div class="song-stat-label">Last played</div></div>
        ${attendedCount > 0
          ? `<div class="song-stat song-stat-attended"><div class="song-stat-num">🎧 ${attendedCount}</div><div class="song-stat-label">You were there</div></div>`
          : ''}
      </div>
      ${(longestGap > 30 || longestRun > 1 || topVenues) ? `
        <div class="song-stats-extras">
          ${longestGap > 30 ? `<div><strong>Longest gap:</strong> ${gapDisp} <span class="song-stats-sub">(${esc(gapRange)})</span></div>` : ''}
          ${longestRun > 1   ? `<div><strong>Longest run:</strong> ${longestRun} shows in a row <span class="song-stats-sub">(through ${esc(runEndDate)})</span></div>` : ''}
          ${topVenues       ? `<div><strong>Top venues:</strong> ${topVenues}</div>` : ''}
        </div>` : ''}
    </div>`;

  // Append the album-cover grid of containers using the same renderer the
  // other tabs use — clicking a card opens the existing show detail.
  const grid = document.createElement('div');
  grid.id = 'nugsSongGrid';
  el.appendChild(grid);
  // Move the renderer's output into our grid div by re-querying #nugsReleaseList
  // would reset — easier to inline the render inline:
  grid.innerHTML = `<div class="show-cards">${containing.map(c => {
    const isVideo  = !!(c.videoURL || c.videoChapters || c.containerTypeStr?.toLowerCase().includes('video'));
    const date     = nugsIsoDate(c.performanceDate) || String(c.containerID);
    const venue    = [c.venueName, c.venueCity].filter(Boolean).join(' — ');
    const imgUrl   = nugsContainerImage(c, { width: 360 });
    const heroColor = artistColor(artist.name);
    const artInner = imgUrl
      ? `<img src="${esc(imgUrl)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'art-init',textContent:'${esc((artist.name[0]??'?').toUpperCase())}'}))">`
      : `<span class="art-init">${esc((artist.name[0]??'?').toUpperCase())}</span>`;
    return `
      <div class="show-card" data-cid="${esc(String(c.containerID))}">
        <div class="show-card-art${imgUrl ? '' : ' typo'}" style="background:${heroColor}">
          ${artInner}
          <div class="card-play">&#9654;</div>
        </div>
        <div class="show-card-body">
          <div class="show-card-date">${esc(date)}</div>
          <div class="show-card-venue">${esc(venue)}</div>
          <div class="show-card-badges">${isVideo ? '<span class="badge" title="Video release">🎬</span>' : ''}</div>
        </div>
      </div>`;
  }).join('')}</div>`;

  $('btnNugsSongBack')?.addEventListener('click', () => {
    // Caller (refresh) will redraw the catalog when selectedSongKey resets.
    // We don't have direct access to it here; dispatch a custom event so the
    // outer scope can react.
    window.dispatchEvent(new CustomEvent('nugs-song-back'));
  });
  grid.querySelectorAll('.show-card').forEach(card =>
    card.addEventListener('click', () => nugsViewRelease(artist, card.dataset.cid)));
}

/* ── nugsViewArtist ────────────────────────────────────────────────────────
 * Tabbed artist page modeled on the Relisten side:
 *   Recently Added | Playlists | Most Popular | By Year
 *
 * Recently Added / Most Popular / By Year are all derivations over the same
 * per-artist catalog (one fetch, cached in nugsReleasesCache). Playlists is
 * a separate streamapi call (containerType=playlist) that gracefully yields
 * an empty state when the artist has none — see nugsApi.playlists().
 *
 * The grid uses the Relisten .show-cards CSS so styling stays consistent.
 * ──────────────────────────────────────────────────────────────────────── */
const NUGS_TAB_DEFAULT = 'recent';
const NUGS_TABS = [
  { id: 'recent',  label: 'Recently Added' },
  { id: 'popular', label: 'Most Popular' },
  { id: 'year',    label: 'By Year' },
  { id: 'songs',   label: '🎵 Songs' },
];

export async function nugsViewArtist(artist) {
  nav.record(nugsViewArtist, [artist]);
  state.artist = artist;
  setBreadcrumb([{ label: artist.name }]);
  nugsCI().innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
  try {
    if (!nugsReleasesCache[artist.id]) {
      let all = [], offset = 1, batch, page = 0;
      const PAGE = nugsApi.CATALOG_PAGE_SIZE;
      do {
        page++;
        const data = await nugsApi.catalog(artist.id, offset);
        batch = data?.Response?.containers ?? data?.response?.containers ?? [];
        all   = all.concat(batch);
        dinfo('[nugs-catalog]', artist.name, 'page', page, '— got', batch.length, 'containers (offset:', offset, ')');
        offset += PAGE;
      } while (batch.length === PAGE);
      dinfo('[nugs-catalog]', artist.name, '— total fetched:', all.length);
      nugsReleasesCache[artist.id] = all;
    }
    renderArtists(state.filteredArtists);
    const allReleases = nugsReleasesCache[artist.id];

    // Year/month map (for the By Year tab only)
    const byYear = {};
    allReleases.forEach(r => {
      const d = nugsIsoDate(r.performanceDate);
      const [y, m] = d.split('-');
      if (!y) return;
      if (!byYear[y]) byYear[y] = { count: 0, months: {} };
      byYear[y].count++;
      if (m) byYear[y].months[m] = (byYear[y].months[m] ?? 0) + 1;
    });
    const years = Object.keys(byYear).sort((a, b) => b - a);

    // Per-artist UI state — `tab` is the active tab id; `filters` only applies
    // to the By Year tab.
    let tab = NUGS_TAB_DEFAULT;
    // selectedYear is null while the By Year tab shows the year-picker grid;
    // it becomes a year string once the user drills into a year.
    let selectedYear = null;
    // selectedSongKey is null while the Songs tab shows the song catalog;
    // it becomes the normalised key once the user drills into a song.
    let selectedSongKey = null;
    let songCatalog = null; // memoised across tab switches
    const filters = { sortAsc: false, year: null, month: null, type: 'all' };

    // The Nugs song-detail back-button dispatches this so the outer scope
    // can pop selectedSongKey and re-render the catalog list. We replace
    // any previous listener (from a prior artist visit) so handlers don't
    // accumulate and write into a stale closure's DOM.
    if (window._nugsSongBackHandler) {
      window.removeEventListener('nugs-song-back', window._nugsSongBackHandler);
    }
    window._nugsSongBackHandler = () => { selectedSongKey = null; refresh(); };
    window.addEventListener('nugs-song-back', window._nugsSongBackHandler);

    function renderTabBar() {
      const tb = $('nugsArtistTabs');
      if (!tb) return;
      tb.innerHTML = NUGS_TABS.map(t =>
        `<button class="nugs-tab-btn${tab === t.id ? ' active' : ''}" data-tab="${t.id}">${esc(t.label)}</button>`
      ).join('');
      tb.querySelectorAll('.nugs-tab-btn').forEach(btn =>
        btn.addEventListener('click', () => {
          if (tab === btn.dataset.tab) {
            // Clicking the active two-layer tab pops back to the picker.
            if (tab === 'year'  && selectedYear)    { selectedYear = null; filters.year = null; filters.month = null; refresh(); }
            if (tab === 'songs' && selectedSongKey) { selectedSongKey = null; refresh(); }
            return;
          }
          tab = btn.dataset.tab;
          // Switching tabs resets every drill-down state.
          selectedYear = null;
          selectedSongKey = null;
          filters.year = null;
          filters.month = null;
          refresh();
        }));
    }

    function renderFilterBar() {
      const fc = $('nugsFilterControls');
      if (!fc) return;
      // Filter bar is only meaningful inside the By Year drill-down. The
      // year picker itself doesn't need filters — picking a year IS the
      // filter at that level.
      if (tab !== 'year' || !selectedYear) { fc.innerHTML = ''; return; }

      const monthsForYear = Object.keys(byYear[selectedYear]?.months ?? {}).sort();
      const monthOpts = `<option value="">All Months</option>`
        + monthsForYear.map(m => {
            const name  = MONTH_NAMES[parseInt(m, 10) - 1] ?? m;
            const count = byYear[selectedYear].months[m];
            return `<option value="${m}"${filters.month === m ? ' selected' : ''}>${name} (${count})</option>`;
          }).join('');

      fc.innerHTML = `
        <button class="filter-btn nugs-back-btn" id="nfBackYears" title="Back to year picker">← All years</button>
        <div class="filter-sep"></div>
        <button class="filter-btn${!filters.sortAsc ? ' active' : ''}" id="nfSortDesc">Date ▾</button>
        <button class="filter-btn${filters.sortAsc  ? ' active' : ''}" id="nfSortAsc">Date ▴</button>
        <div class="filter-sep"></div>
        <button class="filter-btn${filters.type === 'all'   ? ' active' : ''}" id="nfTypeAll">All</button>
        <button class="filter-btn${filters.type === 'audio' ? ' active' : ''}" id="nfTypeAudio">Audio</button>
        <button class="filter-btn${filters.type === 'video' ? ' active' : ''}" id="nfTypeVideo">🎬 Video</button>
        <div class="filter-sep"></div>
        <select id="nfMonth" class="filter-select">${monthOpts}</select>`;

      $('nfBackYears').addEventListener('click',  () => {
        selectedYear = null; filters.year = null; filters.month = null; refresh();
      });
      $('nfSortDesc').addEventListener('click',  () => { filters.sortAsc = false; refresh(); });
      $('nfSortAsc').addEventListener('click',   () => { filters.sortAsc = true;  refresh(); });
      $('nfTypeAll').addEventListener('click',   () => { filters.type = 'all';   refresh(); });
      $('nfTypeAudio').addEventListener('click', () => { filters.type = 'audio'; refresh(); });
      $('nfTypeVideo').addEventListener('click', () => { filters.type = 'video'; refresh(); });
      $('nfMonth').addEventListener('change', e => {
        filters.month = e.target.value || null; refresh();
      });
    }

    function getReleasesForTab() {
      switch (tab) {
        case 'recent':  return sortByRecent(allReleases);
        case 'popular': return sortByPopular(allReleases);
        case 'year':
          // First layer of the By Year tab is the year picker, not a release
          // list. We return [] here and let renderForTab() draw the year grid.
          if (!selectedYear) return [];
          // Second layer — apply the year + month filter combo.
          filters.year = selectedYear;
          return applyNugsFilters(allReleases, filters);
        default: return allReleases;
      }
    }

    function renderTabHint(list, sortNote) {
      const el = $('nugsTabHint');
      if (!el) return;
      el.innerHTML = `<span class="nugs-tab-hint-count">${list.length} release${list.length === 1 ? '' : 's'}</span>
        <span class="nugs-tab-hint-sep">·</span>
        <span class="nugs-tab-hint-sort">${esc(sortNote)}</span>`;
    }

    /** Year-picker grid — first layer of the By Year tab. Each tile is a
     *  square-ish card with the year as large typography and the show count
     *  underneath. Reuses the .show-cards / .show-card classes so spacing
     *  and responsive reflow match the release grid. */
    function renderYearPicker() {
      const el = $('nugsReleaseList');
      if (!el) return;
      if (!years.length) {
        el.innerHTML = `<div class="empty-state" style="padding:24px;color:var(--text3);text-align:center">No releases for this artist</div>`;
        return;
      }
      const heroColor = artistColor(artist.name);
      el.innerHTML = `<div class="show-cards" id="nugsYearGrid">${years.map(y => `
        <div class="show-card nugs-year-card" data-year="${esc(y)}">
          <div class="show-card-art typo nugs-year-card-art" style="background:${heroColor}">
            <div class="nugs-year-tile">${esc(y)}</div>
            <div class="card-play">&#9654;</div>
          </div>
          <div class="show-card-body">
            <div class="show-card-date">${esc(y)}</div>
            <div class="show-card-venue">${byYear[y].count} release${byYear[y].count === 1 ? '' : 's'}</div>
          </div>
        </div>`).join('')}</div>`;
      el.querySelectorAll('.nugs-year-card').forEach(card =>
        card.addEventListener('click', () => {
          selectedYear = card.dataset.year;
          filters.year = selectedYear;
          filters.month = null;
          refresh();
        }));
    }

    function refresh() {
      renderTabBar();
      renderFilterBar();

      // ── Songs tab ───────────────────────────────────────────────────────
      // Two layers: catalog list, then song detail (stats + shows containing).
      if (tab === 'songs') {
        if (!songCatalog) {
          songCatalog = aggregateNugsSongs(allReleases);
          // One-shot diagnostic so we can see what the catalog response
          // actually contains. If `withSetlist` is much less than
          // `totalContainers`, Nugs is shipping sparse setlist data and
          // play counts will look low — that's the upstream limitation
          // we'd address with setlist.fm in v1.13.
          const d = nugsSongsDiagnostics(allReleases);
          dinfo('[nugs-songs]', artist.name, '— containers:',
            d.totalContainers, '· with setlist:', d.withSetlist,
            `(${d.coveragePct}%)`, '· avg tracks/show:', d.avgTracksPerShow,
            '· unique songs:', songCatalog.length);
          if (d.sampleEmpty) {
            dinfo('[nugs-songs] sample container WITHOUT setlist:', d.sampleEmpty);
          }
          if (d.sampleFilled) {
            dinfo('[nugs-songs] sample container WITH setlist:', d.sampleFilled);
          }
        }
        if (!selectedSongKey) {
          renderNugsSongsList(songCatalog, allReleases, artist, key => {
            selectedSongKey = key;
            refresh();
          });
          // Custom hint copy for the catalog view.
          const hintEl = $('nugsTabHint');
          if (hintEl) {
            hintEl.innerHTML = `<span class="nugs-tab-hint-count">${songCatalog.length} song${songCatalog.length === 1 ? '' : 's'}</span>
              <span class="nugs-tab-hint-sep">·</span>
              <span class="nugs-tab-hint-sort">Pick a song to see stats and the shows containing it</span>`;
          }
          return;
        }
        // Song detail view.
        const songEntry = songCatalog.find(s => s.key === selectedSongKey);
        if (!songEntry) { selectedSongKey = null; refresh(); return; }
        renderNugsSongDetail(songEntry, allReleases, artist);
        return;
      }

      // First layer of the By Year tab — show a year picker grid instead of
      // any release list. Tab-hint reports the year count rather than a
      // release count.
      if (tab === 'year' && !selectedYear) {
        renderTabHint(
          { length: years.length },
          'Pick a year to see all releases from that year'
        );
        // Custom message override for the year picker — render counts
        // accurately ("N years" not "N releases").
        const hintEl = $('nugsTabHint');
        if (hintEl) {
          hintEl.innerHTML = `<span class="nugs-tab-hint-count">${years.length} year${years.length === 1 ? '' : 's'}</span>
            <span class="nugs-tab-hint-sep">·</span>
            <span class="nugs-tab-hint-sort">Pick a year to see all releases from that year</span>`;
        }
        renderYearPicker();
        return;
      }

      const list = getReleasesForTab();
      let sortNote;
      switch (tab) {
        case 'recent':
          sortNote = 'Sorted by date added to catalog (newest first)';
          break;
        case 'popular':
          sortNote = 'Sorted by all-time sales';
          break;
        case 'year': {
          const monthName = filters.month
            ? MONTH_NAMES[parseInt(filters.month, 10) - 1] + ' '
            : '';
          sortNote = `Showing ${monthName}${selectedYear} (sorted by performance date)`;
          break;
        }
        default:
          sortNote = '';
      }
      renderTabHint(list, sortNote);
      renderNugsReleaseGrid(list, artist);
    }

    const ci            = nugsCI();
    ci.style.overflow   = 'hidden';
    ci.style.padding    = '0';
    const nugsHeroColor = artistColor(artist.name);
    ci.innerHTML = `
      <div id="nugsArtistWrap">
        <div id="nugsArtistTop">
          <div class="nugs-artist-hero" style="--hero-bg:${nugsHeroColor}">
            <div class="nugs-artist-hero-art" style="background:${nugsHeroColor}">
              <span class="art-hero-init">${esc(artist.name[0]?.toUpperCase() ?? '?')}</span>
            </div>
            <div class="nugs-artist-hero-info">
              <div class="artist-hero-label">nugs.net</div>
              <div class="artist-hero-name nugs-hero-name">${esc(artist.name)}</div>
              <div class="artist-hero-meta">${allReleases.length} releases</div>
            </div>
          </div>
          <div id="artistBioCard" class="artist-bio loading"></div>
          <div id="nugsArtistTabs" class="nugs-artist-tabs"></div>
          <div id="nugsTabHint" class="nugs-tab-hint"></div>
          <div id="nugsFilterControls"></div>
        </div>
        <div id="nugsReleaseList"></div>
      </div>`;
    fadeIn(ci);
    injectArtistBio(artist.name);
    refresh();
  } catch (e) {
    if (e.message?.includes('nugs:')) { handleNugsAuthError(e); return; }
    console.error('[views-nugs] nugsViewArtist', e);
    nugsCI().innerHTML = `<div class="error-state"><p>${esc(e.message)}</p></div>`;
  }
}

/* ── nugsViewRelease ─────────────────────────────── */
export async function nugsViewRelease(artist, containerId) {
  nav.record(nugsViewRelease, [artist, containerId]);
  setBreadcrumb([
    { label: artist.name, fn: () => nugsViewArtist(artist) },
    { label: containerId },
  ]);
  nugsCI().innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
  try {
    const data      = await nugsApi.release(containerId);
    const container = data?.Response ?? data?.response ?? {};
    const tracks    = container.tracks ?? container.Tracks ?? [];
    // Single source of truth for nugs cover-art URL resolution lives in
    // api.js's nugsContainerImage. We request a larger image here for the
    // show-detail hero (default is 300px wide for grid cards).
    const showArtUrl = nugsContainerImage(container, { width: 600 });

    const displayDate = container.performanceDate ?? containerId;
    const venue       = [container.venueName, container.venueCity].filter(Boolean).join(' — ');
    setBreadcrumb([
      { label: artist.name, fn: () => nugsViewArtist(artist) },
      { label: displayDate },
    ]);

    const containerSkuId = container.svodskuID && container.svodskuID !== 0
      ? String(container.svodskuID)
      : String((container.products ?? [])[0]?.skuID ?? '');
    const containerVideoUrl = container.videoURL || container.vodURL || null;
    const isVideoRelease    = !!(containerVideoUrl || container.videoChapters
      || container.containerTypeStr?.toLowerCase().includes('video'));

    // A release can be tagged as "video" upstream (containerTypeStr includes
    // "video", or has a videoURL) but still ship audio tracks alongside the
    // video. We render BOTH buttons in that case rather than hiding Play All.
    const audioTrackCount = tracks.filter(t =>
      !(t.videoProduct || t.mp4Product || t.videoondemandProduct)).length;
    const hasAudioTracks = audioTrackCount > 0;

    const normTracks = tracks.map((t, i) => ({
      uuid:              `nugs-${containerId}-${t.trackID ?? i}`,
      title:             t.songTitle ?? t.title ?? `Track ${i + 1}`,
      duration:          t.totalRunningTime ?? t.duration ?? 0,
      stream_url:        null,
      _nugs:             true,
      _nugs_video:       !!(t.videoProduct || t.mp4Product || t.videoondemandProduct),
      _nugs_trackId:     String(t.trackID ?? ''),
      _nugs_skuId:       containerSkuId,
      _nugs_containerId: String(containerId),
    }));

    const artColor = artistColor(artist.name);
    nugsCI().innerHTML = `
      <div class="show-header" style="--hero-bg:${artColor}">
        <div class="show-header-wrap">
          <div class="show-art" id="nugsShowArt" style="background:${artColor}">
            <span class="art-init">${esc((artist.name[0] ?? 'N').toUpperCase())}</span>
          </div>
          <div class="show-header-info">
            <h1>${esc(displayDate)}</h1>
            ${venue ? `<div class="show-venue-full">${esc(venue)}</div>` : ''}
            <div class="show-tags">
              <span class="tag tag-green">nugs.net</span>
              ${hasAudioTracks ? `<span class="tag">${audioTrackCount} tracks</span>` : ''}
              ${isVideoRelease ? '<span class="tag">🎬 Video</span>' : ''}
            </div>
            <div class="show-actions">
              ${hasAudioTracks
                ? `<button class="action-btn primary" id="btnNugsPlayAll">&#9654; Play All</button>` : ''}
              ${isVideoRelease
                ? `<button class="action-btn${hasAudioTracks ? '' : ' primary'}" id="btnNugsWatchVideo">🎬 Watch Video</button>` : ''}
              ${hasAudioTracks
                ? `<button class="action-btn" id="btnNugsDownloadShow" title="Archive every track to your Music folder">⬇ Download Show</button>` : ''}
              <button class="action-btn attended-btn${store.isAttended(`nugs-${artist.id}`, nugsIsoDate(displayDate)) ? ' active' : ''}" id="btnNugsAttended">📍 I Was There</button>
            </div>
          </div>
        </div>
      </div>
      <div id="nugsTrackList">
        ${await renderNugsTracksWithSetLabels(normTracks, artist, displayDate)}
      </div>`;
    fadeIn();

    const playShow = {
      display_date: displayDate,
      venue:        { name: venue },
      _nugs:        true,
      _art:         showArtUrl,
      _containerId: containerId,
    };

    const artEl = $('nugsShowArt');

    function fetchLastFmFallback() {
      lastfmArtistImage(artist.name).then(imgUrl => {
        if (!imgUrl) return;
        artist._wikiImg = imgUrl;
        if (!playShow._artData) playShow._artData = imgUrl;
        if (artEl && !artEl.querySelector('img')) {
          const img = new Image();
          img.alt = artist.name;
          img.onload = () => { artEl.innerHTML = ''; artEl.appendChild(img); artEl.style.background = ''; };
          img.src = imgUrl;
        }
        if (state.artist?.slug === artist.slug) setPlayerArt(artist, imgUrl, state.show);
      });
    }

    if (showArtUrl && artEl) {
      dlog('[Nugs Art] Loading from CDN:', showArtUrl);
      const img = document.createElement('img');
      img.alt             = displayDate || artist.name;
      img.style.width     = '100%';
      img.style.height    = '100%';
      img.style.objectFit = 'cover';
      img.onload = () => {
        if (img.naturalWidth < 10) {
          console.warn('[Nugs Art] Placeholder pixel received — falling back to Last.fm');
          fetchLastFmFallback();
          return;
        }
        dlog(`[Nugs Art] SUCCESS! ${img.naturalWidth}x${img.naturalHeight}`);
        artEl.innerHTML = '';
        artEl.appendChild(img);
        artEl.style.background = 'transparent';
        playShow._artData = showArtUrl;
        lastfmArtistImage(artist.name).then(u => { if (u) artist._wikiImg = u; });
      };
      img.onerror = () => {
        console.error('[Nugs Art] CDN load failed — falling back to Last.fm');
        fetchLastFmFallback();
      };
      img.src = showArtUrl;
    } else {
      fetchLastFmFallback();
    }

    $('nugsTrackList').querySelectorAll('.track-row').forEach(row =>
      row.addEventListener('click', () => {
        const track = normTracks.find(t => t.uuid === row.dataset.trackUuid);
        if (!track) return;
        if (!track._nugs_video) {
          const audioTracks = normTracks.filter(t => !t._nugs_video);
          const startIdx    = audioTracks.indexOf(track);
          state.originalQueue = audioTracks;
          state.queue    = state.shuffleOn ? [track, ...shuffle(audioTracks.filter(t => t !== track))] : audioTracks;
          state.queueIdx = state.shuffleOn ? 0 : startIdx;
          state.artist   = artist;
          state.show     = playShow;
        }
        nugsResolveAndPlay(track, artist, playShow);
      }));

    if (isVideoRelease) {
      $('btnNugsWatchVideo')?.addEventListener('click', () => {
        const videoTrack = {
          uuid:              `nugs-vid-${containerId}`,
          title:             container.videoTitle || displayDate,
          duration:          0,
          stream_url:        containerVideoUrl || null,
          _nugs:             true,
          _nugs_video:       true,
          _nugs_skuId:       containerSkuId,
          _nugs_containerId: String(containerId),
        };
        nugsResolveAndPlay(videoTrack, artist, playShow);
      });
    }
    if (hasAudioTracks) {
      $('btnNugsPlayAll')?.addEventListener('click', () => {
        const audioTracks = normTracks.filter(t => !t._nugs_video);
        if (!audioTracks.length) return;
        state.originalQueue = audioTracks;
        state.queue    = state.shuffleOn ? shuffle(audioTracks) : audioTracks;
        state.queueIdx = 0;
        state.artist   = artist;
        state.show     = playShow;
        nugsResolveAndPlay(state.queue[0], artist, playShow);
      });

      // 📍 "I was there" — record attendance using the same db-attended store
      // that powers the Relisten side. Nugs entries use the slug pattern
      // `nugs-<artistID>` so the Library list can route them to nugsViewRelease.
      $('btnNugsAttended')?.addEventListener('click', () => {
        const btn = $('btnNugsAttended');
        const slug = `nugs-${artist.id}`;
        const isoDate = nugsIsoDate(displayDate);
        const synthArtist = { slug, name: artist.name };
        const synthShow = {
          display_date: isoDate,
          venue: {
            name:     container.venueName ?? '',
            location: [container.venueCity, container.venueState].filter(Boolean).join(', '),
          },
          // Stash the containerID so the Library list can re-open the right Nugs page.
          _nugsContainerId: String(containerId),
        };
        const nowAttended = store.toggleAttended(synthArtist, synthShow);
        btn.classList.toggle('active', nowAttended);
        showToast(nowAttended ? '📍 Marked as attended!' : 'Attendance removed');
      });

      // ⬇ Download Show — archive nugs audio tracks. Synthetic source carries
      // the _nugs flag so archive.js routes the IPC through the persisted
      // Nugs session partition (with cookies + stealth headers).
      $('btnNugsDownloadShow')?.addEventListener('click', async () => {
        const btn = $('btnNugsDownloadShow');
        if (!btn || btn.disabled) return;

        // Warn before starting — Nugs allows only one active stream per
        // account, so live playback will be paused for the duration of the
        // archive run. User can opt out of seeing this dialog again.
        if (!settings.getKey('skipNugsDownloadWarning', false)) {
          const r = await confirmDialog({
            title: 'Download Nugs show?',
            body:  'Nugs only allows one active stream per account, so any current playback will pause while the download runs. Audio will resume automatically when the archive completes.',
            okLabel: 'Download',
          });
          if (!r.ok) return;
          if (r.skipFuture) settings.setKey('skipNugsDownloadWarning', true);
        }

        btn.disabled = true;
        const orig = btn.textContent;
        const audioTracks = normTracks.filter(t => !t._nugs_video);
        const synthSource = { _nugs: true, tracks: audioTracks };
        const coverUrl = playShow._artData ?? showArtUrl ?? artist._wikiImg ?? null;
        try {
          await downloadFullShow(artist, playShow, synthSource, {
            coverUrl,
            onProgress: (cur, total) => { btn.textContent = `Archiving… ${cur}/${total}`; },
            onError:    (err) => console.warn('[btnNugsDownloadShow] track error:', err),
          });
        } catch (err) {
          console.error('[btnNugsDownloadShow] fatal:', err);
          showToast(`Archive failed: ${err.message ?? err}`);
        } finally {
          btn.disabled = false;
          btn.textContent = orig;
        }
      });
    }
  } catch (e) {
    if (e.message?.includes('nugs:')) { handleNugsAuthError(e); return; }
    console.error('[views-nugs] nugsViewRelease', e);
    nugsCI().innerHTML = `<div class="error-state"><p>${esc(e.message)}</p></div>`;
  }
}

/* ── nugsViewVideo ───────────────────────────────── */
export function nugsViewVideo(artist, show, track) {
  nav.record(nugsViewVideo, [artist, show, track]);
  setBreadcrumb([
    { label: artist.name, fn: () => nugsViewArtist(artist) },
    { label: show?.display_date ?? 'Video' },
    { label: track.title },
  ]);
  const url = track.stream_url;
  const titleText    = track.title;
  const subtitleText = `${artist.name} · ${show?.display_date ?? ''}`;
  nugsCI().innerHTML = `
    <div class="nugs-video-wrap">
      <video id="nugsVideoEl" class="nugs-video" controls></video>
      <div class="nugs-video-meta">
        <div class="section-title" style="font-size:14px">${esc(titleText)}</div>
        <div class="section-subtitle">${esc(subtitleText)}</div>
      </div>
      <div style="display:flex;gap:8px;margin-top:4px">
        <button class="action-btn" id="btnVideoFS">&#x26F6; Fullscreen</button>
        <button class="action-btn" id="btnVideoCast">&#x1F4FA; Cast</button>
      </div>
    </div>`;

  const vid = $('nugsVideoEl');
  let vidHls = null;

  if (url.includes('.m3u8') && typeof Hls !== 'undefined' && Hls.isSupported()) {
    vidHls = new Hls({ enableWorker: false, maxBufferLength: 30, maxMaxBufferLength: 60 });
    vidHls.loadSource(url);
    vidHls.attachMedia(vid);
    vidHls.on(Hls.Events.ERROR, (_, d) => {
      console.error('[nugsViewVideo] HLS error:', d.type, d.details, d.response?.code, url);
      if (d.fatal) showToast('Video stream error');
    });
  } else {
    vid.src = url;
  }
  vid.play().catch(() => {});

  $('btnVideoFS').addEventListener('click', () => vid.requestFullscreen?.());
  document.addEventListener('fullscreenchange', () => {
    const btn = $('btnVideoFS');
    if (btn) btn.textContent = document.fullscreenElement ? '✕ Exit Fullscreen' : '⛶ Fullscreen';
  }, { once: true });

  // ── Cast button ──────────────────────────────────────────────────
  let _castActive = false;
  $('btnVideoCast').addEventListener('click', async () => {
    if (_castActive) {
      await window.ipc?.castStop();
      _castActive = false;
      $('btnVideoCast').textContent = '📺 Cast';
      showToast('Cast stopped');
      vid.muted = false;
      return;
    }

    const btn = $('btnVideoCast');
    btn.style.opacity = '0.5';
    showToast('Searching for Cast devices…');
    const res = await window.ipc?.castDiscover();
    btn.style.opacity = '';

    if (!res?.ok || !res.devices?.length) {
      showToast('No Cast devices found on this network');
      return;
    }

    // Show device picker
    const list = $('castPickerList');
    if (!list) return;
    list.innerHTML = res.devices.map((d, i) =>
      `<div class="cast-device-item" data-idx="${i}">${esc(d.name)}</div>`
    ).join('');
    const picker = $('castPicker');
    picker.style.display = 'flex';

    list.querySelectorAll('.cast-device-item').forEach(el =>
      el.addEventListener('click', async () => {
        picker.style.display = 'none';
        const device = res.devices[+el.dataset.idx];
        showToast(`Connecting to ${device.name}…`);

        const conn = await window.ipc?.castConnect(device.host, device.port);
        if (!conn?.ok) { showToast(`Cast failed: ${conn?.error}`); return; }

        const loadRes = await window.ipc?.castLoad(
          url,
          url.includes('.m3u8') ? 'application/x-mpegURL' : 'video/mp4',
          titleText,
          ''
        );
        if (!loadRes?.ok) { showToast(`Cast load failed: ${loadRes?.error}`); return; }

        _castActive = true;
        $('btnVideoCast').textContent = '⏹ Stop Cast';
        showToast(`Casting to ${device.name}`);
        vid.muted = true;
      })
    );
  });
}

/* ── Nugs search (used by views-core runSearch) ──── */
export function searchNugsLocal(q) {
  const lq = q.toLowerCase();
  const results = [];
  for (const [artistId, releases] of Object.entries(nugsReleasesCache ?? {})) {
    const artist = nugsArtistStore.get().find(a => a.id === artistId);
    for (const r of (releases ?? [])) {
      const date  = nugsIsoDate(r.performanceDate ?? '');
      const venue = [r.venueName, r.venueCity].filter(Boolean).join(' ');
      if (date.includes(lq) || venue.toLowerCase().includes(lq) || (r.setlistData ?? '').toLowerCase().includes(lq)) {
        results.push({
          display_date: date,
          artist_slug:  artist?.slug ?? artistId,
          artist_name:  artist?.name ?? '',
          venueName:    venue,
        });
      }
    }
  }
  return Promise.resolve(results);
}

/* ═══════════════════════════════════════════════════════════════════
   Nugs Dynamic Dashboard
   Tabs: Live · Recent · My Stash
   Each tab scrapes nugs.net SSR HTML and renders glassmorphic cards.
   ═══════════════════════════════════════════════════════════════════ */

const DASH_TABS = [
  { id: 'live',   label: '● Live',   scrape: scrapeLive   },
  { id: 'recent', label: 'Recent',   scrape: scrapeRecent },
  { id: 'stash',  label: 'My Stash', scrape: scrapeStash  },
];

// Per-tab cache so switching tabs doesn't re-fetch
const _dashCache = {};

export async function viewNugsDashboard(initialTab) {
  nav.record(viewNugsDashboard, [initialTab]);
  setBreadcrumb([{ label: 'Nugs' }]);

  const ci = $('nugsContentInner');
  ci.style.overflow = '';
  ci.style.padding  = '';

  ci.innerHTML = `
    <div class="nugs-dash">
      <div class="nugs-dash-header">
        <div class="nugs-dash-tabs" id="nugsDashTabs">
          ${DASH_TABS.map((t, i) => `
            <button class="nugs-dash-tab${i === 0 ? ' active' : ''}" data-tab="${t.id}">
              ${t.label}
            </button>`).join('')}
        </div>
      </div>
      <div class="nugs-dash-body" id="nugsDashBody">
        <div class="loading"><div class="spinner"></div></div>
      </div>
    </div>`;

  let activeTab = DASH_TABS[0].id;

  async function loadTab(tabId) {
    const tab = DASH_TABS.find(t => t.id === tabId);
    if (!tab) return;
    activeTab = tabId;

    // Update tab active state
    $('nugsDashTabs').querySelectorAll('.nugs-dash-tab').forEach(btn =>
      btn.classList.toggle('active', btn.dataset.tab === tabId));

    const body = $('nugsDashBody');
    if (!body) return;

    // Use cache if available
    if (_dashCache[tabId]) {
      try { renderDashCards(body, _dashCache[tabId], tabId); } catch (renderErr) {
        console.warn('[nugs-dash] renderDashCards from cache failed:', renderErr);
        showNugsUnavailable(body, tabId, renderErr);
      }
      return;
    }

    body.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;

    try {
      const cards = await tab.scrape();
      _dashCache[tabId] = cards;
      try {
        renderDashCards(body, cards, tabId);
      } catch (renderErr) {
        console.warn('[nugs-dash] renderDashCards failed:', renderErr);
        showNugsUnavailable(body, tabId, renderErr);
      }
    } catch (err) {
      console.warn('[nugs-dash] scrape error', tabId, err.message);
      showNugsUnavailable(body, tabId, err);
    }
  }

  function showNugsUnavailable(body, tabId, err) {
    const tab = DASH_TABS.find(t => t.id === tabId);
    const label = tab?.label.replace('●', '').trim() ?? tabId;
    const is401 = err?.message?.includes('401') || err?.message?.includes('403');
    const isBusy = err?.message?.includes('busy');
    const msg = is401
      ? 'Sign in to your Nugs account in Settings.'
      : isBusy
        ? 'The scraper is busy — please wait a moment and retry.'
        : 'Nugs temporarily unavailable. Check your connection or try again.';
    if (!body) return;
    body.innerHTML = `
      <div class="empty-state" style="padding:40px;text-align:center;color:var(--text3)">
        <div style="font-size:32px;margin-bottom:12px">📡</div>
        <div style="font-size:14px;font-weight:600;color:var(--text2);margin-bottom:8px">
          Couldn't load ${esc(label)}
        </div>
        <div style="font-size:12px;margin-bottom:16px">${esc(msg)}</div>
        <button class="action-btn" id="dashRetry">Retry</button>
      </div>`;
    $('dashRetry')?.addEventListener('click', () => loadTab(tabId));
  }

  function renderDashCards(container, cards, tabId) {
    if (!cards?.length) {
      container.innerHTML = `
        <div class="empty-state" style="padding:40px;text-align:center;color:var(--text3)">
          <div style="font-size:32px;margin-bottom:12px">🎵</div>
          <div style="font-size:13px">Nothing here yet</div>
        </div>`;
      return;
    }

    container.innerHTML = `<div class="nugs-dash-grid" id="nugsDashGrid"></div>`;
    const grid = $('nugsDashGrid');

    grid.innerHTML = cards.map((card, idx) => {
      // Artist cards use { name, imageUrl, linkUrl }
      // Show/release cards use { title, artist, date, imageUrl, linkUrl, isLive }
      const displayName = card.name ?? card.title ?? 'Untitled';
      const initials    = (card.name ?? card.artist ?? card.title ?? '?')[0]?.toUpperCase() ?? '?';
      return `
      <div class="nugs-dash-card${card.isLive ? ' is-live' : ''}" data-idx="${idx}">
        <div class="nugs-dash-card-art">
          ${card.imageUrl
            ? `<img src="${esc(card.imageUrl)}" alt="${esc(displayName)}" loading="lazy">`
            : `<div class="nugs-dash-card-init">${esc(initials)}</div>`}
          ${card.isLive ? `<div class="nugs-dash-live-badge">● LIVE</div>` : ''}
          <div class="nugs-dash-card-overlay">
            <div class="nugs-dash-card-play">▶</div>
          </div>
        </div>
        <div class="nugs-dash-card-info">
          <div class="nugs-dash-card-title">${esc(displayName)}</div>
          ${card.artist ? `<div class="nugs-dash-card-artist">${esc(card.artist)}</div>` : ''}
          ${card.date   ? `<div class="nugs-dash-card-date">${esc(card.date)}</div>` : ''}
        </div>
      </div>`;
    }).join('');

    grid.querySelectorAll('.nugs-dash-card').forEach(el => {
      el.addEventListener('click', () => {
        const card = cards[+el.dataset.idx];
        if (!card) return;
        handleDashCardClick(card);
      });
    });
  }

  async function handleDashCardClick(card) {
    if (!card.linkUrl) return;

    const cid = extractContainerId(card.linkUrl);
    if (!cid) {
      showToast('Could not identify this show');
      console.warn('[nugs-dash] no container ID for:', card.linkUrl);
      return;
    }

    showToast('Loading…');
    try {
      const data      = await nugsApi.release(cid);
      const container = data?.Response ?? data?.response ?? {};

      const containerVideoUrl = container.videoURL || container.vodURL || null;

      // Only route to release page if the container is provably audio-only:
      // all products are MP3/FLAC/WAV and there is no video SKU or direct video URL.
      const products    = container.products ?? [];
      const isAudioOnly = products.length > 0
        && products.every(p => /^(mp3|flac|wav|aac)$/i.test(p.formatStr ?? ''))
        && !(container.svodskuID && container.svodskuID !== 0)
        && !containerVideoUrl;

      const artist = {
        id:   String(container.artistID ?? ''),
        name: card.artist || container.artistName || 'Nugs',
        slug: `nugs-${cid}`,
        _nugs: true,
      };

      if (isAudioOnly) {
        // Audio-only recording — show the release page with Play All / track list
        nugsViewRelease(artist, String(cid));
      } else {
        const skuId = container.svodskuID && container.svodskuID !== 0
          ? String(container.svodskuID)
          : String(products[0]?.skuID ?? '');
        const show = {
          display_date: container.performanceDate ?? '',
          venue: { name: [container.venueName, container.venueCity].filter(Boolean).join(' — ') },
          _nugs: true,
        };
        const videoTrack = {
          uuid:              `nugs-dash-${cid}`,
          title:             container.videoTitle || container.performanceDate || card.title || 'Show',
          duration:          0,
          stream_url:        containerVideoUrl || null,
          _nugs:             true,
          _nugs_video:       true,
          _nugs_skuId:       skuId,
          _nugs_containerId: String(cid),
        };
        await nugsResolveAndPlay(videoTrack, artist, show);
      }
    } catch (err) {
      handleNugsAuthError(err);
    }
  }

  // Wire tab buttons and load first tab
  $('nugsDashTabs').querySelectorAll('.nugs-dash-tab').forEach(btn =>
    btn.addEventListener('click', () => loadTab(btn.dataset.tab)));

  // initialTab: 'live' | 'recent' | 'stash' — defaults to 'live'
  loadTab(DASH_TABS.some(t => t.id === initialTab) ? initialTab : 'live');
}

