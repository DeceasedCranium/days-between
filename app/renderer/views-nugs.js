/* ── views-nugs.js — Nugs.net browsing views ──────────────────── */
import { $, esc, fmt, artistColor, showToast, shuffle } from './utils.js';
import { state, nav, nugsAuth, nugsArtistStore, nugsReleasesCache } from './state.js';
import { nugsApi } from './api.js';
import { injectArtistBio, lastfmArtistImage } from './lastfm.js';
import { nugsResolveAndPlay, handleNugsAuthError, setPlayerArt } from './player.js';
import { scrapeLive, scrapeRecent, scrapeStash, extractContainerId } from './nugs-scraper.js';
import { startLiveStream } from './video-player.js';
// NOTE: setBreadcrumb, fadeIn, renderArtists come from views-core.js.
// ES module circular imports are safe here — functions are only called
// inside event handlers and async functions, never at module init time.
import { setBreadcrumb, fadeIn, renderArtists } from './views-core.js';

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

function renderNugsReleaseRows(releases, artist) {
  const el = $('nugsReleaseList');
  if (!el) return;
  el.innerHTML = releases.length === 0
    ? `<div class="empty-state" style="padding:24px;color:var(--text3);text-align:center">No releases match the current filters</div>`
    : releases.map(c => {
        const isVideo = !!(c.videoURL || c.videoChapters || c.vodPlayerImage
          || c.containerTypeStr?.toLowerCase().includes('video'));
        return `<div class="show-row" data-cid="${esc(String(c.containerID))}">
          <div class="show-date">${esc(nugsIsoDate(c.performanceDate) || String(c.containerID))}</div>
          <div class="show-venue">${esc(c.venueName ?? '')}${c.venueCity ? ' — ' + esc(c.venueCity) : ''}</div>
          <div class="show-badges">
            ${isVideo ? `<span class="badge" title="Video release">🎬</span>` : ''}
          </div>
        </div>`;
      }).join('');
  el.querySelectorAll('.show-row').forEach(row =>
    row.addEventListener('click', () => nugsViewRelease(artist, row.dataset.cid)));
}

/* ── nugsViewArtist ──────────────────────────────── */
export async function nugsViewArtist(artist) {
  nav.record(nugsViewArtist, [artist]);
  state.artist = artist;
  setBreadcrumb([{ label: artist.name }]);
  $('contentInner').innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
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
    // Refresh sidebar count now that we have the release count
    renderArtists(state.filteredArtists);

    const allReleases = nugsReleasesCache[artist.id];

    // Build year/month map for filter bar
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

    const filters = { sortAsc: false, year: null, month: null, type: 'all' };

    function renderFilterBar() {
      const fc = $('nugsFilterControls');
      if (!fc) return;

      const yearOpts = `<option value="">All Years</option>`
        + years.map(y =>
            `<option value="${y}"${filters.year === y ? ' selected' : ''}>${y} (${byYear[y].count})</option>`
          ).join('');

      const monthsForYear = filters.year ? Object.keys(byYear[filters.year]?.months ?? {}).sort() : [];
      const monthOpts = `<option value="">All Months</option>`
        + monthsForYear.map(m => {
            const name  = MONTH_NAMES[parseInt(m, 10) - 1] ?? m;
            const count = byYear[filters.year].months[m];
            return `<option value="${m}"${filters.month === m ? ' selected' : ''}>${name} (${count})</option>`;
          }).join('');

      fc.innerHTML = `
        <button class="filter-btn${!filters.sortAsc ? ' active' : ''}" id="nfSortDesc">Date ▾</button>
        <button class="filter-btn${filters.sortAsc  ? ' active' : ''}" id="nfSortAsc">Date ▴</button>
        <div class="filter-sep"></div>
        <button class="filter-btn${filters.type === 'all'   ? ' active' : ''}" id="nfTypeAll">All</button>
        <button class="filter-btn${filters.type === 'audio' ? ' active' : ''}" id="nfTypeAudio">Audio</button>
        <button class="filter-btn${filters.type === 'video' ? ' active' : ''}" id="nfTypeVideo">🎬 Video</button>
        <div class="filter-sep"></div>
        <select id="nfYear"  class="filter-select">${yearOpts}</select>
        <select id="nfMonth" class="filter-select"${!filters.year ? ' disabled' : ''}>${monthOpts}</select>`;

      $('nfSortDesc').addEventListener('click',  () => { filters.sortAsc = false; refresh(); });
      $('nfSortAsc').addEventListener('click',   () => { filters.sortAsc = true;  refresh(); });
      $('nfTypeAll').addEventListener('click',   () => { filters.type = 'all';   refresh(); });
      $('nfTypeAudio').addEventListener('click', () => { filters.type = 'audio'; refresh(); });
      $('nfTypeVideo').addEventListener('click', () => { filters.type = 'video'; refresh(); });
      $('nfYear').addEventListener('change', e => {
        filters.year = e.target.value || null; filters.month = null; refresh();
      });
      $('nfMonth').addEventListener('change', e => {
        filters.month = e.target.value || null; refresh();
      });
    }

    function refresh() {
      renderFilterBar();
      renderNugsReleaseRows(applyNugsFilters(allReleases, filters), artist);
    }

    const ci            = $('contentInner');
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
          <div id="nugsFilterControls"></div>
        </div>
        <div class="show-list" id="nugsReleaseList"></div>
      </div>`;
    fadeIn(ci);
    injectArtistBio(artist.name);
    refresh();
  } catch (e) {
    if (e.message?.includes('nugs:')) { handleNugsAuthError(e); return; }
    console.error('[views-nugs] nugsViewArtist', e);
    $('contentInner').innerHTML = `<div class="error-state"><p>${esc(e.message)}</p></div>`;
  }
}

/* ── nugsViewRelease ─────────────────────────────── */
export async function nugsViewRelease(artist, containerId) {
  nav.record(nugsViewRelease, [artist, containerId]);
  setBreadcrumb([
    { label: artist.name, fn: () => nugsViewArtist(artist) },
    { label: containerId },
  ]);
  $('contentInner').innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
  try {
    const data      = await nugsApi.release(containerId);
    const container = data?.Response ?? data?.response ?? {};
    const tracks    = container.tracks ?? container.Tracks ?? [];
    const showArtUrl = container.img?.url ? `https://www.nugs.net${container.img.url}` : null;

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
    $('contentInner').innerHTML = `
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
              ${isVideoRelease
                ? '<span class="tag">🎬 Video</span>'
                : `<span class="tag">${normTracks.length} tracks</span>`}
            </div>
            <div class="show-actions">
              ${isVideoRelease
                ? `<button class="action-btn primary" id="btnNugsWatchVideo">🎬 Watch Video</button>`
                : `<button class="action-btn primary" id="btnNugsPlayAll">&#9654; Play All</button>`}
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

    // Load artist image from Last.fm
    lastfmArtistImage(artist.name).then(imgUrl => {
      if (!imgUrl) return;
      artist._wikiImg   = imgUrl;
      playShow._artData = imgUrl;
      const artEl = $('nugsShowArt');
      if (artEl) {
        const img = new Image();
        img.alt = '';
        img.onload = () => { artEl.innerHTML = ''; artEl.appendChild(img); artEl.style.background = ''; };
        img.src = imgUrl;
      }
      if (state.artist?.slug === artist.slug) setPlayerArt(artist, imgUrl, state.show);
    });

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
    } else {
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
    }
  } catch (e) {
    if (e.message?.includes('nugs:')) { handleNugsAuthError(e); return; }
    console.error('[views-nugs] nugsViewRelease', e);
    $('contentInner').innerHTML = `<div class="error-state"><p>${esc(e.message)}</p></div>`;
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
  $('contentInner').innerHTML = `
    <div class="nugs-video-wrap">
      <video id="nugsVideoEl" class="nugs-video" controls></video>
      <div class="nugs-video-meta">
        <div class="section-title" style="font-size:14px">${esc(track.title)}</div>
        <div class="section-subtitle">${esc(artist.name)} · ${esc(show?.display_date ?? '')}</div>
      </div>
      <div style="display:flex;gap:8px;margin-top:4px">
        <button class="action-btn" id="btnVideoFS">&#x26F6; Fullscreen</button>
      </div>
    </div>`;
  const vid = $('nugsVideoEl');
  if (url.includes('.m3u8') && typeof Hls !== 'undefined' && Hls.isSupported()) {
    const vidHls = new Hls({ enableWorker: false });
    vidHls.loadSource(url);
    vidHls.attachMedia(vid);
    vidHls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) showToast('Video stream error'); });
  } else {
    vid.src = url;
  }
  vid.play().catch(() => {});
  $('btnVideoFS').addEventListener('click', () => vid.requestFullscreen?.());
  document.addEventListener('fullscreenchange', () => {
    const btn = $('btnVideoFS');
    if (btn) btn.textContent = document.fullscreenElement ? '✕ Exit Fullscreen' : '⛶ Fullscreen';
  }, { once: true });
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

export async function viewNugsDashboard() {
  nav.record(viewNugsDashboard, []);
  setBreadcrumb([{ label: 'Nugs' }]);

  const ci = $('contentInner');
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
      renderDashCards(body, _dashCache[tabId], tabId);
      return;
    }

    body.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;

    try {
      const cards = await tab.scrape();
      _dashCache[tabId] = cards;
      renderDashCards(body, cards, tabId);
    } catch (err) {
      console.error('[nugs-dash] scrape error', tabId, err);
      body.innerHTML = `
        <div class="empty-state" style="padding:40px;text-align:center;color:var(--text3)">
          <div style="font-size:32px;margin-bottom:12px">📡</div>
          <div style="font-size:14px;font-weight:600;color:var(--text2);margin-bottom:8px">
            Couldn't load ${tab.label.replace('●','').trim()}
          </div>
          <div style="font-size:12px">
            ${err.message?.includes('401') || err.message?.includes('403')
              ? 'Sign in to your Nugs account in Settings to access this section.'
              : esc(err.message ?? 'Unknown error')}
          </div>
          <button class="action-btn" style="margin-top:16px" id="dashRetry">Retry</button>
        </div>`;
      $('dashRetry')?.addEventListener('click', () => loadTab(tabId));
    }
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

    grid.innerHTML = cards.map((card, idx) => `
      <div class="nugs-dash-card${card.isLive ? ' is-live' : ''}" data-idx="${idx}">
        <div class="nugs-dash-card-art">
          ${card.imageUrl
            ? `<img src="${esc(card.imageUrl)}" alt="${esc(card.title)}" loading="lazy">`
            : `<div class="nugs-dash-card-init">${esc((card.artist || card.title)[0]?.toUpperCase() ?? '?')}</div>`}
          ${card.isLive ? `<div class="nugs-dash-live-badge">● LIVE</div>` : ''}
          <div class="nugs-dash-card-overlay">
            <div class="nugs-dash-card-play">▶</div>
          </div>
        </div>
        <div class="nugs-dash-card-info">
          <div class="nugs-dash-card-title">${esc(card.title)}</div>
          ${card.artist ? `<div class="nugs-dash-card-artist">${esc(card.artist)}</div>` : ''}
          ${card.date   ? `<div class="nugs-dash-card-date">${esc(card.date)}</div>` : ''}
        </div>
      </div>`).join('');

    grid.querySelectorAll('.nugs-dash-card').forEach(el => {
      el.addEventListener('click', () => {
        const card = cards[+el.dataset.idx];
        if (!card) return;
        handleDashCardClick(card);
      });
    });
  }

  async function handleDashCardClick(card) {
    // 1. Live shows → try to open as HLS stream
    if (card.isLive && card.linkUrl) {
      showToast('Loading live stream…');
      try {
        // Fetch the show page to extract the stream URL
        const r = await fetch(card.linkUrl, { credentials: 'include' });
        const html = await r.text();
        const doc  = new DOMParser().parseFromString(html, 'text/html');

        // Look for a stream URL in script tags / data attributes
        const scripts = [...doc.querySelectorAll('script')].map(s => s.textContent).join('\n');
        const m3u8Match = scripts.match(/["'](https?:\/\/[^"']*master\.m3u8[^"']*)/);
        if (m3u8Match) {
          startLiveStream(m3u8Match[1], card.title);
          return;
        }
        // If we can't find an m3u8, open the page link in a browser as fallback
        window.ipc?.openUrl(card.linkUrl);
      } catch (err) {
        console.error('[nugs-dash] live click', err);
        window.ipc?.openUrl(card.linkUrl);
      }
      return;
    }

    // 2. Recorded content → try to resolve via nugsApi if we have a containerID
    if (card.linkUrl) {
      const cid = extractContainerId(card.linkUrl);
      if (cid) {
        showToast('Loading…');
        try {
          // Build a minimal track object and resolve via the existing nugs pipeline
          const fakeTrack = {
            _nugs: true,
            _nugs_containerId: cid,
            _nugs_skuId: null,
            title: card.title,
          };
          await nugsResolveAndPlay(fakeTrack, { name: card.artist || 'Nugs' }, null);
          return;
        } catch (err) {
          handleNugsAuthError(err);
          return;
        }
      }
      // Last resort: open in browser
      window.ipc?.openUrl(card.linkUrl);
    }
  }

  // Wire tab buttons and load first tab
  $('nugsDashTabs').querySelectorAll('.nugs-dash-tab').forEach(btn =>
    btn.addEventListener('click', () => loadTab(btn.dataset.tab)));

  loadTab('live');
}

