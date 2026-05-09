/* ── views-nugs.js — Nugs.net browsing views ──────────────────── */
import { $, esc, fmt, artistColor, showToast, shuffle, confirmDialog } from './utils.js';
import { state, nav, settings, nugsAuth, nugsArtistStore, nugsReleasesCache, sidebarSource } from './state.js';
import { nugsApi, nugsContainerImage } from './api.js';
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

/* ── Welcome / landing view ──────────────────────── */
export function viewNugsWelcome() {
  const ci = $('nugsContentInner');
  if (!ci) return;
  ci.innerHTML = `
    <div class="welcome">
      <div class="welcome-logo" style="font-size:40px">🎵</div>
      <h2>Nugs.net</h2>
      <p>Choose an artist from the sidebar,<br>or tap <strong>● LIVE HUB</strong> for live webcasts.</p>
    </div>`;
}

/* ── Helpers ─────────────────────────────────────── */
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Normalize nugs performanceDate → YYYY-MM-DD.
// Handles: "YYYY-MM-DD", "MM/DD/YYYY", "MM/DD/YYYY HH:MM:SS"
function nugsIsoDate(d) {
  if (!d) return '';
  const iso = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return `${us[3]}-${us[1].padStart(2,'0')}-${us[2].padStart(2,'0')}`;
  return d;
}

function applyNugsFilters(releases, { sortAsc, year, month, type }) {
  let list = releases.filter(r => {
    const d = nugsIsoDate(r.performanceDate);
    const isVideo = !!(r.videoURL || r.videoChapters || r.vodPlayerImage
      || r.containerTypeStr?.toLowerCase().includes('video'));
    if (type === 'audio' && isVideo)  return false;
    if (type === 'video' && !isVideo) return false;
    if (year  && !d.startsWith(year))                return false;
    if (month && !d.startsWith(`${year}-${month}`)) return false;
    return true;
  });
  list.sort((a, b) => {
    const da = nugsIsoDate(a.performanceDate), db = nugsIsoDate(b.performanceDate);
    return sortAsc ? (da > db ? 1 : -1) : (db > da ? 1 : -1);
  });
  return list;
}

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
];

/** Recently Added — sorts by `epochDateCreated` (the unix timestamp Nugs
 *  attaches when the container is first added to the catalog). This is
 *  distinct from `performanceDate` (the actual concert date), so the result
 *  ordering on this tab differs from the year-grouped view. Falls back to
 *  releaseDate, then performanceDate. */
function sortByRecent(releases) {
  const score = c => {
    if (Number.isFinite(c.epochDateCreated)) return Number(c.epochDateCreated);
    const r = c.releaseDate ?? c.dateCreated ?? c.performanceDate;
    return r ? new Date(nugsIsoDate(r)).getTime() / 1000 : 0;
  };
  return [...releases].sort((a, b) => score(b) - score(a));
}

/** Most Popular — Nugs ships per-container sales counters (`salesAllTime`
 *  and `salesLast30`). Sort by all-time sales desc with last-30-days as a
 *  tiebreaker. If every container reports 0 (some artist tiers don't expose
 *  this), fall back to recently-added so the tab isn't just an alphabetical
 *  pile. */
function sortByPopular(releases) {
  const score = c => Number(c.salesAllTime ?? 0);
  const tie   = c => Number(c.salesLast30  ?? 0);
  const sorted = [...releases].sort((a, b) => score(b) - score(a) || tie(b) - tie(a));
  return sorted.some(c => score(c) > 0 || tie(c) > 0) ? sorted : sortByRecent(releases);
}

export async function nugsViewArtist(artist) {
  nav.record(nugsViewArtist, [artist]);
  state.artist = artist;
  setBreadcrumb([{ label: artist.name }]);
  nugsCI().innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
  try {
    if (!nugsReleasesCache[artist.id]) {
      let all = [], offset = 1, batch;
      do {
        const data = await nugsApi.catalog(artist.id, offset);
        batch = data?.Response?.containers ?? data?.response?.containers ?? [];
        all   = all.concat(batch);
        offset += 100;
      } while (batch.length === 100);
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
    const filters = { sortAsc: false, year: null, month: null, type: 'all' };

    function renderTabBar() {
      const tb = $('nugsArtistTabs');
      if (!tb) return;
      tb.innerHTML = NUGS_TABS.map(t =>
        `<button class="nugs-tab-btn${tab === t.id ? ' active' : ''}" data-tab="${t.id}">${esc(t.label)}</button>`
      ).join('');
      tb.querySelectorAll('.nugs-tab-btn').forEach(btn =>
        btn.addEventListener('click', () => {
          if (tab === btn.dataset.tab) {
            // Clicking the active "By Year" tab again pops back to the year
            // picker — useful affordance now that By Year has two layers.
            if (tab === 'year' && selectedYear) {
              selectedYear = null;
              filters.year = null;
              filters.month = null;
              refresh();
            }
            return;
          }
          tab = btn.dataset.tab;
          // Switching tabs resets the By Year drill-down state.
          selectedYear = null;
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
            </div>
          </div>
        </div>
      </div>
      <div id="nugsTrackList">
        ${normTracks.map((t, i) => `
          <div class="track-row" data-track-uuid="${esc(t.uuid)}" data-track-pos="${i + 1}">
            <div class="track-num">${i + 1}</div>
            <div class="track-name">${esc(t.title)}${t._nugs_video ? ' 🎬' : ''}</div>
            <div class="track-dur">${fmt(t.duration)}</div>
          </div>`).join('')}
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
      console.log('[Nugs Art] Loading from CDN:', showArtUrl);
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
        console.log(`[Nugs Art] SUCCESS! ${img.naturalWidth}x${img.naturalHeight}`);
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

