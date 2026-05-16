/* ── views-core.js — Relisten browsing: artists, years, shows, search ── */
import { $, esc, fmt, stars, artistColor, showToast, shuffle, safeInnerHTML } from './utils.js';
import { state, store, settings, nav, nugsAuth, nugsArtistStore, nugsReleasesCache, sidebarSource } from './state.js';
import { api, nugsApi } from './api.js';
import { lastfmArtistImage, injectArtistBio, lastfmSimilarArtists } from './lastfm.js';
import {
  player, queueAndPlay, flatTracks, radioMode, setRadioMode,
  setPlayerArt, showTapePickerForTrack, openCompanion, closeCompanion,
  audio,
} from './player.js';
// Circular-safe: views-nugs imports from views-core, but these are only ever
// called inside function bodies (event handlers / async calls), never at init.
import { nugsViewArtist, nugsViewRelease, searchNugsLocal } from './views-nugs.js';
import { resolveArtistId } from './nugs-scraper.js';
import { downloadFullShow } from './archive.js';
import {
  resolveShowArtist as _resolveShowArtistShared,
  dedupeRelistenSongs,
  trackContainsSong,
  normaliseSongTitle,
  aggregateRelistenShowsToSongs,
  classifySource,
  formatTaperLabel,
  isBestSource,
  pickPreferredSourceIdx,
} from '../shared/helpers.js';
import {
  isAvailable as setlistFmAvailable,
  getSongPlayCount,
} from './setlistfm.js';
import { pickPersonalizedSotd, hasEnoughSignal } from './personalization.js';

// Per-artist cache of song catalogs we built from setlist scans (used as
// a fallback when Relisten's /songs endpoint returns empty). Avoids
// re-scanning every Songs-tab visit. Cleared on app reload.
const _relistenSongsScanCache = new Map();


/* ── Show → artist resolution ──────────────────────────────────────────────
 * Implementation lives in app/shared/helpers.js (browser-free + unit-tested).
 * The shared version takes the artists cache as a parameter for testability;
 * this wrapper defaults to the live `state.artists`. */
export function resolveShowArtist(show) {
  return _resolveShowArtistShared(show, state.artists ?? []);
}

/* ── View helpers ────────────────────────────────── */
export const showLoading = () => {
  $('contentInner').innerHTML = `
    <div class="skeleton-list">
      ${Array.from({length: 6}, () => `
        <div class="skeleton-row">
          <div class="skel skel-date"></div>
          <div class="skel skel-venue"></div>
          <div class="skel skel-badge"></div>
        </div>`).join('')}
    </div>`;
};

export const fadeIn = (el = $('contentInner')) => {
  el.classList.remove('content-fadein');
  void el.offsetWidth;
  el.classList.add('content-fadein');
};

/* Map a raw error message (often an HTTP status string or a thrown
 * `nugs:*` sentinel) to a sentence the user can actually act on.
 * The original message is preserved underneath in muted text so the
 * developer-friendly form is still recoverable in screenshots. */
function friendlyErrorMessage(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { title: 'Something went wrong.', sub: '' };

  // Nugs sentinel codes thrown from api.js
  if (s.includes('nugs:unauthenticated')) {
    return {
      title: 'Sign in to nugs.net to continue.',
      sub: 'Open Settings → Nugs.net to connect your account.',
    };
  }
  if (s.includes('nugs:bad-response')) {
    return {
      title: 'Nugs returned an unexpected response.',
      sub: 'This usually clears up on its own — try again in a moment.',
    };
  }
  // Ghost scraper timeout
  if (/^ghost timeout/i.test(s)) {
    return {
      title: "Couldn't reach nugs.net.",
      sub: 'Check your connection or try again — nugs.net may be slow.',
    };
  }
  // HTTP status codes from Relisten / Nugs / setlist.fm
  const m = s.match(/\b(\d{3})\b/);
  if (m) {
    const code = parseInt(m[1], 10);
    if (code === 429) {
      return { title: 'Too many requests.', sub: 'Slow down — try again in a moment.' };
    }
    if (code >= 500) {
      return { title: 'The server is having trouble.', sub: 'Not your fault — try again in a minute.' };
    }
    if (code === 404) {
      return { title: 'Not found.', sub: 'This show or artist may have moved.' };
    }
    if (code === 401 || code === 403) {
      return { title: 'Access denied.', sub: 'Check that you\'re signed in.' };
    }
  }
  // Generic network-ish failures
  if (/network|fetch|enotfound|econnrefused|failed to fetch/i.test(s)) {
    return {
      title: 'Network error.',
      sub: 'Check your internet connection.',
    };
  }
  return { title: 'Something went wrong.', sub: s };
}

export const showError = (msg) => {
  const { title, sub } = friendlyErrorMessage(msg);
  $('contentInner').innerHTML =
    `<div class="error-state">
       <div class="icon">⚠️</div>
       <p class="error-title">${esc(title)}</p>
       ${sub ? `<p class="error-sub">${esc(sub)}</p>` : ''}
     </div>`;
};

/* ── Breadcrumb ──────────────────────────────────── */
// Cache search elements — they get re-parented into breadcrumb on every nav
const searchToggleEl = $('searchToggle');
const searchInlineEl = $('searchInline');

export function setBreadcrumb(parts) {
  // Reset style overrides on both content containers (nugs views use nugsContentInner)
  for (const id of ['contentInner', 'nugsContentInner']) {
    const ci = $(id);
    if (ci) { ci.style.overflow = ''; ci.style.padding = ''; }
  }
  // Close companion panel on any page navigation
  $('companionPanel')?.classList.remove('open');
  $('breadcrumb').innerHTML = '';
  parts.forEach((p, i) => {
    const el = document.createElement('span');
    el.className = i === parts.length - 1 ? 'bc-current' : 'bc-item';
    el.textContent = p.label;
    if (p.onClick || p.fn) el.addEventListener('click', p.onClick ?? p.fn);
    $('breadcrumb').appendChild(el);
    if (i < parts.length - 1) {
      const sep = document.createElement('span');
      sep.className = 'bc-sep'; sep.textContent = '›';
      $('breadcrumb').appendChild(sep);
    }
  });
  $('breadcrumb').appendChild(searchToggleEl);
  $('breadcrumb').appendChild(searchInlineEl);
}

/* ── navToCurrentArtist / tryRadio ──────────────── */
export function navToCurrentArtist() {
  const artist = state.playingArtist;
  if (!artist) return;
  document.querySelectorAll('.artist-item').forEach(i => i.classList.remove('active'));
  const sel = artist._nugs
    ? `.artist-item[data-nugs-slug="${CSS.escape(artist.slug)}"]`
    : `.artist-item[data-slug="${CSS.escape(artist.slug)}"]`;
  document.querySelector(sel)?.classList.add('active');
  if (artist._nugs) nugsViewArtist(artist);
  else viewYears(artist);
}

export async function tryRadio() {
  if (!radioMode || !state.artist?.name) return;
  showToast('Artist Radio: finding related artist…');
  try {
    const similar  = await lastfmSimilarArtists(state.artist.name);
    const lowerSim = new Set(similar.map(n => n.toLowerCase()));
    const matches  = state.artists.filter(a => lowerSim.has(a.name.toLowerCase()));
    if (!matches.length) { showToast('Radio: no similar artists found in library'); return; }
    const pick = matches[Math.floor(Math.random() * Math.min(matches.length, 8))];
    showToast(`Artist Radio → ${pick.name}`);
    state.artist = pick;
    document.querySelectorAll('.artist-item').forEach(i => i.classList.remove('active'));
    document.querySelector(`[data-slug="${CSS.escape(pick.slug)}"]`)?.classList.add('active');
    const show     = await api.random(pick.slug);
    const showData = await api.show(pick.slug, show.display_date);
    const src = (showData.sources ?? []).sort((a, b) =>
      (b.is_soundboard - a.is_soundboard) || ((b.avg_rating ?? 0) - (a.avg_rating ?? 0)))[0];
    if (src?.tracks?.length) { queueAndPlay(src.tracks, pick, showData, 0); viewShow(pick, show.display_date); }
  } catch (err) { console.error('[views-core] tryRadio', err); showToast('Radio: could not load show'); }
}

/* ── On This Date ────────────────────────────────── */
export async function viewToday() {
  nav.record(viewToday, []);
  showLoading();
  const now    = new Date();
  const month  = now.getMonth() + 1;
  const day    = now.getDate();
  const label  = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  const dayOrd = day + (['th','st','nd','rd'][day % 10 > 3 || ~~(day % 100 / 10) === 1 ? 0 : day % 10] ?? 'th');
  setBreadcrumb([{ label: `On This Day — ${label}` }]);
  try {
    // Same race as the welcome SOTD — wait briefly for state.artists so the
    // resolveShowArtist uuid-fallback works on cold boots.
    for (let i = 0; i < 30 && !state.artists?.length; i++) {
      await new Promise(r => setTimeout(r, 100));
    }
    const data  = await api.onDate(month, day);
    const shows = data.shows ?? data ?? [];
    if (!shows.length) {
      $('contentInner').innerHTML = `<div class="error-state"><p>No shows found for ${esc(label)}</p></div>`;
      return;
    }

    const byYear = {};
    for (const s of shows) {
      const yr = (s.display_date ?? '').slice(0, 4);
      (byYear[yr] ??= []).push(s);
    }
    const years = Object.keys(byYear).sort((a, b) => b - a);
    const totalArtists = new Set(shows.map(s => resolveShowArtist(s)?.slug).filter(Boolean)).size;

    safeInnerHTML($('contentInner'), `
      <div class="otd-hero">
        <div class="otd-hero-date">
          <span class="otd-month">${esc(now.toLocaleDateString('en-US',{month:'long'}))}</span>
          <span class="otd-day">${esc(dayOrd)}</span>
        </div>
        <div class="otd-hero-meta">
          <div class="otd-hero-count">${shows.length} shows</div>
          <div class="otd-hero-sub">${totalArtists} artists · ${years.length} years of recordings</div>
        </div>
      </div>
      <div id="otdTimeline">${years.map(yr => `
        <div class="otd-year-group">
          <div class="otd-year-label">${esc(yr)}</div>
          <div class="otd-year-shows">
            ${byYear[yr].map(s => {
              const artist = resolveShowArtist(s);
              if (!artist?.slug) return ''; // skip un-resolvable shows
              const color    = artistColor(artist.name);
              const init     = esc((artist.name[0] ?? '?').toUpperCase());
              const imgStyle = artist.image_url ? `background-image:url('${esc(artist.image_url)}')` : `background:${color}`;
              return `<div class="otd-row" data-slug="${esc(artist.slug)}" data-date="${esc(s.display_date)}">
                <div class="otd-avatar" style="${imgStyle}" data-name="${esc(artist.name)}">${artist.image_url ? '' : `<span>${init}</span>`}</div>
                <div class="otd-info">
                  <div class="otd-artist-name">${esc(artist.name)}</div>
                  <div class="otd-venue-name">${esc(s.venue?.name ?? '')}${s.venue?.location ? ` · ${esc(s.venue.location)}` : ''}</div>
                </div>
                <div class="otd-badges">
                  ${s.has_soundboard_source ? '<span class="badge badge-sbd">SBD</span>' : ''}
                  ${s.avg_rating ? `<span class="otd-rating">${stars(s.avg_rating)}</span>` : ''}
                </div>
                <button class="otd-play-btn" title="Play best recording">▶</button>
              </div>`;
            }).join('')}
          </div>
        </div>`).join('')}
      </div>`);

    fadeIn();

    $('otdTimeline').querySelectorAll('.otd-row').forEach(row => {
      const slug   = row.dataset.slug;
      const artist = state.artists.find(a => a.slug === slug) ?? { name: slug, slug };
      row.addEventListener('click', e => {
        if (e.target.classList.contains('otd-play-btn')) return;
        state.artist = artist; viewShow(artist, row.dataset.date);
      });
      row.querySelector('.otd-play-btn').addEventListener('click', async e => {
        e.stopPropagation();
        state.artist = artist;
        showLoading();
        try {
          const show = await api.show(artist.slug, row.dataset.date);
          const src  = (show.sources ?? []).sort((a,b) => (b.is_soundboard - a.is_soundboard) || (b.avg_rating - a.avg_rating))[0];
          if (src?.tracks?.length) { queueAndPlay(src.tracks, artist, show, 0); viewShow(artist, row.dataset.date); }
          else viewShow(artist, row.dataset.date);
        } catch { viewShow(artist, row.dataset.date); }
      });
    });

    for (const el of $('otdTimeline').querySelectorAll('.otd-avatar[data-name]')) {
      const name = el.dataset.name;
      if (el.querySelector('img') || !name) continue;
      lastfmArtistImage(name).then(url => {
        if (!url || el.querySelector('img')) return;
        const img = new Image(); img.alt = name;
        img.onload = () => { el.innerHTML = ''; el.appendChild(img); el.style.backgroundImage = ''; };
        img.src = url;
      });
    }
  } catch(e) { console.error('[views-core] viewToday', e); showError(e.message); }
}

/* ── Welcome ─────────────────────────────────────── */
/* ── Welcome stats summary ──────────────────────────────────────────────────
 * Compact stats row + resume-listening card on the welcome page. Hidden
 * when listening history is empty. Driven entirely by `store.getHistory()`
 * — the same data backing the full Stats page (`viewStats`). */
function renderWelcomeStats() {
  const wrap = $('welcomeStats');
  if (!wrap) return;
  const hist = store.getHistory();
  if (!hist.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';

  const totalTracks   = hist.length;
  const uniqueShows   = new Set(hist.map(h => `${h.artistSlug}::${h.date}`).filter(k => k !== '::')).size;
  const uniqueArtists = new Set(hist.map(h => h.artistSlug).filter(Boolean)).size;
  const totalSecs     = hist.reduce((s, h) => s + (h.duration || 0), 0);
  const listenDisp    = totalSecs > 3600
    ? `${(totalSecs / 3600).toFixed(1)}h`
    : totalSecs > 0
      ? `${Math.round(totalSecs / 60)}m`
      : `~${Math.round(totalTracks * 6 / 60)}h`;

  // One-line strip — "42 tracks · 8 shows · 5 artists · 3.2h listening"
  // followed by a "View all →" link. Compact enough to not crowd OTD.
  const strip = $('welcomeStatsStrip');
  strip.innerHTML = `
    <div class="welcome-stats-strip-label">Your listening</div>
    <div class="welcome-stats-strip-vals">
      <span><strong>${totalTracks}</strong> tracks</span>
      <span class="welcome-stats-sep">·</span>
      <span><strong>${uniqueShows}</strong> shows</span>
      <span class="welcome-stats-sep">·</span>
      <span><strong>${uniqueArtists}</strong> artists</span>
      <span class="welcome-stats-sep">·</span>
      <span><strong>${esc(listenDisp)}</strong> listening</span>
    </div>
    <button class="welcome-stats-link" id="welcomeStatsAll">View all →</button>`;

  // "Pick up where you left off" stays as a clickable card under the strip.
  const last = hist.find(h => h.artistSlug && h.date);
  if (last) {
    const resumeEl = $('welcomeResume');
    resumeEl.innerHTML = `
      <div class="welcome-resume-show">
        <div class="welcome-resume-art" style="background:${artistColor(last.artistName)}">
          <span class="art-init">${esc((last.artistName?.[0] ?? '?').toUpperCase())}</span>
        </div>
        <div class="welcome-resume-meta">
          <div class="welcome-resume-label">Pick up where you left off</div>
          <div class="welcome-resume-artist">${esc(last.artistName ?? last.artistSlug)} <span class="welcome-resume-date">· ${esc(last.date)}${last.trackTitle ? ' · ' + esc(last.trackTitle) : ''}</span></div>
        </div>
        <button class="action-btn primary welcome-resume-play">▶ Play</button>
      </div>`;
    resumeEl.style.display = '';
    const resolveArtist = () =>
      state.artists.find(a => a.slug === last.artistSlug)
        ?? { name: last.artistName ?? last.artistSlug, slug: last.artistSlug };
    resumeEl.querySelector('.welcome-resume-show').addEventListener('click', () => {
      const a = resolveArtist();
      state.artist = a;
      viewShow(a, last.date);
    });
  }

  $('welcomeStatsAll').addEventListener('click', () => {
    import('./views-user.js').then(m => m.viewStats?.());
  });
}

/* ── Show of the Day rendering ──────────────────────────────────────────────
 * Lives on the welcome page. Driven by a "For You / Global" pill toggle —
 * see the comment at the call site in viewWelcome for the user-facing
 * contract. This function:
 *   1. Waits for state.artists to land (resolveShowArtist depends on it).
 *   2. Decides initial mode: persisted preference > "foryou" if signal
 *      exists > "global" otherwise.
 *   3. Renders the toggle if signal exists; binds click handlers that
 *      re-render in place.
 *   4. Defers per-mode work to renderSotdMode().
 * ─────────────────────────────────────────────────────────────────────── */
async function renderShowOfTheDay() {
  // Wait for artists list — both modes need it for show-artist resolution.
  for (let i = 0; i < 30 && !state.artists?.length; i++) {
    await new Promise(r => setTimeout(r, 100));
  }

  const wrap   = $('welcomeSotd');
  const toggle = $('sotdToggle');
  if (!wrap || !toggle) return;

  const haveSignal   = hasEnoughSignal();
  const persistedMode = localStorage.getItem('sotd-mode');
  // Default to "foryou" when we can; honour user's prior pick if valid.
  const initialMode = !haveSignal ? 'global'
                    : (persistedMode === 'global' || persistedMode === 'foryou')
                      ? persistedMode
                      : 'foryou';

  if (haveSignal) {
    toggle.style.display = '';
    toggle.querySelectorAll('.sotd-pill').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === initialMode);
      b.addEventListener('click', () => {
        const mode = b.dataset.mode;
        if (!mode) return;
        toggle.querySelectorAll('.sotd-pill').forEach(p =>
          p.classList.toggle('active', p === b));
        localStorage.setItem('sotd-mode', mode);
        renderSotdMode(mode);
      });
    });
  }

  renderSotdMode(initialMode);
}

async function renderSotdMode(mode) {
  const target = $('sotdContent');
  if (!target) return;
  target.innerHTML = `<div class="loading" style="height:50px;font-size:12px"><div class="spinner"></div></div>`;

  try {
    const today    = new Date().toISOString().slice(0, 10);
    const cacheKey = `sotd-${mode}-${today}`;
    let pick = null;

    // Cache hit?
    try {
      const c = JSON.parse(localStorage.getItem(cacheKey) || 'null');
      if (c?.show && c?.artist) pick = c;
    } catch { /* ignore corrupt cache */ }

    if (!pick) {
      // Both modes start by fetching trending — same pool either way.
      const data    = await api.trending();
      const shows   = (data.shows ?? data ?? []).filter(s => resolveShowArtist(s));

      if (mode === 'foryou') {
        const personalized = await pickPersonalizedSotd(today, shows);
        if (personalized?.show && personalized?.artist) {
          pick = {
            show:   personalized.show,
            artist: personalized.artist,
            reason: personalized.reason ?? null,
          };
        }
      }

      // Fallback path — no personalized pick, OR mode is "global".
      if (!pick) {
        if (!shows.length) { $('welcomeSotd').style.display = 'none'; return; }
        const seed = today.replace(/-/g, '');
        const show = shows[parseInt(seed.slice(-4)) % shows.length];
        const art  = resolveShowArtist(show);
        if (!art?.slug) { $('welcomeSotd').style.display = 'none'; return; }
        pick = { show, artist: art, reason: mode === 'foryou' ? null : '🔥 Trending today' };
      }

      try { localStorage.setItem(cacheKey, JSON.stringify(pick)); } catch { /* quota */ }
    }

    const { show, artist, reason } = pick;
    safeInnerHTML(target, `
      <div class="sotd-card" data-slug="${esc(artist.slug)}" data-date="${esc(show.display_date)}">
        ${reason ? `<div class="sotd-reason">${esc(reason)}</div>` : ''}
        <div class="sotd-artist">${esc(artist.name)}</div>
        <div class="sotd-meta">${esc(show.display_date)}${show.venue?.name ? ' · ' + esc(show.venue.name) : ''}${show.venue?.location ? ', ' + esc(show.venue.location) : ''}</div>
        ${show.avg_rating ? `<div class="sotd-rating">${'★'.repeat(Math.round(show.avg_rating))} ${show.avg_rating.toFixed(1)}</div>` : ''}
        <button class="action-btn primary sotd-play" style="margin-top:8px">▶ Play Show</button>
      </div>`);
    target.querySelector('.sotd-card').addEventListener('click', () => viewShow(artist, show.display_date));
    target.querySelector('.sotd-play').addEventListener('click', e => {
      e.stopPropagation();
      showLoading();
      try { viewShow(artist, show.display_date); } catch { /* non-critical */ }
    });
  } catch (err) {
    console.warn('[sotd] render failed:', err.message);
    $('welcomeSotd').style.display = 'none';
  }
}

export async function viewWelcome() {
  // Don't write to contentInner when it's hidden (nugs/mixlr source is active)
  if (sidebarSource !== 'relisten') return;
  nav.record(viewWelcome, []);
  $('breadcrumb').innerHTML = '';
  $('breadcrumb').appendChild(searchToggleEl);
  $('breadcrumb').appendChild(searchInlineEl);
  const now   = new Date();
  const label = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

  // First-run banner — shown on fresh installs (no listening history yet)
  // and dismissable forever via localStorage. The dismissed flag is set
  // implicitly the first time the user plays a show (see player.js when
  // store.pushHistory fires) so the banner stops appearing without the
  // user having to explicitly close it.
  const showFirstRunBanner =
    !store.getHistory().length &&
    localStorage.getItem('welcome-banner-dismissed') !== '1';

  safeInnerHTML($('contentInner'), `
    <div class="welcome">
      <img class="welcome-logo welcome-logo-img" src="../../assets/icon.svg" alt="Days Between">
      <h2>Days Between</h2>
      <p>Stream 70,000+ live concert recordings from Phish, Grateful Dead, and thousands more.
         Powered by <strong style="color:var(--accent)">Relisten</strong>.</p>
      <div class="welcome-actions">
        <button class="action-btn primary" id="btnWelcomeRandom">🎲 Random Show</button>
        <button class="action-btn" id="btnWelcomeRecent">🆕 Recently Added</button>
      </div>
      ${showFirstRunBanner ? `
      <div class="welcome-firstrun" id="welcomeFirstRun">
        <button class="welcome-firstrun-close" id="welcomeFirstRunClose" title="Dismiss">×</button>
        <div class="welcome-firstrun-title">👋 Welcome to Days Between</div>
        <div class="welcome-firstrun-body">
          Pick an artist from the sidebar, browse a show, and click ▶. As
          you listen and mark <em>"I was there"</em> on shows you attended,
          this welcome page will start picking shows tailored to you.
          Settings (⚙ top-right) connects Last.fm and nugs.net.
        </div>
      </div>` : ''}
      <div class="welcome-sotd" id="welcomeSotd">
        <div class="welcome-sotd-header">
          <div class="welcome-otd-title">🎵 Show of the Day</div>
          <div class="sotd-toggle" id="sotdToggle" style="display:none">
            <button class="sotd-pill" data-mode="foryou">For You</button>
            <button class="sotd-pill" data-mode="global">Global</button>
          </div>
        </div>
        <div id="sotdContent"><div class="loading" style="height:50px;font-size:12px"><div class="spinner"></div></div></div>
      </div>
      <div class="welcome-otd">
        <div class="welcome-otd-title">On This Day — ${esc(label)}</div>
        <div id="welcomeOtd"><div class="loading" style="height:60px;font-size:12px"><div class="spinner"></div>Loading…</div></div>
      </div>
      <div class="welcome-stats" id="welcomeStats" style="display:none">
        <div class="welcome-stats-strip" id="welcomeStatsStrip"></div>
        <div class="welcome-stats-resume" id="welcomeResume" style="display:none"></div>
      </div>
    </div>`);

  // ── Listening Stats summary ───────────────────────────────────────────
  // Hidden when history is empty (new install). Shows 4 stat tiles +
  // "Pick up where you left off" → resume the most recently played show.
  renderWelcomeStats();

  // First-run banner dismiss
  $('welcomeFirstRunClose')?.addEventListener('click', () => {
    localStorage.setItem('welcome-banner-dismissed', '1');
    $('welcomeFirstRun')?.remove();
  });

  $('btnWelcomeRecent').addEventListener('click', () => viewRecent());
  $('btnWelcomeRandom').addEventListener('click', async () => {
    if (!state.artists.length) return;
    const artist = state.artists[Math.floor(Math.random() * state.artists.length)];
    state.artist = artist;
    document.querySelectorAll('.artist-item').forEach(i => i.classList.remove('active'));
    document.querySelector(`[data-slug="${CSS.escape(artist.slug)}"]`)?.classList.add('active');
    showLoading();
    try {
      const show = await api.random(artist.slug);
      viewShow(artist, show.display_date);
    } catch(e) { showError(e.message); }
  });

  // ── Show of the Day ─────────────────────────────────────────────────
  // Two modes:
  //   "foryou" → personalization.pickPersonalizedSotd against the
  //              trending pool, falling back to api.random for the
  //              top-affinity artist if none of trending matches.
  //   "global" → original deterministic seeded pick from /trending.
  // Toggle pills appear once we detect any local signal (attended /
  // scrobbles / pinned / favShows). On a fresh install only "global"
  // is shown and the toggle stays hidden.
  //
  // Both modes cache today's pick in localStorage under
  // `sotd-${mode}-${date}` so re-toggling is instant. The user's last
  // chosen mode is persisted in `sotd-mode`.
  renderShowOfTheDay();

  try {
    // Same race as SOTD — wait for state.artists so resolveShowArtist can
    // fall back to uuid-lookup if a payload only ships artist_uuid.
    for (let i = 0; i < 30 && !state.artists?.length; i++) {
      await new Promise(r => setTimeout(r, 100));
    }
    const data  = await api.onDate(now.getMonth() + 1, now.getDate());
    const shows = (data.shows ?? data ?? []).slice(0, 20);
    if (!shows.length) {
      $('welcomeOtd').innerHTML = `<div style="font-size:12px;color:var(--text3)">No shows found for today.</div>`;
      return;
    }
    safeInnerHTML($('welcomeOtd'), shows.map(s => {
      const artist = resolveShowArtist(s);
      if (!artist?.slug) return ''; // skip shows we can't resolve to a slug
      return `<div class="otd-show-row" data-slug="${esc(artist.slug)}" data-date="${esc(s.display_date)}" style="margin-bottom:5px;padding:8px 12px">
        <div class="otd-artist" style="min-width:130px">${esc(artist.name)}</div>
        <div class="otd-year">${esc((s.display_date||'').slice(0,4))}</div>
        <div class="otd-venue">${esc(s.venue?.name??'')}</div>
      </div>`;
    }).join(''));
    $('welcomeOtd').querySelectorAll('.otd-show-row').forEach(row =>
      row.addEventListener('click', () => {
        const slug = row.dataset.slug;
        const artist = state.artists.find(a => a.slug === slug) || { name: slug, slug };
        state.artist = artist;
        viewShow(artist, row.dataset.date);
      }));
  } catch { $('welcomeOtd').innerHTML = `<div style="font-size:12px;color:var(--text3)">Could not load shows.</div>`; }
}

/* ── Global search ───────────────────────────────── */
// Wire search UI controls at module init
searchToggleEl.addEventListener('click', () => {
  const open = searchInlineEl.style.display === 'none';
  searchInlineEl.style.display = open ? 'flex' : 'none';
  searchToggleEl.classList.toggle('active', open);
  if (open) $('searchInput').focus();
});
$('searchClose').addEventListener('click', () => {
  searchInlineEl.style.display = 'none';
  searchToggleEl.classList.remove('active');
  $('searchInput').value = '';
});
let searchDebounce = null;
$('searchInput').addEventListener('input', e => {
  clearTimeout(searchDebounce);
  const q = e.target.value.trim();
  if (q.length < 3) return;
  searchDebounce = setTimeout(() => runSearch(q), 350);
});

export async function runSearch(q, yearFrom, yearTo) {
  nav.record(runSearch, [q, yearFrom, yearTo]);
  // Ensure the Relisten pane is visible regardless of which source was active.
  // Belt-and-suspenders: directly show/hide panes, then also fire the event so
  // app.js can update sidebar artists and source-tab button state.
  if (sidebarSource !== 'relisten') {
    setSidebarSource('relisten');
    const _ci  = $('contentInner');
    const _nci = $('nugsContentInner');
    const _mp  = $('mixlrPane');
    if (_ci)  _ci.style.display  = '';
    if (_nci) _nci.style.display = 'none';
    if (_mp)  _mp.style.display  = 'none';
    $('appBody')?.classList.remove('mixlr-active');
    document.querySelectorAll('.source-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.source === 'relisten'));
    renderArtists(state.filteredArtists);
  }
  showLoading();
  setBreadcrumb([{ label: `Search: "${q}"` }]);
  try {
    const songSearchPromise = state.artist?.slug
      ? api.songs(state.artist.slug).catch(() => ({ songs: [] }))
      : Promise.resolve({ songs: [] });

    const _settled = await Promise.allSettled([
      api.search(q),
      searchNugsLocal(q),
      songSearchPromise,
      nugsApi.allArtists().catch(() => []), // warms the artist cache silently
    ]);
    const data        = _settled[0].status === 'fulfilled' ? _settled[0].value : { artists: [], shows: [], venues: [] };
    const nugsResults = _settled[1].status === 'fulfilled' ? _settled[1].value : [];
    const songData    = _settled[2].status === 'fulfilled' ? _settled[2].value : { songs: [] };

    // ── Nugs artist search — instant local search against the cached catalog ──
    const nugsArtistHits = nugsApi.searchArtists(q);

    let artists = data.artists ?? [];
    let shows   = data.shows   ?? [];
    const venues  = data.venues  ?? [];

    if (yearFrom || yearTo) {
      const from = parseInt(yearFrom) || 0;
      const to   = parseInt(yearTo)   || 9999;
      const inRange = d => { const y = parseInt((d ?? '').slice(0, 4)); return y >= from && y <= to; };
      shows = shows.filter(s => inRange(s.display_date));
    }

    const lq = q.toLowerCase();
    const songMatches = (songData?.songs ?? [])
      .filter(s => (s.name ?? s.title ?? '').toLowerCase().includes(lq))
      .slice(0, 12);

    const total = artists.length + shows.length + venues.length + nugsResults.length + songMatches.length + nugsArtistHits.length;

    if (!total) {
      $('contentInner').innerHTML = `<div class="error-state"><p>No results for "${esc(q)}"</p></div>`;
      return;
    }

    const renderArtistRow = a => {
      const color = artistColor(a.name);
      const init  = esc((a.name[0] ?? '?').toUpperCase());
      const imgSt = a.image_url ? `background-image:url('${esc(a.image_url)}')` : `background:${color}`;
      return `<div class="sr-row" data-type="artist" data-slug="${esc(a.slug)}">
        <div class="sr-avatar" style="${imgSt}" data-name="${esc(a.name)}">${a.image_url ? '' : `<span>${init}</span>`}</div>
        <div class="sr-info"><div class="sr-title">${esc(a.name)}</div>
          <div class="sr-sub"><span class="badge badge-relisten">Relisten</span>${a.show_count ? ` · ${a.show_count} shows` : ''}</div></div>
      </div>`;
    };

    const renderShowRow = (s, source) => {
      const artist = resolveShowArtist(s) ?? { name: s.artist_name ?? s.artist_slug ?? '', slug: s.artist_slug ?? '', image_url: null };
      const color  = artistColor(artist.name);
      const imgSt  = artist.image_url ? `background-image:url('${esc(artist.image_url)}')` : `background:${color}`;
      const srcTag = source === 'nugs' ? '<span class="badge" style="background:var(--accent)">nugs</span>' : '';
      return `<div class="sr-row" data-type="show" data-slug="${esc(artist.slug)}" data-date="${esc(s.display_date ?? '')}">
        <div class="sr-avatar" style="${imgSt}" data-name="${esc(artist.name)}">${artist.image_url ? '' : `<span>${esc((artist.name[0]??'?').toUpperCase())}</span>`}</div>
        <div class="sr-info">
          <div class="sr-title">${esc(s.display_date ?? '')}</div>
          <div class="sr-sub">${esc(artist.name)} · ${esc(s.venue?.name ?? s.venueName ?? '')}</div>
        </div>
        <div class="sr-badges">
          ${srcTag}
          ${s.has_soundboard_source ? '<span class="badge badge-sbd">SBD</span>' : ''}
          ${s.avg_rating ? `<span class="sr-rating">${stars(s.avg_rating)}</span>` : ''}
        </div>
      </div>`;
    };

    const renderSongRow = s => {
      const name   = s.name ?? s.title ?? '';
      const count  = s.show_count ?? '';
      const artist = state.artist;
      const imgSt  = `background:${artistColor(artist?.name ?? '')}`;
      return `<div class="sr-row" data-type="song" data-song="${esc(name)}">
        <div class="sr-avatar" style="${imgSt}" data-name="${esc(artist?.name ?? '')}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
        </div>
        <div class="sr-info">
          <div class="sr-title">${esc(name)}</div>
          <div class="sr-sub">${esc(artist?.name ?? '')}${count ? ` · played ${count}×` : ''}</div>
        </div>
      </div>`;
    };

    const yearFilterHtml = `
      <div class="sr-year-filter">
        <span class="sr-year-label">Year range:</span>
        <input class="sr-year-input" id="srYearFrom" type="number" placeholder="From" min="1960" max="2030" value="${esc(yearFrom ?? '')}">
        <span style="color:var(--text3)">–</span>
        <input class="sr-year-input" id="srYearTo"   type="number" placeholder="To"   min="1960" max="2030" value="${esc(yearTo ?? '')}">
        <button class="sr-year-apply" id="srYearApply">Apply</button>
        ${(yearFrom || yearTo) ? `<button class="sr-year-clear" id="srYearClear">Clear</button>` : ''}
      </div>`;

    // Nugs artist row renderer — uses id from nugsApi catalog
    const renderNugsArtistRow = a => {
      const color = artistColor(a.name);
      const init  = esc((a.name[0] ?? '?').toUpperCase());
      return `<div class="sr-row" data-type="nugs-artist" data-nugs-id="${esc(a.id)}" data-name="${esc(a.name)}">
        <div class="sr-avatar" style="background:${color}"><span>${init}</span></div>
        <div class="sr-info">
          <div class="sr-title">${esc(a.name)}</div>
          <div class="sr-sub"><span class="badge badge-nugs">Nugs</span>${a.numShows ? ` · ${a.numShows} shows` : ''}</div>
        </div>
      </div>`;
    };

    safeInnerHTML($('contentInner'), `
      <div class="sr-header">
        <div class="sr-query">"${esc(q)}"</div>
        <div class="sr-count">${total} result${total !== 1 ? 's' : ''}</div>
      </div>
      ${yearFilterHtml}
      ${(nugsArtistHits.length || artists.length) ? `<div class="sr-section"><div class="sr-section-title">Artists</div>${nugsArtistHits.map(renderNugsArtistRow).join('')}${artists.slice(0,8).map(renderArtistRow).join('')}</div>` : ''}
      ${(shows.length || nugsResults.length) ? `
        <div class="sr-section">
          <div class="sr-section-title">Shows</div>
          ${shows.slice(0,15).map(s => renderShowRow(s, 'relisten')).join('')}
          ${nugsResults.slice(0,8).map(s => renderShowRow(s, 'nugs')).join('')}
        </div>` : ''}
      ${venues.length ? `
        <div class="sr-section">
          <div class="sr-section-title">Venues</div>
          ${venues.slice(0,8).map(v => `
            <div class="sr-row" data-type="venue-label">
              <div class="sr-venue-dot"></div>
              <div class="sr-info"><div class="sr-title">${esc(v.name)}</div><div class="sr-sub">${esc(v.location ?? '')}</div></div>
            </div>`).join('')}
        </div>` : ''}
      ${songMatches.length ? `
        <div class="sr-section">
          <div class="sr-section-title">Songs — ${esc(state.artist?.name ?? '')}</div>
          ${songMatches.map(renderSongRow).join('')}
        </div>` : ''}`);

    fadeIn();

    $('srYearApply')?.addEventListener('click', () => {
      runSearch(q, $('srYearFrom')?.value || '', $('srYearTo')?.value || '');
    });
    $('srYearClear')?.addEventListener('click', () => runSearch(q));
    ['srYearFrom','srYearTo'].forEach(id => {
      $(id)?.addEventListener('keydown', e => { if (e.key === 'Enter') $('srYearApply')?.click(); });
    });

    $('contentInner').querySelectorAll('.sr-row').forEach(row => {
      row.addEventListener('click', () => {
        if (row.dataset.type === 'nugs-artist') {
          const id   = row.dataset.nugsId ?? '';
          const name = row.dataset.name ?? '';
          if (id) {
            import('./views-nugs.js').then(m =>
              m.nugsViewArtist({ id, name, slug: `nugs-${id}`, _nugs: true }));
          }
        } else if (row.dataset.type === 'artist') {
          const artist = state.artists.find(a => a.slug === row.dataset.slug);
          if (artist) { state.artist = artist; viewYears(artist); }
        } else if (row.dataset.type === 'show') {
          const artist = state.artists.find(a => a.slug === row.dataset.slug)
            ?? { name: row.dataset.slug, slug: row.dataset.slug };
          state.artist = artist;
          viewShow(artist, row.dataset.date);
        } else if (row.dataset.type === 'song' && state.artist?.slug) {
          viewYears(state.artist);
          showToast(`Search shows for "${row.dataset.song}"`);
        }
      });
    });

    // Enrich artist avatars with Last.fm photos
    for (const el of $('contentInner').querySelectorAll('[data-name]')) {
      const name = el.dataset.name;
      if (!name || el.querySelector('img') || el.querySelector('svg')) continue;
      lastfmArtistImage(name).then(url => {
        if (!url || el.querySelector('img')) return;
        const img = new Image(); img.alt = name;
        img.onload = () => { el.innerHTML = ''; el.appendChild(img); el.style.backgroundImage = ''; };
        img.src = url;
      });
    }
  } catch(e) { console.error('[views-core] runSearch', e); showError(e.message); }
}

/* ── Filter bar ──────────────────────────────────── */
export function buildFilterBar(shows, renderFn) {
  let filters = { sbd: false, r40: false, r45: false };
  let sort = 'date-desc';

  function apply() {
    let list = [...shows];
    if (filters.sbd) list = list.filter(s => s.has_soundboard_source);
    if (filters.r45) list = list.filter(s => (s.avg_rating ?? 0) >= 4.5);
    else if (filters.r40) list = list.filter(s => (s.avg_rating ?? 0) >= 4.0);
    if (sort === 'date-asc')   list.sort((a,b) => (a.display_date??'') < (b.display_date??'') ? -1 : 1);
    else if (sort === 'date-desc') list.sort((a,b) => (a.display_date??'') > (b.display_date??'') ? -1 : 1);
    else if (sort === 'rating') list.sort((a,b) => (b.avg_rating??0) - (a.avg_rating??0));
    renderFn(list);
  }

  const bar = document.createElement('div');
  bar.className = 'filter-bar';
  bar.innerHTML = `
    <button class="filter-btn" data-f="sbd">SBD Only</button>
    <button class="filter-btn" data-f="r40">★ 4.0+</button>
    <button class="filter-btn" data-f="r45">★ 4.5+</button>
    <div class="filter-sep"></div>
    <button class="filter-btn sort-btn active" data-s="date-desc">Date ↓</button>
    <button class="filter-btn sort-btn" data-s="date-asc">Date ↑</button>
    <button class="filter-btn sort-btn" data-s="rating">Rating ↓</button>`;
  bar.querySelectorAll('[data-f]').forEach(btn => btn.addEventListener('click', () => {
    const f = btn.dataset.f;
    if (f === 'r40') { filters.r40 = !filters.r40; if (filters.r40) filters.r45 = false; }
    if (f === 'r45') { filters.r45 = !filters.r45; if (filters.r45) filters.r40 = false; }
    if (f === 'sbd') filters.sbd = !filters.sbd;
    bar.querySelector('[data-f="sbd"]').classList.toggle('active', filters.sbd);
    bar.querySelector('[data-f="r40"]').classList.toggle('active', filters.r40);
    bar.querySelector('[data-f="r45"]').classList.toggle('active', filters.r45);
    apply();
  }));
  bar.querySelectorAll('.sort-btn').forEach(btn => btn.addEventListener('click', () => {
    sort = btn.dataset.s;
    bar.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    apply();
  }));
  return bar;
}

/* ── Years ───────────────────────────────────────── */
export async function viewYears(artist) {
  nav.record(viewYears, [artist]);
  state.artist = artist; state.year = null; state.show = null;
  showLoading();
  setBreadcrumb([{ label: artist.name }]);
  try {
    const years       = await api.years(artist.slug);
    const sorted      = [...years].sort((a, b) => b.year - a.year);
    const totalShows  = sorted.reduce((n, y) => n + (y.show_count ?? 0), 0);
    const heroColor   = artistColor(artist.name);
    const artSrc      = artist.image_url ?? artist._wikiImg ?? null;
    const artHtml     = artSrc
      ? `<img src="${esc(artSrc)}" alt="">`
      : `<span class="art-hero-init">${esc(artist.name[0]?.toUpperCase() ?? '?')}</span>`;
    const artBg = artSrc ? '' : `background:${heroColor}`;

    safeInnerHTML($('contentInner'), `
      <div class="artist-hero" style="--hero-bg:${heroColor}">
        <div class="artist-hero-art" style="${artBg}">${artHtml}</div>
        <div class="artist-hero-info">
          <div class="artist-hero-label">Artist</div>
          <div class="artist-hero-name">${esc(artist.name)}</div>
          <div class="artist-hero-meta">${sorted.length} years · ${totalShows.toLocaleString()} shows</div>
          <div class="artist-hero-actions">
            <button class="action-btn primary" id="btnRandom">🎲 Random Show</button>
            <button class="action-btn" id="btnTop">⭐ Top Shows</button>
            <button class="action-btn" id="btnTours">🗺 Tours</button>
            <button class="action-btn" id="btnSongs">🎵 Songs</button>
            <button class="action-btn" id="btnVenues">📍 Venues</button>
            <button class="action-btn" id="btnEras">📅 Eras</button>
          </div>
        </div>
      </div>
      <div id="artistBioCard" class="artist-bio loading"></div>
      <div class="artist-years-wrap">
        <div class="artist-years-label">Browse by year</div>
        <div class="year-grid">
          ${sorted.map(y => `
            <div class="year-card" data-year="${esc(y.year)}">
              <div class="year-num">${esc(y.year)}</div>
              <div class="year-count">${y.show_count ?? 0} shows</div>
            </div>`).join('')}
        </div>
      </div>`);
    fadeIn();
    injectArtistBio(artist.name);
    if (!artSrc) {
      lastfmArtistImage(artist.name).then(imgUrl => {
        if (!imgUrl) return;
        artist._wikiImg = imgUrl;
        const heroArt = $('contentInner')?.querySelector('.artist-hero-art');
        if (heroArt) { heroArt.innerHTML = `<img src="${esc(imgUrl)}" alt="">`; heroArt.style.background = ''; }
      });
    }
    $('contentInner').querySelectorAll('.year-card').forEach(c =>
      c.addEventListener('click', () => viewShows(artist, c.dataset.year)));
    $('btnTours').addEventListener('click',  () => viewTours(artist));
    $('btnSongs').addEventListener('click',  () => viewSongs(artist));
    $('btnVenues').addEventListener('click', () => viewVenues(artist));
    $('btnEras').addEventListener('click',   () => viewDecades(artist, years));
    $('btnRandom').addEventListener('click', async () => {
      try { showLoading(); viewShow(artist, (await api.random(artist.slug)).display_date); }
      catch(e) { showError(e.message); }
    });
    $('btnTop').addEventListener('click', async () => {
      try { showLoading(); viewShowList(artist, await api.top(artist.slug), 'Top Shows'); }
      catch(e) { showError(e.message); }
    });
  } catch(e) { console.error('[views-core] viewYears', e); showError(e.message); }
}

/* ── Decade / Era Explorer ───────────────────────── */
export function viewDecades(artist, years) {
  artist._years = years;
  nav.record(viewDecades, [artist, years]);
  setBreadcrumb([{ label: artist.name, fn: () => viewYears(artist) }, { label: 'Eras' }]);

  const decades = {};
  years.forEach(y => {
    const d = Math.floor(y.year / 10) * 10;
    if (!decades[d]) decades[d] = { decade: d, years: [], showCount: 0 };
    decades[d].years.push(y);
    decades[d].showCount += y.show_count ?? 0;
  });
  const sortedDecades = Object.values(decades).sort((a, b) => a.decade - b.decade);

  safeInnerHTML($('contentInner'), `
    <div class="section-header">
      <div>
        <div class="section-title">${esc(artist.name)} — Eras</div>
        <div class="section-subtitle">${sortedDecades.length} decade${sortedDecades.length !== 1 ? 's' : ''} · ${years.length} years</div>
      </div>
    </div>
    <div class="decade-grid">
      ${sortedDecades.map(d => `
        <div class="decade-card" data-decade="${d.decade}">
          <div class="decade-name">${d.decade}s</div>
          <div class="decade-meta">${d.years.length} year${d.years.length !== 1 ? 's' : ''} · ${d.showCount} shows</div>
        </div>`).join('')}
    </div>`);

  $('contentInner').querySelectorAll('.decade-card').forEach(card => {
    const dec = sortedDecades.find(d => d.decade === parseInt(card.dataset.decade));
    if (dec) card.addEventListener('click', () => viewDecadeDetail(artist, dec));
  });
}

export function viewDecadeDetail(artist, dec) {
  nav.record(viewDecadeDetail, [artist, dec]);
  setBreadcrumb([
    { label: artist.name, fn: () => viewYears(artist) },
    { label: 'Eras', fn: () => viewDecades(artist, artist._years ?? dec.years) },
    { label: `${dec.decade}s` },
  ]);
  const sorted = [...dec.years].sort((a, b) => a.year - b.year);
  safeInnerHTML($('contentInner'), `
    <div class="section-header">
      <div>
        <div class="section-title">${esc(artist.name)} — ${dec.decade}s</div>
        <div class="section-subtitle">${sorted.length} year${sorted.length !== 1 ? 's' : ''} · ${dec.showCount} shows</div>
      </div>
    </div>
    <div class="decade-timeline-wrap">
      <div class="decade-timeline">
        ${sorted.map(y => `
          <div class="decade-year-card" data-year="${esc(y.year)}">
            <div class="decade-year-num">${esc(y.year)}</div>
            <div class="decade-year-count">${y.show_count ?? 0} shows</div>
          </div>`).join('')}
      </div>
    </div>`);
  $('contentInner').querySelectorAll('.decade-year-card').forEach(card =>
    card.addEventListener('click', () => viewShows(artist, card.dataset.year)));
}

/* ── Tours ───────────────────────────────────────── */
export async function viewTours(artist) {
  nav.record(viewTours, [artist]);
  showLoading();
  setBreadcrumb([
    { label: artist.name, onClick: () => viewYears(artist) },
    { label: 'Tours' },
  ]);
  try {
    const allShows = await getAllShows(artist);
    const tourMap  = {};
    for (const show of allShows) {
      if (!show.tour?.slug) continue;
      const slug = show.tour.slug;
      if (!tourMap[slug]) tourMap[slug] = { ...show.tour, shows: [] };
      tourMap[slug].shows.push(show);
    }
    const tours = Object.values(tourMap)
      .filter(t => t.shows.length)
      .sort((a, b) => (a.shows[0]?.display_date ?? '') < (b.shows[0]?.display_date ?? '') ? -1 : 1);

    if (!tours.length) {
      safeInnerHTML($('contentInner'), `
        <div class="section-header">
          <div><div class="section-title">Tours — ${esc(artist.name)}</div></div>
        </div>
        <div class="error-state" style="margin-top:20px"><p>No tour data available for this artist.</p></div>`);
      return;
    }

    safeInnerHTML($('contentInner'), `
      <div class="section-header">
        <div>
          <div class="section-title">Tours — ${esc(artist.name)}</div>
          <div class="section-subtitle">${tours.length} tour${tours.length !== 1 ? 's' : ''}</div>
        </div>
      </div>
      <div class="tour-list">
        ${tours.map(tour => {
          const dates     = tour.shows.map(s => s.display_date).sort();
          const start     = dates[0]?.slice(0,4) ?? '';
          const end       = dates[dates.length-1]?.slice(0,4) ?? '';
          const dateRange = start === end ? start : `${start}–${end}`;
          return `<div class="tour-row" data-tslug="${esc(tour.slug)}">
            <div class="tour-name">${esc(tour.name || tour.slug)}</div>
            <div class="tour-dates">${esc(dateRange)}</div>
            <div class="tour-count">${tour.shows.length} show${tour.shows.length !== 1 ? 's' : ''}</div>
          </div>`;
        }).join('')}
      </div>`);
    $('contentInner').querySelectorAll('.tour-row').forEach(row => {
      row.addEventListener('click', () => {
        const tour = tours.find(t => t.slug === row.dataset.tslug);
        if (tour) viewTourShows(artist, tour);
      });
    });
  } catch(e) { console.error('[views-core] viewTours', e); showError(e.message); }
}

export function viewTourShows(artist, tour) {
  nav.record(viewTourShows, [artist, tour]);
  setBreadcrumb([
    { label: artist.name, onClick: () => viewYears(artist) },
    { label: 'Tours',     onClick: () => viewTours(artist) },
    { label: tour.name || tour.slug },
  ]);
  renderShowList(tour.shows ?? [], artist, tour.name || tour.slug);
}

/* ── All-shows cache + Venues + Songs ───────────── */
const allShowsCache  = {};
const songShowsCache = {};
// Per-session set of song titles the user has heard live (in attended shows)
// for a given artist. Keyed by artist.slug; values are Set<lowercased name>.
// Populated lazily by viewSongs to drive the 🎧 indicator on song rows.
const attendedSongsBySession = new Map();
let   scanCancelled  = false;

export async function getAllShows(artist) {
  if (allShowsCache[artist.slug]) return allShowsCache[artist.slug];
  const years   = await api.years(artist.slug);
  const results = await Promise.all(
    years.map(y => api.shows(artist.slug, y.year).then(d => d.shows ?? d).catch(() => []))
  );
  allShowsCache[artist.slug] = results.flat();
  return allShowsCache[artist.slug];
}

export async function viewVenues(artist) {
  nav.record(viewVenues, [artist]);
  showLoading();
  setBreadcrumb([
    { label: artist.name, onClick: () => viewYears(artist) },
    { label: 'Venues' },
  ]);
  try {
    const allShows = await getAllShows(artist);
    const venueMap = new Map();
    for (const show of allShows) {
      if (!show.venue?.name) continue;
      const key = show.venue.name;
      if (!venueMap.has(key)) venueMap.set(key, { name: show.venue.name, location: show.venue.location ?? '', count: 0 });
      venueMap.get(key).count++;
    }
    const venues = [...venueMap.values()].sort((a, b) => b.count - a.count);

    safeInnerHTML($('contentInner'), `
      <div class="section-header">
        <div>
          <div class="section-title">Venues — ${esc(artist.name)}</div>
          <div class="section-subtitle">${venues.length} venue${venues.length !== 1 ? 's' : ''}</div>
        </div>
      </div>
      <input class="song-filter" id="venueFilter" type="text" placeholder="Filter venues…" autocomplete="off" spellcheck="false">
      <div class="venue-list" id="venueListEl"></div>`);

    function renderVenueRows(list) {
      safeInnerHTML($('venueListEl'), list.map(v => `
        <div class="venue-row" data-name="${esc(v.name)}">
          <div class="venue-info">
            <div class="venue-name">${esc(v.name)}</div>
            ${v.location ? `<div class="venue-loc">${esc(v.location)}</div>` : ''}
          </div>
          <div class="venue-count">${v.count} show${v.count !== 1 ? 's' : ''}</div>
        </div>`).join(''));
      $('venueListEl').querySelectorAll('.venue-row').forEach(row =>
        row.addEventListener('click', () => {
          const vname = row.dataset.name;
          const venueShows = allShows.filter(s => s.venue?.name === vname);
          viewShowList(artist, venueShows, `📍 ${vname}`);
        }));
    }

    renderVenueRows(venues);
    $('venueFilter').addEventListener('input', e => {
      const q = e.target.value.toLowerCase().trim();
      renderVenueRows(q ? venues.filter(v =>
        v.name.toLowerCase().includes(q) || v.location.toLowerCase().includes(q)
      ) : venues);
    });
    fadeIn();
  } catch(e) { console.error('[views-core] viewVenues', e); showError(e.message); }
}

export async function viewSongs(artist) {
  nav.record(viewSongs, [artist]);
  showLoading();
  setBreadcrumb([
    { label: artist.name, onClick: () => viewYears(artist) },
    { label: 'Songs' },
  ]);
  try {
    // Relisten's canonical Song table sometimes ingests "Bertha", "Bertha >",
    // and "Bertha ->" as three separate rows (taper data inconsistency).
    // dedupeRelistenSongs collapses them by normalised title, sums plays,
    // and picks the cleanest display name. See test/helpers.test.js.
    const rawSongs  = await api.songs(artist.slug);
    const songs     = dedupeRelistenSongs(rawSongs);

    // Fallback: Relisten's canonical /songs endpoint is empty for some
    // artists (Dead & Company is the canonical example — show data exists
    // but no Song table populated). When that happens, we build the song
    // catalog ourselves by scanning every show's setlist. Cached per-artist
    // for the session so this only runs once per artist visit.
    let activeSongs = songs;
    if (!activeSongs.length) {
      const cached = _relistenSongsScanCache.get(artist.slug);
      if (cached) {
        activeSongs = cached;
      } else {
        // Render a progress bar while scanning. The same getAllShows() +
        // per-show fetch infrastructure that powers viewSongShows.
        safeInnerHTML($('contentInner'), `
          <div class="section-header" style="align-items:center">
            <div>
              <div class="section-title">Songs — ${esc(artist.name)}</div>
              <div class="section-subtitle" id="scanStatus">Building song catalog from setlists…</div>
            </div>
          </div>
          <div class="scan-bar"><div class="scan-bar-fill" id="scanFill"></div></div>
          <div style="padding:16px;color:var(--text3);font-size:12px;text-align:center" id="scanHint">
            Relisten doesn't have a canonical song list for this artist —
            we're building one from per-show setlists. This runs once per
            session and caches.
          </div>`);

        const allShows = await getAllShows(artist);
        const total    = allShows.length;
        let scanned    = 0;
        const fullShows = [];
        const batchSize = 20;
        for (let i = 0; i < allShows.length; i += batchSize) {
          await Promise.all(allShows.slice(i, i + batchSize).map(async show => {
            try {
              const full = await api.show(artist.slug, show.display_date);
              fullShows.push(full);
            } catch { /* skip shows we can't fetch */ }
            scanned++;
          }));
          if ($('scanStatus')) $('scanStatus').textContent =
            `Scanning ${scanned} / ${total} setlists`;
          if ($('scanFill'))   $('scanFill').style.width =
            `${Math.round((scanned / total) * 100)}%`;
        }

        activeSongs = aggregateRelistenShowsToSongs(fullShows);
        _relistenSongsScanCache.set(artist.slug, activeSongs);
      }

      if (!activeSongs.length) {
        // Truly nothing — even the setlists were empty. Fall back to the
        // friendly empty state so the user isn't staring at a blank page.
        safeInnerHTML($('contentInner'), `
          <div class="section-header">
            <div><div class="section-title">Songs — ${esc(artist.name)}</div></div>
          </div>
          <div class="empty-state" style="padding:32px;text-align:center;color:var(--text2)">
            <div style="font-size:32px;margin-bottom:12px">🎵</div>
            <div style="font-size:14px;font-weight:700;margin-bottom:6px">No setlist data available</div>
            <div style="font-size:12px;color:var(--text3);max-width:420px;margin:0 auto;line-height:1.5">
              Couldn't find any track data for ${esc(artist.name)} on Relisten.
              Try the Years grid to browse shows directly.
            </div>
          </div>`);
        return;
      }
    }

    const byPopular = [...activeSongs].sort((a, b) => (b.shows_played_at ?? 0) - (a.shows_played_at ?? 0));
    const byRare    = [...activeSongs].sort((a, b) => (a.shows_played_at ?? 0) - (b.shows_played_at ?? 0));
    let   activeSort = 'popular';

    function rarityLabel(n) {
      if (n === 1)  return `<span class="rarity-badge rarity-once">Once</span>`;
      if (n <= 5)   return `<span class="rarity-badge rarity-rare">Rare</span>`;
      if (n <= 15)  return `<span class="rarity-badge rarity-uncommon">Uncommon</span>`;
      return '';
    }

    safeInnerHTML($('contentInner'), `
      <div class="section-header">
        <div>
          <div class="section-title">Songs — ${esc(artist.name)}</div>
          <div class="section-subtitle">${activeSongs.length} unique songs${songs.length === 0 ? ' · built from setlists' : ''}</div>
        </div>
        <div class="song-sort-tabs">
          <button class="song-sort-tab active" data-sort="popular">Most Played</button>
          <button class="song-sort-tab" data-sort="rare">🦄 Rarities</button>
        </div>
      </div>
      <input class="song-filter" id="songFilter" type="text" placeholder="Filter songs…" autocomplete="off" spellcheck="false">
      <div class="song-list" id="songListEl"></div>`);

    // Build a Set<lowercased song title> the user has heard at attended shows.
    // Lazy: triggered on first Songs-tab visit per session per artist. Walks
    // each attended show's full setlist (cached by getAllShows + api.show).
    // The result is cached in attendedSongsBySession so subsequent renders
    // are instant. While the set is loading we render without indicators
    // and refresh once it resolves.
    let attendedSongs = attendedSongsBySession.get(artist.slug) ?? null;
    const attendedShowDates = store.getAttended()
      .filter(a => a.artistSlug === artist.slug)
      .map(a => a.date);

    function renderSongRows(list) {
      safeInnerHTML($('songListEl'), list.map(s => {
        // Use the normalised key so the heard-live set (which stores
        // segment-split normalised keys) lines up with whatever cleaned
        // display name the dedup picked.
        const heard = attendedSongs?.has(normaliseSongTitle(s.name)) ?? false;
        return `
        <div class="song-row" data-name="${esc(s.name)}" data-plays="${s.shows_played_at ?? 0}">
          <div class="song-name">${heard ? '<span class="song-heard" title="Heard live">🎧</span> ' : ''}${esc(s.name)}${activeSort === 'rare' ? rarityLabel(s.shows_played_at ?? 0) : ''}</div>
          <div class="song-count">${s.shows_played_at ?? '?'} shows</div>
        </div>`;
      }).join(''));
      $('songListEl').querySelectorAll('.song-row').forEach(row =>
        row.addEventListener('click', () => viewSongShows(artist, row.dataset.name, +row.dataset.plays || null)));
    }

    // If we haven't computed the attended-songs set for this artist yet,
    // do it in the background. Each attended show is one cached api.show()
    // call; we build a Set of normalised song keys seen across them.
    // Composite tracks like "Bertha > Eyes of the World" split on
    // transition markers so both songs register as heard.
    if (!attendedSongs && attendedShowDates.length) {
      (async () => {
        try {
          const acc = new Set();
          for (const date of attendedShowDates) {
            try {
              const full   = await api.show(artist.slug, date);
              // Walk every listed track regardless of mp3_url — the user
              // was physically present, recording availability is irrelevant.
              const tracks = (full.sources ?? []).flatMap(src =>
                (src.sets ?? []).flatMap(s => s.tracks ?? []));
              for (const t of tracks) {
                if (!t.title) continue;
                for (const seg of String(t.title).split(/\s*(?:->|>|~)\s*/)) {
                  const k = normaliseSongTitle(seg);
                  if (k) acc.add(k);
                }
              }
            } catch { /* skip shows we can't fetch */ }
          }
          attendedSongsBySession.set(artist.slug, acc);
          attendedSongs = acc;
          // Re-render with indicators now that we have the set.
          renderSongRows(currentList($('songFilter')?.value.toLowerCase().trim() ?? ''));
        } catch { /* leave indicators unset */ }
      })();
    }

    function currentList(q) {
      const base = activeSort === 'rare' ? byRare : byPopular;
      return q ? base.filter(s => s.name.toLowerCase().includes(q)) : base;
    }

    renderSongRows(currentList(''));

    $('songFilter').addEventListener('input', e => {
      renderSongRows(currentList(e.target.value.toLowerCase().trim()));
    });

    $('contentInner').querySelectorAll('.song-sort-tab').forEach(tab =>
      tab.addEventListener('click', () => {
        activeSort = tab.dataset.sort;
        $('contentInner').querySelectorAll('.song-sort-tab').forEach(t => t.classList.toggle('active', t === tab));
        renderSongRows(currentList($('songFilter').value.toLowerCase().trim()));
      }));
  } catch(e) { console.error('[views-core] viewSongs', e); showError(e.message); }
}

export async function viewSongShows(artist, songName, totalPlays = null) {
  nav.record(viewSongShows, [artist, songName, totalPlays]);
  const cacheKey = `${artist.slug}::${songName.toLowerCase()}`;
  setBreadcrumb([
    { label: artist.name, onClick: () => viewYears(artist) },
    { label: 'Songs',     onClick: () => viewSongs(artist) },
    { label: songName },
  ]);

  if (songShowsCache[cacheKey]) {
    renderShowList(songShowsCache[cacheKey], artist, `"${songName}"`);
    return;
  }

  scanCancelled = false;

  safeInnerHTML($('contentInner'), `
    <div class="section-header" style="align-items:center">
      <div>
        <div class="section-title">"${esc(songName)}"</div>
        <div class="section-subtitle" id="scanStatus">Fetching show list…</div>
      </div>
      <button class="action-btn" id="btnCancelScan">Cancel</button>
    </div>
    <div class="scan-bar"><div class="scan-bar-fill" id="scanFill"></div></div>
    <div class="show-list" id="songShowsEl"></div>`);

  $('btnCancelScan').addEventListener('click', () => {
    scanCancelled = true;
    if ($('scanStatus'))    $('scanStatus').textContent = 'Cancelled.';
    if ($('btnCancelScan')) $('btnCancelScan').remove();
    if ($('scanFill'))      $('scanFill').style.width = '100%';
  });

  try {
    const allShows = await getAllShows(artist);
    if (scanCancelled) return;

    const total = allShows.length;
    let scanned = 0;
    const found = [];
    // Use the normalised key as the match target. trackContainsSong splits
    // tracks on transition markers (>, ->, ~) and exact-matches each
    // segment after normalisation — so "Bertha", "Bertha >", and
    // "Bertha > Eyes of the World" all count as Bertha plays without
    // false-matching unrelated substrings like "Bertha Tease".
    const targetKey = normaliseSongTitle(songName);

    // Sorted chronological view of allShows + attended set are needed for
    // the stats card (longest run, longest gap, "first time since").
    const allShowsByDate = [...allShows].sort((a, b) =>
      (a.display_date ?? '') < (b.display_date ?? '') ? -1 : 1);
    const attendedSet = new Set(
      store.getAttended()
        .filter(a => a.artistSlug === artist.slug)
        .map(a => a.date)
    );

    const updateStatus = () => {
      if ($('scanStatus')) $('scanStatus').textContent =
        `Scanning ${scanned} / ${total} shows · ${found.length} found`;
      if ($('scanFill')) $('scanFill').style.width = `${Math.round((scanned / total) * 100)}%`;
    };

    const batchSize = 20;
    for (let i = 0; i < allShows.length; i += batchSize) {
      if (scanCancelled) break;
      await Promise.all(allShows.slice(i, i + batchSize).map(async show => {
        if (scanCancelled) return;
        try {
          const full   = await api.show(artist.slug, show.display_date);
          // Walk EVERY listed track across all sources, regardless of whether
          // it has a streamable mp3_url. Tapers sometimes upload setlists
          // without the audio (or with broken links); we still want those
          // shows to register as "Bertha was played here". flatTracks()
          // intentionally filters by mp3_url for playback contexts; here we
          // need the unfiltered tracklist.
          const tracks = (full.sources ?? []).flatMap(src =>
            (src.sets ?? []).flatMap(s => s.tracks ?? [])
          );
          const match  = tracks.some(t => trackContainsSong(t.title, targetKey));
          if (match) {
            found.push(show);
            const el = document.createElement('div');
            el.className = 'show-row';
            el.dataset.date = show.display_date;
            // safeInnerHTML used here as defence-in-depth; esc() is primary protection
            safeInnerHTML(el, `
              <div class="show-date">${esc(show.display_date)}</div>
              <div class="show-venue">
                ${show.venue?.name
                  ? `<span class="venue-link" data-venue="${esc(show.venue.name)}">${esc(show.venue.name)}</span>${show.venue?.location ? ' — ' + esc(show.venue.location) : ''}`
                  : ''}
              </div>
              <div class="show-badges">
                ${show.has_soundboard_source ? '<span class="badge badge-sbd">SBD</span>' : ''}
                ${show.avg_rating ? `<span class="star">${stars(show.avg_rating)}</span>` : ''}
              </div>`);
            el.addEventListener('click', () => viewShow(artist, show.display_date));
            el.querySelectorAll('.venue-link').forEach(link =>
              link.addEventListener('click', async e => {
                e.stopPropagation();
                const vname      = link.dataset.venue;
                const venueShows = (allShowsCache[artist.slug] ?? []).filter(s => s.venue?.name === vname);
                if (venueShows.length) viewShowList(artist, venueShows, `📍 ${vname}`);
              }));
            $('songShowsEl')?.appendChild(el);
          }
        } catch (err) { console.error('[views-core] song scan track', err); }
        scanned++;
      }));
      updateStatus();
    }

    if ($('scanFill'))      $('scanFill').style.width = '100%';
    if ($('btnCancelScan')) $('btnCancelScan').remove();
    if ($('scanStatus')) {
      $('scanStatus').textContent = scanCancelled
        ? `Cancelled · ${found.length} shows found`
        : `${found.length} show${found.length !== 1 ? 's' : ''} · Complete`;
    }
    if (!found.length && !scanCancelled && $('songShowsEl')) {
      $('songShowsEl').innerHTML = `<div class="error-state"><p>No shows found for "${esc(songName)}"</p></div>`;
    }
    if (!scanCancelled) songShowsCache[cacheKey] = found;

    // Render the stats card once we have data — debut, last played, longest
    // gap, longest run of consecutive shows containing the song, top venues,
    // and the user's attendance count for shows containing this song.
    if (found.length && !scanCancelled) {
      renderSongStatsCard(artist, songName, found, allShowsByDate, attendedSet, totalPlays);
    }

  } catch(e) { console.error('[views-core] viewSongShows', e); showError(e.message); }
}

/* ── Song stats card renderer ──────────────────────────────────────────────
 * Computes derived stats from the scan output and renders a card above the
 * show list.
 *  - found:           shows we found a recording for that contains the song
 *  - allShowsByDate:  every show by this artist in chronological order
 *  - attendedSet:     Set of show dates the user has marked attended
 *  - totalPlays:      Relisten's authoritative play count from /songs (may
 *                     exceed `found.length` because Relisten tracks setlist
 *                     data for shows whose recordings we don't have access
 *                     to; null when caller didn't pass it through).
 * ──────────────────────────────────────────────────────────────────────── */
function renderSongStatsCard(artist, songName, found, allShowsByDate, attendedSet, totalPlays) {
  const cardHost = document.getElementById('songShowsEl');
  if (!cardHost) return;

  // Sort found chronologically once.
  const foundByDate = [...found].sort((a, b) =>
    (a.display_date ?? '') < (b.display_date ?? '') ? -1 : 1);
  const debut = foundByDate[0]?.display_date ?? '';
  const last  = foundByDate[foundByDate.length - 1]?.display_date ?? '';

  // Longest gap (days between consecutive plays).
  let longestGap = 0;
  let longestGapRange = '';
  for (let i = 1; i < foundByDate.length; i++) {
    const a = new Date(foundByDate[i - 1].display_date);
    const b = new Date(foundByDate[i].display_date);
    const days = Math.round((b - a) / 86400000);
    if (days > longestGap) {
      longestGap      = days;
      longestGapRange = `${foundByDate[i - 1].display_date} → ${foundByDate[i].display_date}`;
    }
  }
  const gapYears = longestGap > 365 ? `${(longestGap / 365).toFixed(1)} years` : `${longestGap} days`;

  // Longest run of CONSECUTIVE shows in the artist's timeline that contained
  // the song. Walks the chronological show list once.
  const foundDateSet = new Set(foundByDate.map(s => s.display_date));
  let longestRun = 0, currentRun = 0, runEndDate = '';
  for (const s of allShowsByDate) {
    if (foundDateSet.has(s.display_date)) {
      currentRun++;
      if (currentRun > longestRun) {
        longestRun  = currentRun;
        runEndDate  = s.display_date;
      }
    } else {
      currentRun = 0;
    }
  }

  // Top venues by count.
  const venueCounts = new Map();
  for (const s of foundByDate) {
    const v = s.venue?.name ?? '';
    if (!v) continue;
    venueCounts.set(v, (venueCounts.get(v) ?? 0) + 1);
  }
  const topVenues = [...venueCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, n]) => `${esc(name)} (${n})`)
    .join(' · ');

  // Best shows by avg_rating, top 5.
  const bestShows = [...foundByDate]
    .filter(s => s.avg_rating)
    .sort((a, b) => (b.avg_rating ?? 0) - (a.avg_rating ?? 0))
    .slice(0, 5);

  const attendedCount = foundByDate.filter(s => attendedSet.has(s.display_date)).length;

  // Show Relisten's authoritative play count when we have it AND it differs
  // meaningfully from what we found (some shows lack uploaded recordings —
  // we can count the setlist match but they're not in the scan list).
  const showTotal       = totalPlays != null && totalPlays > 0;
  const totalIsLarger   = showTotal && totalPlays > found.length;
  const primaryPlayNum  = showTotal ? totalPlays : found.length;
  const primaryPlayLbl  = showTotal ? 'Total plays' : 'Recorded shows';

  const stats = document.createElement('div');
  stats.className = 'song-stats-card';
  stats.innerHTML = `
    <div class="song-stats-grid">
      <div class="song-stat">
        <div class="song-stat-num" id="songStatPrimary">${primaryPlayNum}</div>
        <div class="song-stat-label" id="songStatPrimaryLabel">${esc(primaryPlayLbl)}</div>
        <div class="song-stat-sub"  id="songStatSecondary">${totalIsLarger ? `${found.length} recorded` : ''}</div>
      </div>
      <div class="song-stat"><div class="song-stat-num">${esc(debut)}</div><div class="song-stat-label">Debut</div></div>
      <div class="song-stat"><div class="song-stat-num">${esc(last)}</div><div class="song-stat-label">Last played</div></div>
      ${attendedCount > 0
        ? `<div class="song-stat song-stat-attended"><div class="song-stat-num">🎧 ${attendedCount}</div><div class="song-stat-label">You were there</div></div>`
        : ''}
    </div>
    <div class="song-stats-setlistfm" id="songStatSetlistFm" style="display:none"></div>
    ${longestGap > 30 || longestRun > 1 ? `
      <div class="song-stats-extras">
        ${longestGap > 30 ? `<div><strong>Longest gap:</strong> ${gapYears} <span class="song-stats-sub">(${esc(longestGapRange)})</span></div>` : ''}
        ${longestRun > 1   ? `<div><strong>Longest run:</strong> ${longestRun} shows in a row <span class="song-stats-sub">(through ${esc(runEndDate)})</span></div>` : ''}
        ${topVenues       ? `<div><strong>Top venues:</strong> ${topVenues}</div>` : ''}
      </div>` : ''}
    ${bestShows.length ? `
      <div class="song-stats-best">
        <div class="song-stats-best-label">Best shows by rating</div>
        <div class="song-stats-best-rows">
          ${bestShows.map(s => `
            <div class="song-stats-best-row" data-date="${esc(s.display_date)}">
              <div class="song-stats-best-date">${esc(s.display_date)}${attendedSet.has(s.display_date) ? ' 🎧' : ''}</div>
              <div class="song-stats-best-venue">${esc(s.venue?.name ?? '')}</div>
              <div class="song-stats-best-rating">${stars(s.avg_rating)}</div>
            </div>`).join('')}
        </div>
      </div>` : ''}`;
  // Insert above the show list.
  cardHost.parentNode.insertBefore(stats, cardHost);

  stats.querySelectorAll('.song-stats-best-row').forEach(row =>
    row.addEventListener('click', () => viewShow(artist, row.dataset.date)));

  // ── setlist.fm enrichment ───────────────────────────────────────────────
  // Asynchronously fetch the authoritative play count from setlist.fm. When
  // it resolves, update the primary tile to use that number and surface the
  // gap with whichever counts we already have. Stays dormant when:
  //   - setlist.fm key not configured
  //   - artist not on setlist.fm
  //   - the API errors (logged but silent in UI)
  enrichWithSetlistFm(artist, songName, found.length);
}

async function enrichWithSetlistFm(artist, songName, recordedCount) {
  if (!setlistFmAvailable()) return;
  const sfmEl       = document.getElementById('songStatSetlistFm');
  const primaryEl   = document.getElementById('songStatPrimary');
  const primaryLbl  = document.getElementById('songStatPrimaryLabel');
  const secondaryEl = document.getElementById('songStatSecondary');
  if (!sfmEl) return;

  // First, see if we have a cached count without needing the network.
  // We check by calling getSongPlayCount with progress that does nothing —
  // if cached, returns instantly; otherwise triggers a fetch.
  sfmEl.style.display = '';
  sfmEl.innerHTML = `<span class="song-stats-sfm-loading">Fetching setlist.fm data…</span>`;

  try {
    let lastUpdate = 0;
    const count = await getSongPlayCount(artist, songName, {
      onProgress: (scanned, total) => {
        // Throttle the UI update to once per 200ms — paginated fetches
        // can fire many progress callbacks for big artists.
        const now = Date.now();
        if (now - lastUpdate < 200) return;
        lastUpdate = now;
        if (sfmEl) {
          sfmEl.innerHTML = `<span class="song-stats-sfm-loading">Fetching setlist.fm data… ${scanned}/${total}</span>`;
        }
      },
    });

    if (count == null) {
      sfmEl.style.display = 'none';
      return;
    }

    // Got an authoritative number. Promote it to the primary tile and surface
    // the recorded-vs-total gap (if any) as the small subtext.
    if (primaryEl)   primaryEl.textContent = count;
    if (primaryLbl)  primaryLbl.textContent = 'Total plays';
    if (secondaryEl) {
      secondaryEl.textContent = recordedCount < count
        ? `${recordedCount} with Relisten recordings`
        : '';
    }
    sfmEl.innerHTML = `<span class="song-stats-sfm">📋 Per setlist.fm</span>`;
  } catch (err) {
    console.warn('[setlistfm] enrichment failed:', err.message);
    sfmEl.style.display = 'none';
  }
}

/* ── Shows list views ────────────────────────────── */
export async function viewShows(artist, year) {
  nav.record(viewShows, [artist, year]);
  state.year = year; state.show = null;
  showLoading();
  setBreadcrumb([
    { label: artist.name, onClick: () => viewYears(artist) },
    { label: year },
  ]);
  try {
    const data  = await api.shows(artist.slug, year);
    const shows = data.shows ?? data;
    renderShowList(shows, artist, year);
  } catch(e) { console.error('[views-core] viewShows', e); showError(e.message); }
}

export function viewShowList(artist, shows, title) {
  nav.record(viewShowList, [artist, shows, title]);
  setBreadcrumb([
    { label: artist.name, onClick: () => viewYears(artist) },
    { label: title },
  ]);
  renderShowList(shows, artist, title);
}

export function renderShowList(shows, artist, context) {
  safeInnerHTML($('contentInner'), `
    <div class="section-header">
      <div>
        <div class="section-title">${esc(String(context ?? ''))}</div>
        <div class="section-subtitle" id="showCount">${shows.length} show${shows.length!==1?'s':''}</div>
      </div>
    </div>
    <div id="filterBarSlot"></div>
    <div class="show-cards" id="showListEl"></div>`);
  fadeIn();

  const effectiveArtist = artist ?? state.artist;

  function renderRows(list) {
    safeInnerHTML($('showListEl'), list.map(s => {
      const fav      = effectiveArtist ? store.isFav(effectiveArtist.slug, s.display_date) : false;
      const myRating = effectiveArtist ? store.getRating(effectiveArtist.slug, s.display_date) : null;
      const attended = effectiveArtist ? store.isAttended(effectiveArtist.slug, s.display_date) : false;
      const artBg    = effectiveArtist?.image_url ? '' : `background:${artistColor(effectiveArtist?.name ?? '')}`;
      const artContent = effectiveArtist?.image_url
        ? `<img src="${esc(effectiveArtist.image_url)}" alt="" loading="lazy">`
        : (() => {
            const parts = s.display_date?.split('-') ?? [];
            const mn = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
            const month = parts[1] ? (mn[parseInt(parts[1],10)-1] ?? '') : '';
            const day   = parts[2] ? String(parseInt(parts[2],10)) : '';
            const year  = parts[0] ?? '';
            return `<div class="typo-artist">${esc(effectiveArtist?.name ?? '')}</div>
                    <div class="typo-month">${esc(month)}</div>
                    <div class="typo-day">${esc(day)}</div>
                    <div class="typo-year">${esc(year)}</div>`;
          })();
      return `
        <div class="show-card" data-date="${esc(s.display_date)}">
          <div class="show-card-art${effectiveArtist?.image_url ? '' : ' typo'}" style="${artBg}">
            ${artContent}
            <div class="card-play">&#9654;</div>
          </div>
          <div class="show-card-body">
            <div class="show-card-date">${esc(s.display_date)}</div>
            <div class="show-card-venue">${esc(s.venue?.name ?? '')}</div>
            <div class="show-card-badges">
              ${s.has_soundboard_source ? '<span class="badge badge-sbd">SBD</span>' : ''}
              ${s.avg_rating ? `<span class="star">${stars(s.avg_rating)}</span>` : ''}
              ${myRating ? `<span class="badge badge-mine">★${myRating}</span>` : ''}
              ${attended ? '<span class="badge badge-attended">📍</span>' : ''}
              ${(s.source_count ?? 1) > 1 ? `<span class="badge badge-src">${s.source_count} src</span>` : ''}
              <button class="show-heart ${fav ? 'favorited' : ''}" data-date="${esc(s.display_date)}" title="${fav ? 'Unsave' : 'Save'}">♥</button>
            </div>
          </div>
        </div>`;
    }).join(''));
    $('showCount').textContent = `${list.length} show${list.length!==1?'s':''}`;

    $('showListEl').querySelectorAll('.show-card').forEach(card =>
      card.addEventListener('click', e => {
        if (e.target.classList.contains('show-heart')) return;
        viewShow(effectiveArtist, card.dataset.date);
      }));

    $('showListEl').querySelectorAll('.show-heart').forEach(btn =>
      btn.addEventListener('click', e => {
        e.stopPropagation();
        if (!effectiveArtist) return;
        const show = shows.find(s => s.display_date === btn.dataset.date);
        if (!show) return;
        const nowFav = store.toggleFav(show, effectiveArtist);
        btn.classList.toggle('favorited', nowFav);
        btn.title = nowFav ? 'Unsave' : 'Save';
      }));

    if (effectiveArtist) {
      $('showListEl').querySelectorAll('.venue-link').forEach(link =>
        link.addEventListener('click', async e => {
          e.stopPropagation();
          const vname = link.dataset.venue;
          showLoading();
          setBreadcrumb([
            { label: effectiveArtist.name, onClick: () => viewYears(effectiveArtist) },
            { label: `📍 ${vname}` },
          ]);
          try {
            const all        = await getAllShows(effectiveArtist);
            const venueShows = all.filter(s => s.venue?.name === vname);
            if (venueShows.length) {
              viewShowList(effectiveArtist, venueShows, `📍 ${vname}`);
            } else {
              showError(`No shows found at ${vname}`);
            }
          } catch(e2) { console.error('[views-core] venue link', e2); showError(e2.message); }
        }));
    }
  }

  const bar = buildFilterBar(shows, renderRows);
  $('filterBarSlot').appendChild(bar);
  renderRows(shows);
}

/* ── Show detail ─────────────────────────────────── */
export async function viewShow(artist, date) {
  nav.record(viewShow, [artist, date]);
  showLoading();
  try {
    const show = await api.show(artist.slug, date);
    state.show = show;
    const year = (show.display_date || date).slice(0, 4);
    setBreadcrumb([
      { label: artist.name, onClick: () => viewYears(artist) },
      { label: year,        onClick: () => viewShows(artist, year) },
      { label: show.display_date || date },
    ]);
    renderShow(show, artist);
  } catch(e) { console.error('[views-core] viewShow', e); showError(e.message); }
}

export function renderShow(show, artist) {
  const sources   = show.sources ?? [];
  const fav       = store.isFav(artist.slug, show.display_date);
  const shareUrl  = `https://relisten.net/${artist.slug}/${show.display_date}`;
  const heroColor = artistColor(artist.name);
  const artHtml   = artist.image_url
    ? `<img src="${esc(artist.image_url)}" alt="${esc(artist.name)}">`
    : `<span class="art-init">${esc(artist.name[0]?.toUpperCase() ?? '?')}</span>`;

  safeInnerHTML($('contentInner'), `
    <div class="show-header" style="--hero-bg:${heroColor}">
      <div class="show-header-wrap">
        <div class="show-art" id="relistenShowArt" style="${artist.image_url ? '' : `background:${heroColor}`}">${artHtml}</div>
        <div class="show-header-info">
          <h1>${esc(show.display_date)}</h1>
          <div class="show-venue-full">
            ${esc(show.venue?.name??'')}${show.venue?.location?' — '+esc(show.venue.location):''}
          </div>
          <div class="show-tags">
            ${show.has_soundboard_source      ?'<span class="tag tag-green">Soundboard</span>':''}
            ${show.has_streamable_flac_source ?'<span class="tag">FLAC</span>':''}
            ${show.avg_rating                 ?`<span class="tag tag-gold">${stars(show.avg_rating)}</span>`:''}
            ${show.tour_name                  ?`<span class="tag">${esc(show.tour_name)}</span>`:''}
            <span class="tag">${sources.length} recording${sources.length!==1?'s':''}</span>
          </div>
          <div class="show-personal-row">
            <div class="show-rating-stars" id="showRatingStars">
              ${[1,2,3,4,5].map(n=>`<button class="pr-star${n<=(store.getRating(artist.slug,show.display_date)??0)?' filled':''}" data-r="${n}">★</button>`).join('')}
              <span class="pr-label">${store.getRating(artist.slug,show.display_date)?'Your rating':'Rate this show'}</span>
            </div>
            <button class="action-btn attended-btn${store.isAttended(artist.slug,show.display_date)?' active':''}" id="btnAttended">
              📍 I Was There
            </button>
          </div>
          <div class="show-actions">
            <button class="action-btn primary" id="btnPlayAll">▶ Play Best Recording</button>
            <button class="action-btn show-heart-btn ${fav?'active':''}" id="btnFav">${fav?'♥ Saved':'♡ Save'}</button>
            <button class="action-btn" id="btnShare" title="Copy Relisten link">🔗 Share</button>
            <button class="action-btn" id="btnCompanion" title="Recording info &amp; notes">ℹ Info</button>
            <button class="action-btn" id="btnDownloadShow" title="Archive every track to your Music folder">⬇ Download Show</button>
          </div>
        </div>
      </div>
    </div>
    <div id="sourceArea"></div>`);
  fadeIn();

  // Enrich with Last.fm artist image if Relisten doesn't have one
  if (!artist.image_url) {
    lastfmArtistImage(artist.name).then(imgUrl => {
      if (!imgUrl) return;
      artist._wikiImg = imgUrl;
      const artEl = $('relistenShowArt');
      if (artEl) {
        const img = new Image();
        img.alt = artist.name;
        img.onload = () => { artEl.innerHTML = ''; artEl.appendChild(img); artEl.style.background = ''; };
        img.src = imgUrl;
      }
      if (state.artist?.slug === artist.slug) setPlayerArt(artist, imgUrl, state.show);
    });
  }

  $('btnFav').addEventListener('click', () => {
    const nowFav = store.toggleFav(show, artist);
    $('btnFav').classList.toggle('active', nowFav);
    $('btnFav').textContent = nowFav ? '♥ Saved' : '♡ Save';
  });

  $('btnShare').addEventListener('click', () => {
    navigator.clipboard.writeText(shareUrl).then(() => showToast('Relisten link copied!'));
  });

  $('btnCompanion').addEventListener('click', () => {
    const panel = $('companionPanel');
    if (panel.classList.contains('open')) { closeCompanion(); return; }
    openCompanion(state.source ?? sources[0], { ...show, artist_slug: artist.slug });
  });

  // Personal rating stars
  function refreshStars() {
    const r = store.getRating(artist.slug, show.display_date) ?? 0;
    $('showRatingStars').querySelectorAll('.pr-star').forEach(s => s.classList.toggle('filled', +s.dataset.r <= r));
    $('showRatingStars').querySelector('.pr-label').textContent = r ? 'Your rating' : 'Rate this show';
  }
  $('showRatingStars').querySelectorAll('.pr-star').forEach(btn =>
    btn.addEventListener('click', () => {
      const prev = store.getRating(artist.slug, show.display_date);
      const val  = +btn.dataset.r;
      store.setRating(artist.slug, show.display_date, prev === val ? null : val);
      refreshStars();
    }));

  $('btnAttended').addEventListener('click', () => {
    const now = store.toggleAttended(artist, show);
    $('btnAttended').classList.toggle('active', now);
    showToast(now ? '📍 Marked as attended!' : 'Attendance removed');
  });

  // Render one source chip — used for both the default top-6 list and the
  // "show all" expanded view. Pure formatting, no state mutation.
  // Horizontal chip: badge + taper + rating in a single compact line. JC
  // intentionally lives in the metadata block (below, active source only)
  // rather than on every chip — it adds visual noise when the user is
  // scanning a row of 6+ chips looking for the SBD or best AUD.
  function renderSourceChip(s, i, active) {
    const cls     = classifySource(s);
    const taper   = formatTaperLabel(s);
    const reviews = s.num_reviews ?? s.review_count ?? 0;
    const best    = isBestSource(s, sources);
    return `
      <button class="source-chip ${active ? 'active' : ''}" data-sidx="${i}" type="button">
        <span class="src-badge src-${cls.type}" title="${esc(cls.label)}">${cls.type}</span>
        <span class="src-taper">${taper ? esc(taper) : '<span class="src-anon">—</span>'}</span>
        <span class="src-rating">
          ${s.avg_rating ? `★ ${s.avg_rating.toFixed(2)}` : ''}
          ${reviews ? `<span class="src-reviews">(${reviews})</span>` : ''}
        </span>
        ${best ? '<span class="src-best">BEST</span>' : ''}
      </button>`;
  }

  function renderSourceArea(idx, opts = {}) {
    const src = sources[idx]; if (!src) return;
    state.source = src;
    const tracks = flatTracks(src);

    // Persist "expanded" across re-renders within the same show — clicking
    // a chip in the expanded view shouldn't collapse it back.
    const expanded = opts.expanded ?? (renderSourceArea._expanded === true);
    renderSourceArea._expanded = expanded;

    // Sort by rating desc for chip display, so the top sources land first
    // regardless of API order. Track the original index so the click
    // handler still picks the right source.
    const sortedSources = sources
      .map((s, i) => ({ s, i }))
      .sort((a, b) => (b.s.avg_rating ?? 0) - (a.s.avg_rating ?? 0));
    const visible = expanded ? sortedSources : sortedSources.slice(0, 6);
    const hidden  = sortedSources.length - visible.length;

    // Upgraded metadata block — shows the active source's full provenance.
    // Includes the archive.org link (clickable to view the item upstream)
    // and a duration/track-count summary which is useful because sources
    // sometimes split sets differently from one another.
    const meta = (() => {
      const cls = classifySource(src);
      const dur = src.duration ? `${Math.floor(src.duration/3600)}:${String(Math.floor((src.duration%3600)/60)).padStart(2,'0')}:${String(Math.floor(src.duration%60)).padStart(2,'0')}` : null;
      const numTracks = (src.sets ?? []).reduce((n, s) => n + (s.tracks?.length ?? 0), 0);
      const numSets   = (src.sets ?? []).length;
      const upstream  = src.upstream_identifier;
      const upstreamUrl = upstream ? `https://archive.org/details/${encodeURIComponent(upstream)}` : null;
      const reviews   = src.num_reviews ?? src.review_count ?? 0;

      return `
        <div class="source-meta">
          <div class="source-meta-header">
            <span class="src-badge src-${cls.type}">${cls.type}</span>
            <span class="source-meta-source-label">${esc(src.source || cls.label)}</span>
          </div>
          <div class="source-meta-grid">
            ${src.taper      ? `<div><span class="meta-k">Taper</span>${esc(src.taper)}</div>` : ''}
            ${src.transferrer? `<div><span class="meta-k">Transferrer</span>${esc(src.transferrer)}</div>` : ''}
            ${src.lineage    ? `<div><span class="meta-k">Lineage</span>${esc(src.lineage)}</div>` : ''}
            ${dur            ? `<div><span class="meta-k">Duration</span>${dur} · ${numTracks} tracks${numSets > 1 ? ` · ${numSets} sets` : ''}</div>` : ''}
            ${reviews        ? `<div><span class="meta-k">Reviews</span>${reviews} · ★ ${src.avg_rating?.toFixed(2) ?? '—'}</div>` : ''}
            ${src.has_jamcharts ? `<div><span class="meta-k">Annotations</span>📊 Has Jam Charts</div>` : ''}
            ${src.taper_notes? `<div class="meta-wide"><span class="meta-k">Notes</span>${esc(src.taper_notes)}</div>` : ''}
            ${src.description && !src.taper_notes ? `<div class="meta-wide"><span class="meta-k">Info</span>${esc(src.description)}</div>` : ''}
            ${upstreamUrl    ? `<div class="meta-wide"><span class="meta-k">Archive</span><a class="meta-archive-link" data-href="${esc(upstreamUrl)}">${esc(upstream)} ↗</a></div>` : ''}
          </div>
        </div>`;
    })();

    safeInnerHTML($('sourceArea'), `
      <div class="source-picker">
        <div class="source-picker-header">
          <span class="source-picker-count">${sources.length} source${sources.length===1?'':'s'} for this show</span>
          ${sources.length > 1 ? `<span class="source-picker-hint">— click any to switch</span>` : ''}
        </div>
        <div class="source-chips">
          ${visible.map(({s, i}) => renderSourceChip(s, i, i === idx)).join('')}
        </div>
        ${hidden > 0 ? `
          <button class="source-expand" type="button" data-action="expand">
            Show ${hidden} more source${hidden===1?'':'s'} ▾
          </button>` : ''}
        ${expanded && sources.length > 6 ? `
          <button class="source-expand" type="button" data-action="collapse">
            Show fewer ▴
          </button>` : ''}
      </div>
      ${meta}
      <div id="trackList">
        ${(src.sets??[]).map((set,si)=>`
          ${set.name?`<div class="set-label">${esc(set.name)}</div>`
            :(src.sets?.length??0)>1?`<div class="set-label">Set ${si+1}</div>`:''}
          ${(set.tracks??[]).filter(t=>t.mp3_url).map((t,ti)=>`
            <div class="track-row" data-track-uuid="${esc(t.uuid)}" data-track-pos="${ti+1}">
              <div class="track-num">${ti+1}</div>
              <div class="track-name">${esc(t.title||'Unknown')}</div>
              <div class="track-dur">${fmt(t.duration)}</div>
              <button class="track-stats-btn" data-title="${esc(t.title||'')}" title="Show occurrences">📊</button>
              <button class="track-add-tape" data-track-uuid="${esc(t.uuid)}" title="Add to tape">📼</button>
            </div>`).join('')}
        `).join('')}
      </div>`);

    if (state.queue[state.queueIdx]) {
      const el = document.querySelector(`[data-track-uuid="${state.queue[state.queueIdx].uuid}"]`);
      if (el) { el.classList.add('playing'); el.querySelector('.track-num').textContent = '▶'; }
    }

    $('sourceArea').querySelectorAll('.source-chip').forEach(chip =>
      chip.addEventListener('click', () => {
        closeCompanion();
        // Pause playback when switching sources — the currently playing
        // track is from the OLD source and its track list / file URL no
        // longer correspond to what the user is about to see. Pausing
        // surfaces the switch clearly rather than leaving the previous
        // source quietly streaming in the background.
        if (state.source !== sources[parseInt(chip.dataset.sidx)]) {
          try { audio?.pause(); } catch { /* no audio element yet */ }
        }
        renderSourceArea(parseInt(chip.dataset.sidx));
      }));

    $('sourceArea').querySelectorAll('.source-expand').forEach(btn =>
      btn.addEventListener('click', () => {
        renderSourceArea(idx, { expanded: btn.dataset.action === 'expand' });
      }));

    $('sourceArea').querySelectorAll('.meta-archive-link').forEach(a =>
      a.addEventListener('click', e => {
        e.preventDefault();
        const href = a.dataset.href;
        if (href) window.ipc?.openUrl(href);
      }));

    $('sourceArea').querySelectorAll('.track-row').forEach(row =>
      row.addEventListener('click', e => {
        if (e.target.classList.contains('track-add-tape')) return;
        const track = tracks.find(t => t.uuid === row.dataset.trackUuid);
        if (track) player.playTrack(track, src);
      }));

    $('sourceArea').querySelectorAll('.track-add-tape').forEach(btn =>
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const track = tracks.find(t => t.uuid === btn.dataset.trackUuid);
        if (track) showTapePickerForTrack(track);
      }));

    $('sourceArea').querySelectorAll('.track-stats-btn').forEach(btn =>
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const title = btn.dataset.title;
        if (title) viewSongShows(artist, title);
      }));
  }

  // Initial source selection honours Settings → "Prefer Soundboard when
  // available." When the setting is off (default), pickPreferredSourceIdx
  // returns the highest-rated overall source — same as the v1.x behaviour
  // which just used sources[0] (Relisten's payload is already rating-sorted).
  const preferSoundboard = settings.getKey('preferSoundboard', false);
  renderSourceArea(pickPreferredSourceIdx(sources, { preferSoundboard }));
  $('btnPlayAll').addEventListener('click', () => {
    const best = sources.find(s => s.is_soundboard) ?? sources[0];
    if (best) player.playSource(best);
  });

  // ⬇ Download Show — archive the currently-selected source's tracks to disk.
  // Button text doubles as the live progress indicator; the orchestrator yields
  // (`await sleep(0)`) before each download so this update actually paints.
  $('btnDownloadShow').addEventListener('click', async () => {
    const btn = $('btnDownloadShow');
    if (btn.disabled) return;
    btn.disabled = true;
    const orig = btn.textContent;
    const coverUrl = artist._wikiImg ?? artist.image_url ?? null;
    const src = state.source ?? sources[0];
    try {
      await downloadFullShow(artist, show, src, {
        coverUrl,
        onProgress: (cur, total) => { btn.textContent = `Archiving… ${cur}/${total}`; },
        onError:    (err) => console.warn('[btnDownloadShow] track error:', err),
      });
    } catch (err) {
      console.error('[btnDownloadShow] fatal:', err);
      showToast(`Archive failed: ${err.message ?? err}`);
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });

  // Per-show notes — saved to localStorage, esc() used to set textarea value safely
  const noteKey   = `db-note-${artist.slug}-${show.display_date}`;
  const savedNote = localStorage.getItem(noteKey) ?? '';
  const notesSection = document.createElement('div');
  notesSection.className = 'show-notes-section';
  notesSection.innerHTML = `
    <div class="show-notes-label">My Notes</div>
    <textarea class="show-notes-ta" id="showNotesTa" placeholder="Add your notes about this show…"></textarea>
    <div class="show-notes-hint">Auto-saved to this device · included in data export</div>`;
  // Set textarea value via property (not innerHTML) to avoid any injection risk
  notesSection.querySelector('#showNotesTa').value = savedNote;
  $('contentInner').appendChild(notesSection);

  let notesDebounce = null;
  $('showNotesTa').addEventListener('input', e => {
    clearTimeout(notesDebounce);
    notesDebounce = setTimeout(() => localStorage.setItem(noteKey, e.target.value), 600);
  });
  $('showNotesTa').addEventListener('click', e => e.stopPropagation());

  // Similar Shows — loaded async
  const similarSection = document.createElement('div');
  similarSection.id = 'similarShows';
  similarSection.className = 'similar-shows';
  similarSection.innerHTML = `
    <div class="section-header" style="margin-top:8px">
      <div><div class="section-title" style="font-size:13px">Similar Shows</div></div>
    </div>
    <div id="similarShowsList"><div class="loading" style="height:50px;font-size:12px"><div class="spinner"></div></div></div>`;
  $('contentInner').appendChild(similarSection);
  loadSimilarShows(show, artist);
}

export async function loadSimilarShows(show, artist) {
  const section = $('similarShows');
  const list    = $('similarShowsList');
  if (!section || !list) return;
  try {
    const allShows = await getAllShows(artist);
    const scored = allShows
      .filter(s => s.display_date !== show.display_date)
      .map(s => {
        let score = 0;
        if (s.venue?.name && s.venue.name === show.venue?.name) score += 3;
        if (s.tour?.slug  && show.tour?.slug && s.tour.slug === show.tour.slug) score += 3;
        const sy = s.display_date?.slice(0,4), cy = show.display_date?.slice(0,4);
        if (sy && cy) {
          const diff = Math.abs(parseInt(sy) - parseInt(cy));
          if (diff === 0) score += 2; else if (diff <= 2) score += 1;
        }
        if (s.avg_rating && show.avg_rating && Math.abs(s.avg_rating - show.avg_rating) <= 0.5) score += 1;
        return { show: s, score };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score || (b.show.avg_rating ?? 0) - (a.show.avg_rating ?? 0))
      .slice(0, 8)
      .map(x => x.show);

    if (!scored.length) { section.style.display = 'none'; return; }

    safeInnerHTML(list, scored.map(s => `
      <div class="show-row" data-date="${esc(s.display_date)}" style="cursor:pointer">
        <div class="show-date">${esc(s.display_date)}</div>
        <div class="show-venue">${esc(s.venue?.name ?? '')}</div>
        <div class="show-badges">
          ${s.has_soundboard_source ? '<span class="badge badge-sbd">SBD</span>' : ''}
          ${s.avg_rating ? `<span class="star">${stars(s.avg_rating)}</span>` : ''}
        </div>
      </div>`).join(''));
    list.querySelectorAll('.show-row').forEach(row =>
      row.addEventListener('click', () => viewShow(artist, row.dataset.date)));
  } catch { section.style.display = 'none'; }
}

export function renderShowCards(shows, title) {
  safeInnerHTML($('contentInner'), `
    <div class="section-header">
      <div><div class="section-title">${esc(title)}</div><div class="section-subtitle">${shows.length} shows</div></div>
    </div>
    <div class="show-cards" id="showCardsGrid"></div>`);

  safeInnerHTML($('showCardsGrid'), shows.map(s => {
    const artist   = resolveShowArtist(s);
    if (!artist?.slug) return ''; // skip un-resolvable shows
    const artStyle = artist.image_url
      ? `background-image:url('${esc(artist.image_url)}');background-color:${artistColor(artist.name)}`
      : `background-color:${artistColor(artist.name)}`;
    const artInner = artist.image_url
      ? `<img src="${esc(artist.image_url)}" alt="" loading="lazy">`
      : `<span class="art-init">${esc(artist.name[0]?.toUpperCase() ?? '?')}</span>`;
    return `
      <div class="show-card" data-slug="${esc(artist.slug)}" data-date="${esc(s.display_date)}">
        <div class="show-card-art" style="${artStyle}">${artInner}<span class="card-play">▶</span></div>
        <div class="show-card-body">
          <div class="show-card-artist">${esc(artist.name)}</div>
          <div class="show-card-date">${esc(s.display_date)}</div>
          <div class="show-card-venue">${esc(s.venue?.name ?? '')}</div>
          <div class="show-card-badges">
            ${s.has_soundboard_source ? '<span class="badge badge-sbd">SBD</span>' : ''}
            ${s.avg_rating ? `<span class="star">${stars(s.avg_rating)}</span>` : ''}
          </div>
        </div>
      </div>`;
  }).join(''));

  $('showCardsGrid').querySelectorAll('.show-card').forEach(card =>
    card.addEventListener('click', () => {
      const artist = state.artists.find(a => a.slug === card.dataset.slug)
        ?? { name: card.dataset.slug, slug: card.dataset.slug };
      state.artist = artist;
      viewShow(artist, card.dataset.date);
    }));
}

export async function viewTrending() {
  nav.record(viewTrending, []);
  showLoading(); setBreadcrumb([{ label: 'Trending Shows' }]);
  try {
    // Trending payload only carries artist_uuid — resolveShowArtist needs
    // state.artists for the uuid→slug lookup. Wait briefly if it's still loading.
    for (let i = 0; i < 30 && !state.artists?.length; i++) {
      await new Promise(r => setTimeout(r, 100));
    }
    const data  = await api.trending();
    const shows = data.shows ?? data;
    renderShowCards(shows, '🔥 Trending Shows');
  } catch(e) { console.error('[views-core] viewTrending', e); showError(e.message); }
}

export async function viewRecent() {
  nav.record(viewRecent, []);
  showLoading(); setBreadcrumb([{ label: 'Recently Added' }]);
  try {
    const data = await api.recent();
    renderShowList(data.shows ?? data, null, '🆕 Recently Added');
  } catch(e) { console.error('[views-core] viewRecent', e); showError(e.message); }
}

/* ── Nugs Pin helpers (localStorage) ────────────────────────────
   Pinned artist: { id, name }  stored as JSON array.             */
const NUGS_PINS_KEY = 'nugs_pinned_artists';
function getNugsPins() {
  try { return JSON.parse(localStorage.getItem(NUGS_PINS_KEY) ?? '[]'); } catch { return []; }
}
function setNugsPins(pins) {
  localStorage.setItem(NUGS_PINS_KEY, JSON.stringify(pins));
}
function isNugsPin(id) {
  return getNugsPins().some(p => p.id === String(id));
}
function toggleNugsPin(artist) {
  const pins = getNugsPins();
  const idx  = pins.findIndex(p => p.id === String(artist.id));
  if (idx >= 0) pins.splice(idx, 1); else pins.push({ id: String(artist.id), name: artist.name });
  setNugsPins(pins);
  return idx < 0; // true = now pinned
}

/* ── Nugs sidebar search state ───────────────────────────────── */
let _nugsSearchResults  = null;  // null = not searching, Array = results ready
let _nugsSearchDebounce = null;
let _nugsLetterFilter   = null;  // null = all letters, 'A'..'Z' / '#' = filter

/* ── Nugs sidebar row renderer ───────────────────────────────── */
// Renders artists from nugsApi catalog ({ id, name, numShows })
// or pinned artists ({ id, name }).  Shows a Pin/Unpin button.
function renderNugsCatalogRows(artists, showPinBtn = true) {
  if (!artists.length) return '';
  return artists.map(a => {
    const pinned = isNugsPin(a.id);
    const pinBtn = showPinBtn ? `
      <button class="nugs-fav-btn ${pinned ? 'active' : ''}"
              data-nugs-pin-id="${esc(String(a.id))}"
              data-nugs-pin-name="${esc(a.name)}"
              title="${pinned ? 'Unpin artist' : 'Pin artist'}">📌</button>` : '';
    return `
      <div class="artist-item nugs-catalog-item" data-nugs-id="${esc(String(a.id))}" data-nugs-name="${esc(a.name)}">
        <div class="artist-avatar" style="background-color:${artistColor(a.name)}">
          <span>${esc((a.name[0] ?? 'N').toUpperCase())}</span>
        </div>
        <span class="artist-name">${esc(a.name)}</span>
        ${pinBtn}
      </div>`;
  }).join('');
}

/* ── Sidebar ─────────────────────────────────────── */
export function renderArtists(artists) {
  if (sidebarSource === 'nugs') {
    const footer = $('sidebarFooter');
    if (footer) footer.style.display = 'none';

    const liveHubRow = `
      <div class="nugs-live-hub-btn" id="nugsLiveHubBtn">
        <span class="live-hub-dot">●</span>&nbsp;LIVE HUB
      </div>`;

    let bodyHtml = '';

    const cache   = nugsApi._artistCache;
    const searchQ = ($('artistSearch')?.value ?? '').trim().toLowerCase();

    if (cache) {
      // ── Catalog loaded — sort, split pinned vs unpinned, apply letter/search filters
      const sorted = [...cache].sort((a, b) =>
        (a.artistName ?? '').localeCompare(b.artistName ?? ''));
      const allRows = sorted.map(a => ({
        id: String(a.artistID), name: a.artistName, numShows: a.numShows ?? 0,
      }));

      const pinIdSet   = new Set(getNugsPins().map(p => String(p.id)));
      const pinnedRows = allRows.filter(r =>  pinIdSet.has(r.id));
      let unpinnedRows = allRows.filter(r => !pinIdSet.has(r.id));

      // Sidebar search wins over letter filter — both narrow the unpinned list
      if (searchQ) {
        unpinnedRows = unpinnedRows.filter(r => r.name?.toLowerCase().includes(searchQ));
      } else if (_nugsLetterFilter) {
        const isDigit = _nugsLetterFilter === '#';
        unpinnedRows = unpinnedRows.filter(r => {
          const c = (r.name?.[0] ?? '').toUpperCase();
          return isDigit ? !/[A-Z]/.test(c) : c === _nugsLetterFilter;
        });
      }

      // Build the A-Z (+ '#') letter bar from what's actually in the unpinned catalog
      const presentLetters = new Set();
      for (const r of allRows.filter(r => !pinIdSet.has(r.id))) {
        const c = (r.name?.[0] ?? '').toUpperCase();
        presentLetters.add(/[A-Z]/.test(c) ? c : '#');
      }
      const ALPHABET = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')];
      const letterBarHtml = searchQ ? '' : `
        <div class="nugs-letter-bar" id="nugsLetterBar">
          <button class="nugs-letter-btn ${!_nugsLetterFilter ? 'active' : ''}" data-letter="">All</button>
          ${ALPHABET.map(L => {
            const has = presentLetters.has(L);
            const cls = `nugs-letter-btn${_nugsLetterFilter === L ? ' active' : ''}${has ? '' : ' disabled'}`;
            return `<button class="${cls}" data-letter="${L}" ${has ? '' : 'disabled'}>${L}</button>`;
          }).join('')}
        </div>`;

      const pinnedHtml = pinnedRows.length
        ? `<div class="nugs-section-label">📌 Pinned</div>${renderNugsCatalogRows(pinnedRows)}<div class="nugs-section-divider"></div>`
        : '';

      let unpinnedHtml;
      if (unpinnedRows.length) {
        unpinnedHtml = renderNugsCatalogRows(unpinnedRows);
      } else if (searchQ) {
        unpinnedHtml = `<div class="sidebar-empty-nugs">No results for "${esc(searchQ)}"</div>`;
      } else if (_nugsLetterFilter) {
        unpinnedHtml = `<div class="sidebar-empty-nugs">No artists under "${esc(_nugsLetterFilter)}"</div>`;
      } else {
        unpinnedHtml = '';
      }

      bodyHtml = liveHubRow + letterBarHtml + pinnedHtml + unpinnedHtml;
    } else {
      // ── Cache not loaded yet — show pins as placeholders, trigger background load
      const pins = getNugsPins();
      bodyHtml = liveHubRow + (pins.length
        ? renderNugsCatalogRows(pins)
        : `<div class="sidebar-empty-nugs">Loading artists…</div>`);
      nugsApi.allArtists().then(() => {
        if (sidebarSource === 'nugs') renderArtists([]);
      }).catch(() => {});
    }

    safeInnerHTML($('artistList'), bodyHtml);

    // ── Wire Live Hub button ───────────────────────────────────────
    $('artistList').querySelector('#nugsLiveHubBtn')?.addEventListener('click', () => {
      document.querySelectorAll('.artist-item').forEach(i => i.classList.remove('active'));
      import('./views-nugs.js').then(m => m.viewNugsDashboard());
    });

    // ── Wire letter-bar buttons ────────────────────────────────────
    $('artistList').querySelectorAll('.nugs-letter-btn').forEach(btn =>
      btn.addEventListener('click', e => {
        e.stopPropagation();
        if (btn.disabled) return;
        _nugsLetterFilter = btn.dataset.letter || null;
        renderArtists([]);
      }));

    // ── Wire 📌 pin/unpin buttons ──────────────────────────────────
    $('artistList').querySelectorAll('.nugs-fav-btn').forEach(btn =>
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const artist = { id: btn.dataset.nugsPinId, name: btn.dataset.nugsPinName };
        const nowPinned = toggleNugsPin(artist);
        btn.classList.toggle('active', nowPinned);
        btn.title = nowPinned ? 'Unpin artist' : 'Pin artist';
        renderArtists([]);
        showToast(nowPinned ? `📌 ${artist.name} pinned` : `${artist.name} unpinned`);
      }));

    // ── Wire artist row clicks ─────────────────────────────────────
    $('artistList').querySelectorAll('.nugs-catalog-item').forEach(item =>
      item.addEventListener('click', e => {
        if (e.target.classList.contains('nugs-fav-btn')) return;
        document.querySelectorAll('.artist-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        const id   = item.dataset.nugsId ?? '';
        const name = item.dataset.nugsName ?? '';
        if (id) nugsViewArtist({ id, name, slug: `nugs-${id}`, _nugs: true });
      }));

    // NOTE — sidebar avatar lazy-load was previously attempted here but
    // disabled. Two issues forced the rollback:
    //   1. The renderer iterates the entire Nugs catalog (~600 artists)
    //      regardless of which letter slice is visible, producing a fetch
    //      storm even with the cache.
    //   2. catalog.artist (streamapi) doesn't return an avatar URL field,
    //      so every fetch resolved to null anyway.
    // Avatar wiring will return once we identify a usable image source —
    // either an HTML scrape of the artist page or a different streamapi
    // method. For now, the colored-initial tile is the canonical look.

    return;
  }

  // Relisten / other tabs — hide the Nugs-only footer
  const footer = $('sidebarFooter');
  if (footer) footer.style.display = 'none';

  const favSlugs = new Set(store.getArtistFavs());
  const sorted   = [...artists].sort((a, b) => {
    const af = favSlugs.has(a.slug), bf = favSlugs.has(b.slug);
    if (af && !bf) return -1; if (bf && !af) return 1; return 0;
  });

  safeInnerHTML($('artistList'), sorted.map(a => {
    const isFav = favSlugs.has(a.slug);
    const avatarStyle = a.image_url
      ? `background-image:url('${esc(a.image_url)}');background-color:${artistColor(a.name)}`
      : `background-color:${artistColor(a.name)}`;
    const avatarInner = a.image_url ? '' : `<span>${esc(a.name[0]?.toUpperCase() ?? '?')}</span>`;
    return `<div class="artist-item ${isFav ? 'favorited' : ''}" data-slug="${esc(a.slug)}">
      <div class="artist-avatar" style="${avatarStyle}">${avatarInner}</div>
      <span class="artist-name">${esc(a.name)}</span>
      ${a.show_count ? `<span class="artist-count">${a.show_count}</span>` : ''}
      <button class="artist-fav-btn ${isFav ? 'active' : ''}" data-slug="${esc(a.slug)}" title="${isFav ? 'Unfavorite' : 'Favorite'}">★</button>
    </div>`;
  }).join(''));

  setTimeout(enrichArtistAvatars, 0);

  $('artistList').querySelectorAll('.artist-item').forEach(item =>
    item.addEventListener('click', e => {
      if (e.target.classList.contains('artist-fav-btn')) return;
      document.querySelectorAll('.artist-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelector('[data-tab="artists"]').classList.add('active');
      const artist = state.artists.find(a => a.slug === item.dataset.slug);
      if (artist) viewYears(artist);
    }));

  $('artistList').querySelectorAll('.artist-fav-btn').forEach(btn =>
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const nowFav = store.toggleArtistFav(btn.dataset.slug);
      showToast(nowFav ? 'Artist favorited' : 'Removed from favorites');
      renderArtists(state.filteredArtists);
    }));
}

// Artist search input
$('artistSearch').addEventListener('input', e => {
  const q = e.target.value.trim();

  if (sidebarSource === 'nugs') {
    // renderArtists reads artistSearch.value directly from the DOM, so just re-render.
    // If the catalog isn't cached yet it triggers a background load automatically.
    // Typing in the search box overrides any active letter filter.
    if (q) _nugsLetterFilter = null;
    clearTimeout(_nugsSearchDebounce);
    _nugsSearchDebounce = setTimeout(() => renderArtists([]), 150);
    return;
  }

  // Relisten sidebar — local filter
  const lq = q.toLowerCase();
  state.filteredArtists = lq
    ? state.artists.filter(a => a.name.toLowerCase().includes(lq))
    : state.artists;
  renderArtists(state.filteredArtists);
});

export async function enrichArtistAvatars() {
  const items = [...$('artistList').querySelectorAll('.artist-item')];
  for (const item of items) {
    const name = item.querySelector('.artist-name')?.textContent?.trim();
    if (!name) continue;
    const imgUrl = await lastfmArtistImage(name);
    if (!imgUrl) continue;
    const av = item.querySelector('.artist-avatar');
    if (!av || av.querySelector('img')) continue;
    const img = new Image();
    img.alt = name;
    img.onload = () => { av.innerHTML = ''; av.appendChild(img); av.style.backgroundImage = ''; };
    img.src = imgUrl;
  }
}
