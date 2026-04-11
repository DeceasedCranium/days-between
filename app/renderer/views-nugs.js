/* ── views-nugs.js — Nugs.net browsing views ──────────────────── */
import { $, esc, fmt, artistColor, showToast, shuffle } from './utils.js';
import { state, nav, nugsAuth, nugsArtistStore, nugsReleasesCache } from './state.js';
import { nugsApi } from './api.js';
import { injectArtistBio, lastfmArtistImage } from './lastfm.js';
import { nugsResolveAndPlay, handleNugsAuthError, setPlayerArt } from './player.js';
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

