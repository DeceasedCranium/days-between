/* ── views-user.js — personal library views ──────────────────────── */
import { $, esc, fmt, showToast, artistColor, shuffle, safeInnerHTML } from './utils.js';
import { state, nav, store, settings, tapes, nugsAuth, nugsArtistStore, nugsReleasesCache } from './state.js';
import { nugsApi } from './api.js';
import { lfm, lastfmArtistImage, getLfmKey } from './lastfm.js';
import { player, preloadNext } from './player.js';
import { applyTheme, applyAccent, applyDensity, applyGlassTheme } from './theme.js';
import { initEq, setBand, setGains, setBypass, resetBands, getGains, isBypassed, BAND_LABELS } from './eq-engine.js';
// Circular-safe imports (only used inside function bodies, never at init time)
import { setBreadcrumb, viewShow, renderArtists } from './views-core.js';

/* ── Export / Import data ────────────────────────── */
export function exportData() {
  const notes = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith('db-note-')) notes[k] = localStorage.getItem(k);
  }
  const data = {
    favorites:  store.getFavs(),
    history:    store.getHistory(),
    tapes:      tapes.getAll(),
    settings:   settings.get(),
    notes,
    exportedAt: new Date().toISOString(),
    version:    2,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `days-between-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Data exported!');
}

export function importData(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      if (data.favorites) store.saveFavs(data.favorites);
      if (data.history)   localStorage.setItem('db-history', JSON.stringify(data.history));
      if (data.tapes)     localStorage.setItem('db-tapes',   JSON.stringify(data.tapes));
      if (data.settings)  settings.set(data.settings);
      if (data.notes)     Object.entries(data.notes).forEach(([k, v]) => localStorage.setItem(k, v));
      showToast('Data imported successfully!');
      viewSettings();
    } catch { showToast('Import failed — invalid file'); }
  };
  reader.readAsText(file);
}

/* ── Saved shows ─────────────────────────────────── */
export function viewSaved() {
  nav.record(viewSaved, []);
  setBreadcrumb([{ label: 'Saved Shows' }]);
  const favs = store.getFavs();
  if (!favs.length) {
    $('contentInner').innerHTML = `<div class="welcome"><div class="welcome-logo" style="font-size:24px">♥</div><h2>No saved shows yet</h2><p>Click the heart on any show to save it here.</p></div>`;
    return;
  }
  safeInnerHTML($('contentInner'), `
    <div class="section-header">
      <div>
        <div class="section-title">Saved Shows</div>
        <div class="section-subtitle">${favs.length} show${favs.length !== 1 ? 's' : ''}</div>
      </div>
    </div>
    <div class="show-list">
      ${favs.map(f => `
        <div class="show-row" data-slug="${esc(f.artistSlug)}" data-date="${esc(f.date)}">
          <div class="show-date">${esc(f.displayDate)}</div>
          <div class="show-venue">${esc(f.artistName)}${f.venueName ? ' — ' + esc(f.venueName) : ''}</div>
          <div class="show-badges"></div>
          <button class="show-heart favorited" data-slug="${esc(f.artistSlug)}" data-date="${esc(f.date)}" title="Unsave">♥</button>
        </div>`).join('')}
    </div>`);
  $('contentInner').querySelectorAll('.show-row').forEach(row =>
    row.addEventListener('click', e => {
      if (e.target.classList.contains('show-heart')) return;
      const artist = state.artists.find(a => a.slug === row.dataset.slug) || { name: row.dataset.slug, slug: row.dataset.slug };
      state.artist = artist;
      viewShow(artist, row.dataset.date);
    }));
  $('contentInner').querySelectorAll('.show-heart').forEach(btn =>
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const fav = store.getFavs().find(f => f.artistSlug === btn.dataset.slug && f.date === btn.dataset.date);
      if (fav) {
        store.toggleFav({ display_date: fav.date, venue: { name: fav.venueName } }, { slug: fav.artistSlug, name: fav.artistName });
        viewSaved();
      }
    }));
}

/* ── History ─────────────────────────────────────── */
export function viewHistory() {
  nav.record(viewHistory, []);
  setBreadcrumb([{ label: 'Recently Played' }]);
  const hist = store.getHistory();
  if (!hist.length) {
    $('contentInner').innerHTML = `<div class="welcome"><div class="welcome-logo" style="font-size:24px">⏱</div><h2>No history yet</h2><p>Tracks you play will appear here.</p></div>`;
    return;
  }
  const groups = {};
  hist.forEach(h => {
    const day = h.playedAt
      ? new Date(h.playedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : 'Unknown';
    (groups[day] = groups[day] || []).push(h);
  });
  safeInnerHTML($('contentInner'), `
    <div class="section-header">
      <div>
        <div class="section-title">Recently Played</div>
        <div class="section-subtitle">Last ${hist.length} tracks</div>
      </div>
    </div>
    ${Object.entries(groups).map(([day, items]) => `
      <div class="history-date-group">
        <div class="history-date-label">${esc(day)}</div>
        ${items.map(h => `
          <div class="list-item" data-slug="${esc(h.artistSlug)}" data-date="${esc(h.date)}">
            ${esc(h.trackTitle)}
            <div class="list-item-sub">${esc(h.artistName)} · ${esc(h.showDate)}</div>
          </div>`).join('')}
      </div>`).join('')}`);
  $('contentInner').querySelectorAll('.list-item').forEach(el =>
    el.addEventListener('click', () => {
      if (!el.dataset.slug || !el.dataset.date) return;
      const artist = state.artists.find(a => a.slug === el.dataset.slug) || { name: el.dataset.slug, slug: el.dataset.slug };
      state.artist = artist;
      viewShow(artist, el.dataset.date);
    }));
}

/* ── Bookmarks & Attended ────────────────────────── */
export function viewBookmarks(activeTab = 'bookmarks') {
  nav.record(viewBookmarks, [activeTab]);
  setBreadcrumb([{ label: 'Bookmarks' }]);
  const bks      = store.getBookmarks();
  const attended = store.getAttended();

  function renderBookmarksTab() {
    const container = $('bkTabContent');
    if (!bks.length) {
      container.innerHTML = `<div class="welcome" style="padding-top:40px"><div style="font-size:24px">🔖</div><h2>No bookmarks yet</h2><p>Open the Now Playing view and tap 🔖 to pin a moment.</p></div>`;
      return;
    }
    safeInnerHTML(container, `
      <div class="bk-list">
        ${bks.map((b, i) => `
          <div class="bk-row" data-idx="${i}" data-slug="${esc(b.artistSlug)}" data-date="${esc(b.showDate)}">
            <div class="bk-icon">🔖</div>
            <div class="bk-info">
              <div class="bk-track">${esc(b.trackTitle)}</div>
              <div class="bk-sub">${esc(b.artistName)} · ${esc(b.showDate)} · ${fmt(b.position)}</div>
            </div>
            <button class="bk-del" data-idx="${i}" title="Remove">✕</button>
          </div>`).join('')}
      </div>`);
    container.querySelectorAll('.bk-row').forEach(row =>
      row.addEventListener('click', e => {
        if (e.target.classList.contains('bk-del')) return;
        const { slug, date } = row.dataset;
        if (!slug || !date) return;
        const artist = state.artists.find(a => a.slug === slug) || { name: slug, slug };
        viewShow(artist, date);
      }));
    container.querySelectorAll('.bk-del').forEach(btn =>
      btn.addEventListener('click', e => {
        e.stopPropagation();
        store.removeBookmark(+btn.dataset.idx);
        renderBookmarksTab();
      }));
  }

  function renderAttendedTab() {
    const container = $('bkTabContent');
    if (!attended.length) {
      container.innerHTML = `<div class="welcome" style="padding-top:40px"><div style="font-size:24px">📍</div><h2>No shows marked yet</h2><p>Open any show and tap "📍 I Was There" to log it.</p></div>`;
      return;
    }
    safeInnerHTML(container, `
      <div class="bk-list">
        ${attended.map((a, i) => `
          <div class="bk-row" data-idx="${i}" data-slug="${esc(a.artistSlug)}" data-date="${esc(a.date)}">
            <div class="bk-icon">📍</div>
            <div class="bk-info">
              <div class="bk-track">${esc(a.artistName)} — ${esc(a.date)}</div>
              <div class="bk-sub">${esc(a.venueName)}${a.venueLocation ? ' · ' + esc(a.venueLocation) : ''}</div>
            </div>
            <button class="bk-del" data-idx="${i}" title="Remove">✕</button>
          </div>`).join('')}
      </div>`);
    container.querySelectorAll('.bk-row').forEach(row =>
      row.addEventListener('click', e => {
        if (e.target.classList.contains('bk-del')) return;
        const { slug, date } = row.dataset;
        if (!slug || !date) return;
        const artist = state.artists.find(a => a.slug === slug) || { name: slug, slug };
        viewShow(artist, date);
      }));
    container.querySelectorAll('.bk-del').forEach(btn =>
      btn.addEventListener('click', e => {
        e.stopPropagation();
        store.removeAttended(+btn.dataset.idx);
        renderAttendedTab();
      }));
  }

  safeInnerHTML($('contentInner'), `
    <div class="section-header">
      <div><div class="section-title">Bookmarks</div></div>
    </div>
    <div class="bk-tabs">
      <button class="bk-tab${activeTab === 'bookmarks' ? ' active' : ''}" data-t="bookmarks">🔖 Moments <span class="bk-count">${bks.length}</span></button>
      <button class="bk-tab${activeTab === 'attended'  ? ' active' : ''}" data-t="attended">📍 I Was There <span class="bk-count">${attended.length}</span></button>
    </div>
    <div id="bkTabContent"></div>`);
  if (activeTab === 'bookmarks') renderBookmarksTab(); else renderAttendedTab();
  $('contentInner').querySelectorAll('.bk-tab').forEach(tab =>
    tab.addEventListener('click', () => viewBookmarks(tab.dataset.t)));
}

/* ── Stats helpers ───────────────────────────────── */
function buildHeatmap(hist) {
  const dayCounts = {};
  hist.forEach(h => {
    if (!h.playedAt) return;
    const key = new Date(h.playedAt).toISOString().slice(0, 10);
    dayCounts[key] = (dayCounts[key] || 0) + 1;
  });
  const today = new Date(); today.setHours(23, 59, 59, 999);
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - startDate.getDay() - 51 * 7);
  startDate.setHours(0, 0, 0, 0);

  const cells = []; const monthLabels = []; let currentMonth = -1;
  for (let week = 0; week < 52; week++) {
    const weekStart = new Date(startDate);
    weekStart.setDate(startDate.getDate() + week * 7);
    const m = weekStart.getMonth();
    if (m !== currentMonth) {
      monthLabels.push({ label: weekStart.toLocaleDateString('en-US', { month: 'short' }), weekIdx: week });
      currentMonth = m;
    }
    for (let day = 0; day < 7; day++) {
      const d = new Date(weekStart); d.setDate(weekStart.getDate() + day);
      if (d > today) {
        cells.push(`<div class="hm-cell" style="opacity:0.15"></div>`);
      } else {
        const key   = d.toISOString().slice(0, 10);
        const count = dayCounts[key] || 0;
        const lvl   = count === 0 ? 0 : count < 3 ? 1 : count < 7 ? 2 : count < 12 ? 3 : 4;
        cells.push(`<div class="hm-cell" data-lvl="${lvl}" title="${esc(key)}: ${count} track${count !== 1 ? 's' : ''}"></div>`);
      }
    }
  }
  const cellW = 17;
  const monthRow = monthLabels.map((m, i) => {
    const nextWeek = monthLabels[i + 1]?.weekIdx ?? 52;
    return `<span class="hm-month-label" style="width:${(nextWeek - m.weekIdx) * cellW}px;display:inline-block">${esc(m.label)}</span>`;
  }).join('');
  return { cells: cells.join(''), monthRow };
}

function buildTimeline(hist) {
  const now = Date.now(); const weeklyCounts = new Array(12).fill(0);
  hist.forEach(h => {
    if (!h.playedAt) return;
    const weeksAgo = Math.floor((now - new Date(h.playedAt).getTime()) / (7 * 24 * 3600 * 1000));
    if (weeksAgo < 12) weeklyCounts[11 - weeksAgo]++;
  });
  const maxW = Math.max(1, ...weeklyCounts);
  return weeklyCounts.map((count, i) => {
    const barH    = Math.max(2, Math.round((count / maxW) * 50));
    const weeksAgo = 11 - i;
    return `<div class="tl-col" title="${count} track${count !== 1 ? 's' : ''}">
      <div class="tl-bar" style="height:${barH}px"></div>
      <div class="tl-label">${weeksAgo === 0 ? 'now' : `${weeksAgo}w`}</div>
    </div>`;
  }).join('');
}

function computeStreaks(hist) {
  const days = new Set(hist.map(h => h.playedAt ? new Date(h.playedAt).toISOString().slice(0, 10) : null).filter(Boolean));
  if (!days.size) return { current: 0, longest: 0, totalDays: 0, firstPlay: null };
  const sortedDays = [...days].sort();

  let current = 0, d = new Date(); d.setHours(0, 0, 0, 0);
  while (days.has(d.toISOString().slice(0, 10))) { current++; d.setDate(d.getDate() - 1); }
  if (current === 0) {
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1); yesterday.setHours(0, 0, 0, 0);
    if (days.has(yesterday.toISOString().slice(0, 10))) {
      d = new Date(yesterday);
      while (days.has(d.toISOString().slice(0, 10))) { current++; d.setDate(d.getDate() - 1); }
    }
  }

  let longest = 1, cur = 1;
  for (let i = 1; i < sortedDays.length; i++) {
    const diff = (new Date(sortedDays[i]) - new Date(sortedDays[i - 1])) / 86400000;
    if (diff === 1) { cur++; if (cur > longest) longest = cur; } else cur = 1;
  }
  return { current, longest: Math.max(longest, current), totalDays: days.size, firstPlay: sortedDays[0] };
}

/* ── Stats view ──────────────────────────────────── */
export function viewStats() {
  nav.record(viewStats, []);
  setBreadcrumb([{ label: 'Stats' }]);
  const hist = store.getHistory();
  if (!hist.length) {
    $('contentInner').innerHTML = `<div class="welcome"><div class="welcome-logo" style="font-size:24px">📊</div><h2>No stats yet</h2><p>Play some shows to build your listening history.</p></div>`;
    return;
  }

  const totalTracks   = hist.length;
  const uniqueShows   = new Set(hist.map(h => `${h.artistSlug}::${h.date}`)).size;
  const uniqueArtists = new Set(hist.map(h => h.artistSlug).filter(Boolean)).size;
  const totalSecs     = hist.reduce((s, h) => s + (h.duration || 0), 0);
  const listeningDisp = totalSecs > 3600 ? `${(totalSecs / 3600).toFixed(1)}h`
    : totalSecs > 0 ? `${Math.round(totalSecs / 60)}m` : `${Math.round(totalTracks * 6 / 60)}h est.`;

  const artistCounts = {}, songCounts = {};
  hist.forEach(h => {
    if (h.artistName) artistCounts[h.artistName] = (artistCounts[h.artistName] || 0) + 1;
    if (h.trackTitle && h.trackTitle !== 'Unknown') songCounts[h.trackTitle] = (songCounts[h.trackTitle] || 0) + 1;
  });
  const topArtists = Object.entries(artistCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const topSongs   = Object.entries(songCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const maxA = topArtists[0]?.[1] || 1, maxS = topSongs[0]?.[1] || 1;

  const rankRows = (entries, max, withAvatars) => entries.map(([name, count], i) => {
    const color = artistColor(name);
    const avatarHtml = withAvatars
      ? `<div class="stats-rank-avatar" data-name="${esc(name)}" style="background:${color}"><span>${esc(name[0]?.toUpperCase() ?? '?')}</span></div>`
      : '';
    return `<div class="stats-rank-row">
      ${avatarHtml}
      <div class="stats-rank-num">${i + 1}</div>
      <div class="stats-rank-name">${esc(name)}</div>
      <div class="stats-bar-wrap"><div class="stats-bar-fill" style="width:${Math.round(count / max * 100)}%"></div></div>
      <div class="stats-rank-val">${count}</div>
    </div>`;
  }).join('');

  const { cells: hmCells, monthRow: hmMonthRow } = buildHeatmap(hist);
  const tlBars  = buildTimeline(hist);
  const streaks = computeStreaks(hist);

  safeInnerHTML($('contentInner'), `
    <div class="section-header"><div><div class="section-title">Listening Stats</div></div></div>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-num">${totalTracks}</div><div class="stat-label">Tracks Played</div></div>
      <div class="stat-card"><div class="stat-num">${uniqueShows}</div><div class="stat-label">Unique Shows</div></div>
      <div class="stat-card"><div class="stat-num">${uniqueArtists}</div><div class="stat-label">Artists Heard</div></div>
      <div class="stat-card"><div class="stat-num">${esc(listeningDisp)}</div><div class="stat-label">Listening Time</div></div>
    </div>
    <div class="section-header" style="margin-top:28px;margin-bottom:8px"><div><div class="section-title" style="font-size:13px">Activity — Last Year</div></div></div>
    <div class="stats-heatmap-outer">
      <div class="stats-heatmap-inner">
        <div class="stats-weekdays">
          <span class="stats-weekday"></span><span class="stats-weekday">M</span>
          <span class="stats-weekday"></span><span class="stats-weekday">W</span>
          <span class="stats-weekday"></span><span class="stats-weekday">F</span>
          <span class="stats-weekday"></span>
        </div>
        <div style="flex:1;min-width:0">
          <div class="stats-heatmap-month-row">${hmMonthRow}</div>
          <div class="stats-heatmap-scroll"><div class="stats-heatmap">${hmCells}</div></div>
        </div>
      </div>
    </div>
    <div class="section-header" style="margin-top:24px;margin-bottom:8px"><div><div class="section-title" style="font-size:13px">Last 12 Weeks</div></div></div>
    <div class="stats-timeline-wrap"><div class="stats-timeline">${tlBars}</div></div>
    <div class="section-header" style="margin-top:4px;margin-bottom:10px"><div><div class="section-title" style="font-size:13px">Streaks &amp; Milestones</div></div></div>
    <div class="stats-milestones">
      <div class="milestone-card"><div class="milestone-val">${streaks.current}</div><div class="milestone-label">Current streak (days)</div></div>
      <div class="milestone-card"><div class="milestone-val">${streaks.longest}</div><div class="milestone-label">Longest streak</div></div>
      <div class="milestone-card"><div class="milestone-val">${streaks.totalDays}</div><div class="milestone-label">Active listening days</div></div>
      ${streaks.firstPlay ? `<div class="milestone-card"><div class="milestone-val" style="font-size:15px">${esc(streaks.firstPlay)}</div><div class="milestone-label">First play date</div></div>` : ''}
    </div>
    ${topArtists.length ? `
      <div class="section-header" style="margin-top:24px;margin-bottom:4px"><div><div class="section-title" style="font-size:13px">Top Artists</div></div></div>
      <div id="statsTopArtists">${rankRows(topArtists, maxA, true)}</div>` : ''}
    ${topSongs.length ? `
      <div class="section-header" style="margin-top:24px;margin-bottom:4px"><div><div class="section-title" style="font-size:13px">Most Played Songs</div></div></div>
      ${rankRows(topSongs, maxS, false)}` : ''}`);

  if ($('statsTopArtists')) {
    for (const el of $('statsTopArtists').querySelectorAll('[data-name]')) {
      const name = el.dataset.name;
      if (!name) continue;
      lastfmArtistImage(name).then(url => {
        if (!url || el.querySelector('img')) return;
        const img = new Image(); img.alt = name;
        img.onload = () => { el.innerHTML = ''; el.appendChild(img); el.style.background = ''; };
        img.src = url;
      });
    }
  }
}

/* ── Tapes ───────────────────────────────────────── */
export function viewTapes() {
  nav.record(viewTapes, []);
  setBreadcrumb([{ label: 'Tapes' }]);
  const allTapes = tapes.getAll();
  if (!allTapes.length) {
    $('contentInner').innerHTML = `
      <div class="welcome">
        <div class="welcome-logo" style="font-size:24px">📼</div>
        <h2>No tapes yet</h2>
        <p>Create cross-show, cross-artist playlists by clicking 📼 on any track.</p>
        <button class="action-btn primary" id="btnNewTape">+ New Tape</button>
      </div>`;
    $('btnNewTape').addEventListener('click', () => {
      const name = prompt('Tape name:');
      if (!name?.trim()) return;
      tapes.create(name.trim()); viewTapes();
    });
    return;
  }
  safeInnerHTML($('contentInner'), `
    <div class="section-header">
      <div>
        <div class="section-title">Tapes</div>
        <div class="section-subtitle">${allTapes.length} tape${allTapes.length !== 1 ? 's' : ''}</div>
      </div>
      <button class="action-btn" id="btnNewTape">+ New Tape</button>
    </div>
    <div class="tape-list">
      ${allTapes.map(t => `
        <div class="tape-row" data-tid="${esc(t.id)}">
          <div class="tape-icon">📼</div>
          <div class="tape-name">${esc(t.name)}</div>
          <div class="tape-meta">${t.tracks.length} track${t.tracks.length !== 1 ? 's' : ''}</div>
          <button class="tape-del" data-tid="${esc(t.id)}" title="Delete tape">🗑</button>
        </div>`).join('')}
    </div>`);
  $('btnNewTape').addEventListener('click', () => {
    const name = prompt('Tape name:');
    if (!name?.trim()) return;
    tapes.create(name.trim()); viewTapes();
  });
  $('contentInner').querySelectorAll('.tape-row').forEach(row =>
    row.addEventListener('click', e => {
      if (e.target.classList.contains('tape-del')) return;
      const tape = tapes.getAll().find(t => t.id === row.dataset.tid);
      if (tape) viewTapeDetail(tape);
    }));
  $('contentInner').querySelectorAll('.tape-del').forEach(btn =>
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const tape = tapes.getAll().find(t => t.id === btn.dataset.tid);
      if (tape && confirm(`Delete tape "${tape.name}"?`)) { tapes.delete(btn.dataset.tid); viewTapes(); }
    }));
}

export function viewTapeDetail(tape) {
  nav.record(viewTapeDetail, [tape]);
  const fresh = tapes.getAll().find(t => t.id === tape.id);
  if (!fresh) { viewTapes(); return; }
  setBreadcrumb([
    { label: 'Tapes', onClick: () => viewTapes() },
    { label: fresh.name },
  ]);
  if (!fresh.tracks.length) {
    safeInnerHTML($('contentInner'), `
      <div class="section-header">
        <div>
          <div class="section-title">${esc(fresh.name)}</div>
          <div class="section-subtitle">Empty tape</div>
        </div>
        <button class="action-btn" disabled>▶ Play</button>
      </div>
      <div class="welcome" style="padding-top:20px">
        <p style="font-size:13px;color:var(--text3)">Add tracks from any show by clicking 📼 on a track row.</p>
      </div>`);
    return;
  }
  safeInnerHTML($('contentInner'), `
    <div class="section-header">
      <div>
        <div class="section-title">${esc(fresh.name)}</div>
        <div class="section-subtitle">${fresh.tracks.length} track${fresh.tracks.length !== 1 ? 's' : ''}</div>
      </div>
      <button class="action-btn primary" id="btnPlayTape">▶ Play Tape</button>
    </div>
    <div id="tapeTrackList">
      ${fresh.tracks.map((t, i) => `
        <div class="tape-track-row" data-uuid="${esc(t.uuid)}">
          <div class="tape-track-num">${i + 1}</div>
          <div class="tape-track-name">${esc(t.title || 'Unknown')}</div>
          <div class="tape-track-dur">${fmt(t.duration)}</div>
          <button class="tape-track-del" data-uuid="${esc(t.uuid)}" title="Remove">✕</button>
        </div>`).join('')}
    </div>`);
  $('btnPlayTape').addEventListener('click', () => { player.playTape(fresh); showToast(`Playing: ${fresh.name}`); });
  $('contentInner').querySelectorAll('.tape-track-del').forEach(btn =>
    btn.addEventListener('click', () => { tapes.removeTrack(fresh.id, btn.dataset.uuid); viewTapeDetail(fresh); }));
  $('contentInner').querySelectorAll('.tape-track-row').forEach(row =>
    row.addEventListener('click', e => {
      if (e.target.classList.contains('tape-track-del')) return;
      const idx = fresh.tracks.findIndex(t => t.uuid === row.dataset.uuid);
      if (idx < 0) return;
      state.originalQueue = [...fresh.tracks];
      state.queue    = state.shuffleOn ? shuffle([...fresh.tracks]) : [...fresh.tracks];
      state.queueIdx = idx;
      player.load(fresh.tracks[idx], state.artist, state.show);
      preloadNext();
    }));
}

/* ── Settings ────────────────────────────────────── */
export function viewSettings() {
  nav.record(viewSettings, []);
  setBreadcrumb([{ label: 'Settings' }]);
  const s = settings.get();
  const GLASS_DEFAULTS = { hue: 220, sat: 15, opacity: 0.91, blur: 12, accentHue: 33 };
  const GLASS_PRESETS = {
    midnight: { hue: 220, sat: 25, opacity: 0.88, blur: 20, accentHue: 210 },
    forest:   { hue: 140, sat: 20, opacity: 0.90, blur: 16, accentHue: 140 },
    crimson:  { hue: 0,   sat: 25, opacity: 0.88, blur: 14, accentHue: 0   },
  };
  const EQ_PRESETS = {
    flat:     { label: 'Flat',            gains: [0,  0,  0,  0,  0] },
    aud:      { label: 'AUD / Crowd',     gains: [2, -3,  2, -1, -4] },
    sbd:      { label: 'SBD Sweetener',   gains: [3,  1,  0,  2,  2] },
    acoustic: { label: 'Acoustic Clarity',gains: [-2,-1,  3,  2,  0] },
  };

  const gt = settings.getKey('glassTheme', {});
  const gtHue       = gt.hue       ?? GLASS_DEFAULTS.hue;
  const gtSat       = gt.sat       ?? GLASS_DEFAULTS.sat;
  const gtOpacity   = gt.opacity   ?? GLASS_DEFAULTS.opacity;
  const gtBlur      = gt.blur      ?? GLASS_DEFAULTS.blur;
  const gtAccentHue = gt.accentHue ?? GLASS_DEFAULTS.accentHue;
  const gtPreset    = gt.preset    ?? null;
  const savedEqPreset = settings.getKey('eqPreset', null);

  // Build nugs section content based on auth state
  const nugsSection = nugsAuth.isValid() ? (() => {
    const a = nugsAuth.get();
    const savedArtists = nugsArtistStore.get();
    return `
      <div class="settings-row">
        <div class="settings-row-label">Signed in<div class="settings-row-sub">Subscription active · ${esc(a?.plan_id ?? '')}</div></div>
        <button class="action-btn" id="btnNugsSignOut" style="color:#e05252">Sign Out</button>
      </div>
      <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:8px;padding-top:4px">
        <div class="settings-row-label">My Artists<div class="settings-row-sub">Search for artists to add to your sidebar</div></div>
        <div style="display:flex;gap:6px">
          <input type="text" id="nugsArtistSearch" class="settings-input" placeholder="Search artist name…" style="flex:1">
          <button class="action-btn primary" id="btnNugsArtistSearch">Search</button>
        </div>
        <div id="nugsArtistResults" style="display:none;flex-direction:column;gap:4px;max-height:160px;overflow-y:auto"></div>
        ${savedArtists.length ? `<div style="margin-top:4px">
          ${savedArtists.map(a => `
            <div class="settings-row" style="padding:4px 0;border:none">
              <div class="settings-row-label" style="font-size:13px">${esc(a.name)}</div>
              <button class="action-btn nugs-remove-artist" data-id="${esc(a.id)}" style="color:#e05252;font-size:11px;padding:2px 8px">Remove</button>
            </div>`).join('')}
        </div>` : ''}`;
  })() : `
    <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:8px">
      <div class="settings-row-label">Sign in to stream nugs.net concerts</div>
      <input type="email" id="nugsEmail" class="settings-input" placeholder="nugs.net email" autocomplete="off" spellcheck="false">
      <input type="password" id="nugsPassword" class="settings-input" placeholder="Password" autocomplete="off">
      <button class="action-btn primary" id="btnNugsLogin">Sign In</button>
      <div id="nugsLoginError" style="color:#e05252;font-size:12px;display:none"></div>
    </div>`;

  // Build Last.fm section content based on session state
  const lfmSection = lfm.session ? `
    <div class="settings-row">
      <div class="settings-row-label">Connected<div class="settings-row-sub">Scrobbling as ${esc(lfm.session.name)}</div></div>
      <button class="action-btn" id="btnLfmDisconnect" style="color:#e05252">Disconnect</button>
    </div>` : localStorage.getItem('lfm_pending_token') ? `
    <div class="settings-row">
      <div class="settings-row-label">Waiting for authorization<div class="settings-row-sub">Authorize Days Between on Last.fm, then click Connect</div></div>
      <button class="action-btn primary" id="btnLfmConnect">Connect</button>
    </div>` : `
    <div class="settings-row">
      <div class="settings-row-label">Scrobble your listening history<div class="settings-row-sub">Opens Last.fm in your browser to authorize</div></div>
      <button class="action-btn primary" id="btnLfmConnect">Connect Last.fm</button>
    </div>`;

  safeInnerHTML($('contentInner'), `
    <div class="section-header"><div><div class="section-title">Settings</div></div><button class="action-btn" id="btnSettingsClose" title="Close Settings" style="padding: 4px 10px; font-size: 14px;">✕</button></div>

    <div class="settings-section">
      <div class="settings-section-title">Appearance</div>
      <div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:12px">
        <div class="settings-row-label">Theme</div>
        <div class="theme-swatches" id="themeSwatches">
          ${[
            { id: 'dark',     label: 'Dark',     colors: ['#0d0f14','#12151e','#e94560'] },
            { id: 'cinema',   label: 'Cinema',   colors: ['#050608','#0a0c12','#e94560'] },
            { id: 'midnight', label: 'Midnight', colors: ['#080c18','#0d1326','#4a9eff'] },
            { id: 'dusk',     label: 'Dusk',     colors: ['#0c0814','#120e1e','#a855f7'] },
            { id: 'slate',    label: 'Slate',    colors: ['#0a0d11','#0f1318','#38bdf8'] },
            { id: 'amber',    label: 'Amber',    colors: ['#100a02','#1c1205','#f5a623'] },
            { id: 'forest',   label: 'Forest',   colors: ['#030d07','#071510','#3ddc84'] },
            { id: 'light',    label: 'Light',    colors: ['#f0f2f5','#ffffff','#e94560'] },
          ].map(t => `
            <div class="theme-swatch-wrap">
              <div class="theme-swatch ${(s.theme ?? 'dark') === t.id ? 'active' : ''}" data-theme="${t.id}"
                style="background:${t.colors[0]}">
                <div style="width:100%;height:60%;background:${t.colors[1]}"></div>
                <div style="width:40%;height:40%;background:${t.colors[2]};border-radius:50%;position:absolute;bottom:6px;right:6px"></div>
              </div>
              <div class="theme-swatch-label">${t.label}</div>
            </div>`).join('')}
        </div>
      </div>
      <div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:10px">
        <div class="settings-row-label">Accent Color
          <div class="settings-row-sub">Override the highlight color for any theme</div>
        </div>
        <div class="accent-presets" id="accentPresets">
          ${[
            { id: 'default', label: 'Default', color: null },
            { id: 'red',     label: 'Red',     color: '#e94560' },
            { id: 'orange',  label: 'Orange',  color: '#f0952c' },
            { id: 'amber',   label: 'Amber',   color: '#f5a623' },
            { id: 'green',   label: 'Green',   color: '#3ddc84' },
            { id: 'teal',    label: 'Teal',    color: '#2dd4bf' },
            { id: 'blue',    label: 'Blue',    color: '#4a9eff' },
            { id: 'indigo',  label: 'Indigo',  color: '#818cf8' },
            { id: 'purple',  label: 'Purple',  color: '#a855f7' },
            { id: 'pink',    label: 'Pink',    color: '#ec4899' },
          ].map(a => `
            <div class="accent-preset-wrap">
              <div class="accent-preset ${(s.accent ?? 'default') === a.id ? 'active' : ''}" data-accent="${a.id}"
                style="${a.color ? `background:${a.color}` : 'background:linear-gradient(135deg,#e94560,#4a9eff,#3ddc84)'}">
              </div>
              <div class="accent-preset-label">${a.label}</div>
            </div>`).join('')}
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row-label">Density
          <div class="settings-row-sub">How compact show and track lists appear</div>
        </div>
        <div class="density-toggle" id="densityToggle">
          <button class="density-btn ${(s.density ?? 'comfortable') === 'comfortable' ? 'active' : ''}" data-density="comfortable">Comfortable</button>
          <button class="density-btn ${(s.density ?? 'comfortable') === 'compact'     ? 'active' : ''}" data-density="compact">Compact</button>
        </div>
      </div>
      <div class="settings-row" style="flex-direction:column;align-items:flex-start;gap:16px">
        <div class="settings-row-label">Glass & Color
          <div class="settings-row-sub">Adjust in real time · presets are a starting point</div>
        </div>
        <div class="glass-preset-row">
          ${Object.entries(GLASS_PRESETS).map(([id, p]) => `
            <button class="glass-preset-btn ${gtPreset === id ? 'active' : ''}" data-preset="${id}">
              ${id.charAt(0).toUpperCase() + id.slice(1)}
            </button>`).join('')}
        </div>
        <div class="theme-sliders">
          <div class="theme-slider-row">
            <span class="theme-slider-label">Base Hue</span>
            <input type="range" class="theme-slider" id="slBaseHue" min="0" max="360" value="${gtHue}">
            <span class="theme-slider-val" id="valBaseHue">${gtHue}°</span>
          </div>
          <div class="theme-slider-row">
            <span class="theme-slider-label">Saturation</span>
            <input type="range" class="theme-slider" id="slBaseSat" min="0" max="100" value="${gtSat}">
            <span class="theme-slider-val" id="valBaseSat">${gtSat}%</span>
          </div>
          <div class="theme-slider-row">
            <span class="theme-slider-label">Glass Opacity</span>
            <input type="range" class="theme-slider" id="slGlassOpacity" min="50" max="100" value="${Math.round(gtOpacity * 100)}">
            <span class="theme-slider-val" id="valGlassOpacity">${Math.round(gtOpacity * 100)}%</span>
          </div>
          <div class="theme-slider-row">
            <span class="theme-slider-label">Glass Blur</span>
            <input type="range" class="theme-slider" id="slGlassBlur" min="0" max="30" value="${gtBlur}">
            <span class="theme-slider-val" id="valGlassBlur">${gtBlur}px</span>
          </div>
          <div class="theme-slider-row">
            <span class="theme-slider-label">Accent Hue</span>
            <input type="range" class="theme-slider" id="slAccentHue" min="0" max="360" value="${gtAccentHue}">
            <span class="theme-slider-val" id="valAccentHue">${gtAccentHue}°</span>
          </div>
        </div>
        <button class="action-btn" id="btnGlassReset">Reset to Default</button>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">Playback</div>
      <div class="settings-row">
        <div class="settings-row-label">Desktop Notifications
          <div class="settings-row-sub">Show a notification when a new track starts</div>
        </div>
        <label class="toggle">
          <input type="checkbox" id="toggleNotifications" ${s.notifications ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">Audio</div>
      <div class="settings-row">
        <div class="settings-row-label">5-Band Equalizer
          <div class="settings-row-sub">Boost or cut frequency bands · Ctrl+E to toggle bypass</div>
        </div>
        <label class="toggle">
          <input type="checkbox" id="toggleEq" ${isBypassed() ? '' : 'checked'}>
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="eq-preset-row">
        ${Object.entries(EQ_PRESETS).map(([id, p]) => `
          <button class="eq-preset-btn ${savedEqPreset === id ? 'active' : ''}" data-eq-preset="${id}">${p.label}</button>`).join('')}
      </div>
      <div class="eq-bands" id="eqBands">
        ${BAND_LABELS.map((label, i) => {
          const g = getGains()[i];
          const val = g > 0 ? `+${g}` : `${g}`;
          return `
            <div class="eq-band">
              <span class="eq-band-val" id="eqVal${i}">${val} dB</span>
              <input class="eq-slider" type="range" min="-12" max="12" step="0.5"
                     value="${g}" data-band="${i}" orient="vertical">
              <span class="eq-band-label">${label}</span>
            </div>`;
        }).join('')}
      </div>
      <div class="eq-reset-row">
        <button class="action-btn" id="btnEqReset">Reset</button>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">Last.fm</div>
      ${lfmSection}
    </div>

    <div class="settings-section" id="nugsSettingsSection">
      <div class="settings-section-title">Nugs.net</div>
      ${nugsSection}
    </div>

    <div class="settings-section">
      <div class="settings-section-title">Data</div>
      <div class="settings-row">
        <div class="settings-row-label">Export All Data<div class="settings-row-sub">Download your saves, history, and tapes as JSON</div></div>
        <button class="action-btn" id="btnExport">Export</button>
      </div>
      <div class="settings-row">
        <div class="settings-row-label">Import Data<div class="settings-row-sub">Restore from a previously exported JSON file</div></div>
        <button class="action-btn" id="btnImport">Import</button>
        <input type="file" id="importFile" accept=".json" style="display:none">
      </div>
      <div class="settings-row">
        <div class="settings-row-label">Clear History<div class="settings-row-sub">Remove all play history (keeps saved shows and tapes)</div></div>
        <button class="action-btn" id="btnClearHistory" style="color:#e05252">Clear</button>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">About</div>
      <div class="settings-row">
        <div class="settings-row-label">Days Between<div class="settings-row-sub">Powered by Relisten.net — 70,000+ live concerts</div></div>
      </div>
    </div>`);

  // ── Appearance controls ───────────────────────────
  $('themeSwatches').querySelectorAll('.theme-swatch').forEach(swatch =>
    swatch.addEventListener('click', () => {
      const theme = swatch.dataset.theme;
      applyTheme(theme); settings.setKey('theme', theme);
      $('themeSwatches').querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');
      showToast(`Theme: ${theme}`);
    }));
  $('accentPresets').querySelectorAll('.accent-preset').forEach(dot =>
    dot.addEventListener('click', () => {
      const id = dot.dataset.accent;
      applyAccent(id); settings.setKey('accent', id);
      $('accentPresets').querySelectorAll('.accent-preset').forEach(d => d.classList.remove('active'));
      dot.classList.add('active');
      showToast(`Accent: ${id}`);
    }));
  $('densityToggle').querySelectorAll('.density-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      const d = btn.dataset.density;
      applyDensity(d); settings.setKey('density', d);
      $('densityToggle').querySelectorAll('.density-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    }));
  // ── Glass & Color sliders ────────────────────────
  function readSliders() {
    return {
      hue:       parseInt($('slBaseHue').value, 10),
      sat:       parseInt($('slBaseSat').value, 10),
      opacity:   parseInt($('slGlassOpacity').value, 10) / 100,
      blur:      parseInt($('slGlassBlur').value, 10),
      accentHue: parseInt($('slAccentHue').value, 10),
    };
  }
  function writeSliders({ hue, sat, opacity, blur, accentHue }) {
    $('slBaseHue').value      = hue;
    $('slBaseSat').value      = sat;
    $('slGlassOpacity').value = Math.round(opacity * 100);
    $('slGlassBlur').value    = blur;
    $('slAccentHue').value    = accentHue;
    $('valBaseHue').textContent      = `${hue}°`;
    $('valBaseSat').textContent      = `${sat}%`;
    $('valGlassOpacity').textContent = `${Math.round(opacity * 100)}%`;
    $('valGlassBlur').textContent    = `${blur}px`;
    $('valAccentHue').textContent    = `${accentHue}°`;
  }
  function syncGlassTheme(preset = null) {
    const vals = readSliders();
    applyGlassTheme(vals);
    settings.setKey('glassTheme', { ...vals, preset });
    // Update preset button active state
    document.querySelectorAll('.glass-preset-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.preset === preset));
  }
  ['slBaseHue', 'slBaseSat', 'slGlassOpacity', 'slGlassBlur', 'slAccentHue'].forEach(id =>
    $(id).addEventListener('input', () => syncGlassTheme(null)));

  // ── Glass preset buttons ─────────────────────────
  document.querySelectorAll('.glass-preset-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      const p = GLASS_PRESETS[btn.dataset.preset];
      if (!p) return;
      writeSliders(p);
      syncGlassTheme(btn.dataset.preset);
      showToast(`Theme: ${btn.dataset.preset}`);
    }));

  // ── Reset to Default ─────────────────────────────
  $('btnGlassReset').addEventListener('click', () => {
    writeSliders(GLASS_DEFAULTS);
    syncGlassTheme(null);
    showToast('Theme reset to default');
  });

  $('toggleNotifications').addEventListener('change', e => settings.setKey('notifications', e.target.checked));

  // ── EQ controls ──────────────────────────────────
  $('toggleEq').addEventListener('change', e => {
    setBypass(!e.target.checked).catch(err => console.error('[settings] setBypass:', err));
  });
  $('eqBands').querySelectorAll('.eq-slider').forEach(slider => {
    slider.addEventListener('input', () => {
      const i   = parseInt(slider.dataset.band, 10);
      const val = parseFloat(slider.value);
      setBand(i, val);
      const valEl = $(`eqVal${i}`);
      if (valEl) valEl.textContent = `${val > 0 ? '+' : ''}${val} dB`;
      // Lazy-init EQ on first slider interaction (user gesture)
      if (!isBypassed()) initEq().catch(err => console.error('[settings] initEq:', err));
    });
  });
  $('btnEqReset').addEventListener('click', () => {
    resetBands();
    settings.setKey('eqPreset', null);
    document.querySelectorAll('.eq-preset-btn').forEach(b => b.classList.remove('active'));
    $('eqBands').querySelectorAll('.eq-slider').forEach((slider, i) => {
      slider.value = 0;
      const valEl = $(`eqVal${i}`);
      if (valEl) valEl.textContent = '0 dB';
    });
  });

  // ── EQ preset buttons ────────────────────────────
  function applyEqPreset(gains) {
    const startGains = getGains();
    const startTime  = performance.now();
    const duration   = 300;
    setGains(gains); // audio ramps immediately via _rampToGains
    function step(now) {
      const t    = Math.min((now - startTime) / duration, 1);
      const ease = t < 0.5 ? 2*t*t : -1+(4-2*t)*t;
      $('eqBands').querySelectorAll('.eq-slider').forEach((slider, i) => {
        const val = startGains[i] + (gains[i] - startGains[i]) * ease;
        slider.value = val;
        const valEl = $(`eqVal${i}`);
        if (valEl) valEl.textContent = `${val >= 0 ? '+' : ''}${val.toFixed(1)} dB`;
      });
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  document.querySelectorAll('.eq-preset-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      const id = btn.dataset.eqPreset;
      const preset = EQ_PRESETS[id];
      if (!preset) return;
      applyEqPreset(preset.gains);
      settings.setKey('eqPreset', id);
      document.querySelectorAll('.eq-preset-btn').forEach(b => b.classList.toggle('active', b === btn));
      showToast(`EQ: ${preset.label}`);
      if (!isBypassed()) initEq().catch(err => console.error('[settings] initEq:', err));
    }));

  // ── Last.fm controls ─────────────────────────────
  if ($('btnLfmDisconnect')) {
    $('btnLfmDisconnect').addEventListener('click', () => {
      lfm.session = null; lfm.save();
      localStorage.removeItem('lfm_pending_token');
      showToast('Last.fm disconnected'); viewSettings();
    });
  }
  if ($('btnLfmConnect')) {
    $('btnLfmConnect').addEventListener('click', async () => {
      const pending = localStorage.getItem('lfm_pending_token');
      if (pending) {
        const session = await window.ipc?.lfmGetSession(pending);
        if (session?.key) {
          lfm.session = session; lfm.save();
          localStorage.removeItem('lfm_pending_token');
          showToast(`Last.fm connected as ${session.name}`); viewSettings();
        } else {
          showToast('Not authorized yet — please approve on Last.fm first');
        }
      } else {
        const token = await window.ipc?.lfmGetToken();
        if (!token) { showToast('Last.fm: could not get token'); return; }
        localStorage.setItem('lfm_pending_token', token);
        window.ipc?.openUrl(`https://www.last.fm/api/auth/?api_key=${getLfmKey()}&token=${token}`);
        viewSettings();
      }
    });
  }

  // ── Nugs controls ────────────────────────────────
  if (nugsAuth.isValid()) {
    $('btnNugsSignOut').addEventListener('click', () => {
      nugsAuth.clear(); showToast('Signed out of nugs.net');
      renderArtists(state.filteredArtists); viewSettings();
    });
    const searchBtn   = $('btnNugsArtistSearch');
    const searchInput = $('nugsArtistSearch');
    const resultsEl   = $('nugsArtistResults');
    const doSearch = async () => {
      const q = searchInput.value.trim(); if (!q) return;
      searchBtn.disabled = true; searchBtn.textContent = '…';
      resultsEl.style.display = 'flex';
      resultsEl.innerHTML = '<div style="font-size:12px;color:var(--text3);padding:4px">Loading artists…</div>';
      try {
        await nugsApi.allArtists();
        const results = nugsApi.searchArtists(q);
        if (!results.length) {
          resultsEl.innerHTML = '<div style="font-size:12px;color:var(--text3);padding:4px">No artists found. Try a different name.</div>';
        } else {
          safeInnerHTML(resultsEl, results.map(a =>
            `<div class="settings-row" style="padding:4px 0;border:none;gap:8px">
               <div class="settings-row-label" style="font-size:13px">${esc(a.name)} <span style="color:var(--text3);font-size:11px">ID ${esc(a.id)}</span></div>
               <button class="action-btn nugs-add-artist" data-id="${esc(a.id)}" data-name="${esc(a.name)}" style="font-size:11px;padding:2px 8px">+ Add</button>
             </div>`).join(''));
          resultsEl.querySelectorAll('.nugs-add-artist').forEach(btn =>
            btn.addEventListener('click', () => {
              const added = nugsArtistStore.add(btn.dataset.id, btn.dataset.name);
              if (added) { showToast(`Added ${btn.dataset.name}`); renderArtists(state.filteredArtists); viewSettings(); }
              else showToast('Artist already in your list');
            }));
        }
      } catch (e) {
        resultsEl.innerHTML = `<div style="font-size:12px;color:#e05252;padding:4px">${esc(e.message)}</div>`;
      }
      searchBtn.disabled = false; searchBtn.textContent = 'Search';
    };
    searchBtn.addEventListener('click', doSearch);
    searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
    document.querySelectorAll('.nugs-remove-artist').forEach(btn =>
      btn.addEventListener('click', () => {
        nugsArtistStore.remove(btn.dataset.id);
        delete nugsReleasesCache[btn.dataset.id];
        renderArtists(state.filteredArtists); viewSettings();
      }));
  } else {
    const loginBtn = $('btnNugsLogin'), errEl = $('nugsLoginError');
    loginBtn.addEventListener('click', async () => {
      const email    = $('nugsEmail').value.trim();
      const password = $('nugsPassword').value;
      if (!email || !password) return;
      loginBtn.disabled = true; loginBtn.textContent = 'Signing in…'; errEl.style.display = 'none';
      try {
        await nugsApi.login(email, password);
        showToast('Signed in to nugs.net!'); renderArtists(state.filteredArtists); viewSettings();
      } catch (e) {
        const msg = e.message === 'nugs:login_failed'    ? 'Invalid email or password.'
                  : e.message === 'nugs:no_subscription' ? 'No active subscription found.'
                  : 'Sign-in failed. Check your connection.';
        errEl.textContent = msg; errEl.style.display = 'block';
        loginBtn.disabled = false; loginBtn.textContent = 'Sign In';
      }
    });
    $('nugsPassword').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnNugsLogin').click(); });
  }

  // ── Data controls ─────────────────────────────────
  $('btnExport').addEventListener('click', exportData);
  $('btnImport').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', e => {
    const file = e.target.files[0]; if (!file) return;
    importData(file); e.target.value = '';
  });
  $('btnClearHistory').addEventListener('click', () => {
    if (confirm('Clear all play history?')) { localStorage.removeItem('db-history'); showToast('History cleared'); }
  });

  // ── Settings close button ─────────────────────────
  if ($('btnSettingsClose')) {
    $('btnSettingsClose').addEventListener('click', () => {
      nav.back();
    });
  }
}
