/* ── views-search.js — Advanced Search (v2.2) ─────────────────────────────
 *
 * JerryBase-style multi-criteria search across an artist's setlist.fm
 * cached setlists. Backed by the pure `searchSetlists` helper in
 * shared/helpers.js (which has its own unit-test coverage); this module
 * is the impure shell — form rendering, cache check + scan trigger,
 * results rendering, navigation wiring.
 *
 * UX shape
 * ────────
 *   1. User opens the view from the sidebar.
 *   2. Picks an artist. If we've cached setlist.fm setlists for them,
 *      the form is immediately searchable. If not, we trigger a scan
 *      (same scan used for song-stats play counts) and gate the Search
 *      button on its completion, showing live progress.
 *   3. User adds song-criteria rows (one or more), date/venue/tour
 *      filters, hits Search.
 *   4. Results render below the form. Click any result row to open the
 *      Relisten show page like everything else.
 *
 * Form state is held in `_formState` so the UI survives navigating away
 * and back within the same session. It's intentionally NOT persisted to
 * IndexedDB — saved-search slots are a v2.3 enhancement, not v2.2.
 * ────────────────────────────────────────────────────────────────────── */

import { $, esc, safeInnerHTML, showToast } from './utils.js';
import { state, nav, nugsAuth } from './state.js';
import { setBreadcrumb, showError } from './views-core.js';
import { api, nugsApi } from './api.js';
import { searchSetlists, nugsIsoDate } from '../shared/helpers.js';
import {
  getArtistSongCounts,
  getArtistSetlists,
  isAvailable as setlistFmAvailable,
} from './setlistfm.js';

// In-memory cache of Nugs catalogs we've fetched during this session. Keyed
// by Nugs artistID. First Nugs-button click per artist pays the catalog-
// fetch cost (10-30s for big catalogs like Dead's 1000+ containers); every
// subsequent click on any result from that artist is instant.
const _nugsCatalogCache = new Map();

const POSITION_OPTIONS = [
  { v: 'anywhere',       label: 'Anywhere in show' },
  { v: 'show-opener',    label: 'Show opener' },
  { v: 'show-closer',    label: 'Show closer (last song before encore)' },
  { v: 'set-1-opener',   label: 'Set 1 opener' },
  { v: 'set-1-closer',   label: 'Set 1 closer' },
  { v: 'set-1-anywhere', label: 'Anywhere in Set 1' },
  { v: 'set-2-opener',   label: 'Set 2 opener' },
  { v: 'set-2-closer',   label: 'Set 2 closer' },
  { v: 'set-2-anywhere', label: 'Anywhere in Set 2' },
  { v: 'set-3-opener',   label: 'Set 3 opener' },
  { v: 'set-3-closer',   label: 'Set 3 closer' },
  { v: 'set-3-anywhere', label: 'Anywhere in Set 3' },
  { v: 'encore-opener',  label: 'Encore opener' },
  { v: 'encore-closer',  label: 'Encore closer' },
  { v: 'encore',         label: 'Anywhere in encore' },
];

// Form state — module-scoped so navigating away + back preserves the
// user's in-progress query. Reset by clicking "Clear" or relaunching.
const _formState = {
  artistSlug: '',
  dateFrom:   '',
  dateTo:     '',
  month:      '',
  day:        '',
  dayOfWeek:  '',
  venueName:  '',
  city:       '',
  stateCode:  '',
  tourName:   '',
  songRows: [
    { name: '', position: 'anywhere', segueInto: '', followedBy: '' },
  ],
};

// Per-artist cache state — tracks whether we've kicked off a scan and
// whether setlists are available locally. Keyed by artist slug.
const _scanStatus = new Map();   // slug → 'idle' | 'scanning' | 'ready' | 'unavailable'

let _lastResults          = [];     // most recent search results (for re-render)
let _lastResultsArtistSlug = null;  // which artist those results belong to
let _lastResultsCriteria   = null;  // for display ("3 matches — Grateful Dead")

// Per-artist suggestion lists, derived from cached setlists once after a
// scan completes. Powers the autocomplete on song/venue/city/tour inputs.
const _suggestionsCache = new Map();  // slug → { songs, venues, cities, tours }

function buildSuggestions(slug, setlists) {
  const songs = new Set();
  const venues = new Set();
  const cities = new Set();
  const tours  = new Set();
  for (const sl of setlists) {
    if (sl.venue) venues.add(sl.venue);
    if (sl.city)  cities.add(sl.city);
    if (sl.tour)  tours.add(sl.tour);
    for (const set of sl.sets) {
      for (const song of set.songs) {
        if (song.name) songs.add(song.name);
      }
    }
  }
  const sorted = (set) => [...set].sort((a, b) => a.localeCompare(b));
  _suggestionsCache.set(slug, {
    songs:  sorted(songs),
    venues: sorted(venues),
    cities: sorted(cities),
    tours:  sorted(tours),
  });
}

function currentSuggestions() {
  return _suggestionsCache.get(_formState.artistSlug) ?? { songs: [], venues: [], cities: [], tours: [] };
}

/* ── Entry point ────────────────────────────────────────────────────── */

export async function viewAdvancedSearch() {
  nav.record(viewAdvancedSearch, []);
  setBreadcrumb([{ label: '🔎 Advanced Search' }]);

  if (!setlistFmAvailable()) {
    showError('setlist.fm is not configured — Advanced Search needs the setlist.fm API key. Add SETLIST_FM_KEY to config.js to enable.');
    return;
  }

  renderShell();
  wireForm();

  // Re-entry behaviour: if we already had an artist picked, re-run the
  // scan-status check (almost always a no-op cache hit) and re-render
  // any previous search results so the user keeps their working set
  // when navigating back from a show page. If the picker is empty but
  // an artist is selected globally (e.g. from a previous browse), use
  // that as the default.
  if (_formState.artistSlug) {
    await onArtistChange();
    if (
      _lastResults.length &&
      _lastResultsArtistSlug === _formState.artistSlug
    ) {
      const artist = state.artists.find(a => a.slug === _formState.artistSlug);
      if (artist) renderResults(artist, _lastResults, _lastResultsCriteria);
    }
  } else if (state.artist?.slug) {
    _formState.artistSlug = state.artist.slug;
    onArtistChange();
  }
}

/* ── Render: full shell (form + results area) ───────────────────────── */

function renderShell() {
  const artists = (state.artists ?? [])
    .filter(a => a?.slug && a?.name)
    .sort((a, b) => a.name.localeCompare(b.name));

  safeInnerHTML($('contentInner'), `
    <div class="adv-search">
      <div class="adv-search-header">
        <h2>🔎 Advanced Search</h2>
        <p class="adv-search-sub">
          Find shows by song position, segues, venue, date, and tour. Searches
          run against setlist.fm community data cached locally per artist.
        </p>
      </div>

      <div class="adv-search-form">

        <div class="adv-row">
          <label class="adv-label">Artist</label>
          <input id="advArtist" class="adv-input adv-input-wide"
                 type="text" autocomplete="off" spellcheck="false"
                 placeholder="Type to search artists (e.g. Grateful Dead, Phish, Goose)…"
                 value="${esc(state.artists.find(a => a.slug === _formState.artistSlug)?.name ?? '')}">
        </div>

        <div id="advScanStatus" class="adv-scan-status" style="display:none"></div>

        <fieldset class="adv-fieldset" id="advFiltersFieldset" disabled>
          <legend>Date</legend>
          <div class="adv-row adv-row-inline">
            <div>
              <label class="adv-label-sm">From</label>
              <input id="advDateFrom" type="date" class="adv-input" value="${esc(_formState.dateFrom)}">
            </div>
            <div>
              <label class="adv-label-sm">To</label>
              <input id="advDateTo" type="date" class="adv-input" value="${esc(_formState.dateTo)}">
            </div>
            <div class="adv-or">— or —</div>
            <div>
              <label class="adv-label-sm">Month</label>
              <select id="advMonth" class="adv-input">
                <option value="">Any</option>
                ${['January','February','March','April','May','June','July','August','September','October','November','December']
                  .map((n, i) => `<option value="${i+1}" ${String(i+1) === _formState.month ? 'selected' : ''}>${n}</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="adv-label-sm">Day</label>
              <input id="advDay" type="number" min="1" max="31" class="adv-input adv-input-sm" value="${esc(_formState.day)}" placeholder="Any">
            </div>
            <div>
              <label class="adv-label-sm">Day of week</label>
              <select id="advDow" class="adv-input">
                <option value="">Any</option>
                ${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
                  .map((n, i) => `<option value="${i}" ${String(i) === _formState.dayOfWeek ? 'selected' : ''}>${n}</option>`).join('')}
              </select>
            </div>
          </div>
        </fieldset>

        <fieldset class="adv-fieldset" id="advVenueFieldset" disabled>
          <legend>Venue / Tour</legend>
          <div class="adv-row adv-row-inline">
            <div class="adv-grow">
              <label class="adv-label-sm">Venue contains</label>
              <input id="advVenue" type="text" class="adv-input" value="${esc(_formState.venueName)}" placeholder="e.g. Barton Hall">
            </div>
            <div class="adv-grow">
              <label class="adv-label-sm">City contains</label>
              <input id="advCity" type="text" class="adv-input" value="${esc(_formState.city)}" placeholder="e.g. Ithaca">
            </div>
            <div>
              <label class="adv-label-sm">State (2-letter)</label>
              <input id="advState" type="text" class="adv-input adv-input-sm" maxlength="2" value="${esc(_formState.stateCode)}" placeholder="NY">
            </div>
            <div class="adv-grow">
              <label class="adv-label-sm">Tour contains</label>
              <input id="advTour" type="text" class="adv-input" value="${esc(_formState.tourName)}" placeholder="e.g. Spring 1977">
            </div>
          </div>
        </fieldset>

        <fieldset class="adv-fieldset" id="advSongsFieldset" disabled>
          <legend>Songs <span class="adv-and-note">(all rows must match)</span></legend>
          <div id="advSongRows">${renderSongRows()}</div>
          <button type="button" class="adv-btn-secondary" id="advAddRow">+ Add song criterion</button>
        </fieldset>

        <div class="adv-actions">
          <button type="button" class="action-btn primary" id="advSearchBtn" disabled>Search</button>
          <button type="button" class="action-btn" id="advClearBtn">Clear</button>
        </div>
      </div>

      <div id="advResults" class="adv-results"></div>
    </div>`);
}

/* ── Render: song-criteria rows ─────────────────────────────────────── */

function renderSongRows() {
  return _formState.songRows.map((row, i) => `
    <div class="adv-song-row" data-row-idx="${i}">
      <div class="adv-song-row-grid">
        <input class="adv-input adv-song-name"    data-key="name"       value="${esc(row.name)}"       placeholder="Song name (e.g. Jack Straw)">
        <select class="adv-input adv-song-pos"     data-key="position">
          ${POSITION_OPTIONS.map(o => `<option value="${o.v}" ${o.v === row.position ? 'selected' : ''}>${o.label}</option>`).join('')}
        </select>
        <button type="button" class="adv-row-remove" data-action="remove" ${_formState.songRows.length === 1 ? 'disabled' : ''} title="Remove row">×</button>
      </div>
      <div class="adv-song-row-segue">
        <label class="adv-segue-label">
          <input type="radio" name="seg-${i}" data-key="segueMode" value="none" ${(!row.segueInto && !row.followedBy) ? 'checked' : ''}>
          (no follow-on)
        </label>
        <label class="adv-segue-label">
          <input type="radio" name="seg-${i}" data-key="segueMode" value="followedBy" ${row.followedBy ? 'checked' : ''}>
          followed by
        </label>
        <label class="adv-segue-label">
          <input type="radio" name="seg-${i}" data-key="segueMode" value="segueInto" ${row.segueInto ? 'checked' : ''}>
          segues into
        </label>
        <input class="adv-input adv-song-partner" data-key="partner" value="${esc(row.segueInto || row.followedBy)}" placeholder="next song">
      </div>
    </div>
  `).join('');
}

/* ── Wiring ─────────────────────────────────────────────────────────── */

function wireForm() {
  // Artist picker: typeahead combobox. Free-typed text that doesn't
  // resolve to a known slug is treated as "no artist selected" — the
  // form remains disabled until the user picks a real entry from the
  // popover (or starts a fresh scan via a matched name).
  const artistInput = $('advArtist');
  setupAutocomplete(
    artistInput,
    () => (state.artists ?? [])
      .filter(a => a?.slug && a?.name)
      .map(a => ({ value: a.name, label: a.name, slug: a.slug }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    {
      onPick: (opt) => {
        if (opt.slug !== _formState.artistSlug) clearStaleResults();
        _formState.artistSlug = opt.slug;
        onArtistChange();
      },
    },
  );
  // Detect typed text matching an exact artist name (case-insensitive).
  // Lets the user paste a name + Tab without opening the popover.
  artistInput.addEventListener('change', () => {
    const v = artistInput.value.trim().toLowerCase();
    const exact = (state.artists ?? []).find(a => a.name?.toLowerCase() === v);
    if (exact) {
      if (exact.slug !== _formState.artistSlug) clearStaleResults();
      _formState.artistSlug = exact.slug;
      onArtistChange();
    } else if (!v) {
      clearStaleResults();
      _formState.artistSlug = '';
      onArtistChange();
    }
  });

  // Top-level filters — collect on change
  bindInput('advDateFrom',  'dateFrom');
  bindInput('advDateTo',    'dateTo');
  bindInput('advMonth',     'month');
  bindInput('advDay',       'day');
  bindInput('advDow',       'dayOfWeek');
  bindInput('advVenue',     'venueName');
  bindInput('advCity',      'city');
  bindInput('advState',     'stateCode');
  bindInput('advTour',      'tourName');

  // Autocomplete on the contextual text fields — suggestion lists come
  // from the cached setlists for whichever artist is currently picked.
  setupAutocomplete($('advVenue'), () => currentSuggestions().venues);
  setupAutocomplete($('advCity'),  () => currentSuggestions().cities);
  setupAutocomplete($('advTour'),  () => currentSuggestions().tours);
  wireSongRowAutocomplete();

  // Song-row events (delegated, so add/remove keeps working)
  $('advSongRows').addEventListener('input',  onSongRowEvent);
  $('advSongRows').addEventListener('change', onSongRowEvent);
  $('advSongRows').addEventListener('click', e => {
    if (e.target.dataset.action === 'remove') {
      const idx = parseInt(e.target.closest('.adv-song-row')?.dataset.rowIdx, 10);
      if (Number.isFinite(idx) && _formState.songRows.length > 1) {
        _formState.songRows.splice(idx, 1);
        rerenderSongRows();
      }
    }
  });

  $('advAddRow').addEventListener('click', () => {
    _formState.songRows.push({ name: '', position: 'anywhere', segueInto: '', followedBy: '' });
    rerenderSongRows();
  });

  $('advSearchBtn').addEventListener('click', runSearch);
  $('advClearBtn').addEventListener('click', clearForm);
}

function bindInput(id, key) {
  const el = $(id);
  if (!el) return;
  el.addEventListener('input',  e => { _formState[key] = e.target.value; });
  el.addEventListener('change', e => { _formState[key] = e.target.value; });
}

function onSongRowEvent(e) {
  const rowEl = e.target.closest('.adv-song-row');
  if (!rowEl) return;
  const idx = parseInt(rowEl.dataset.rowIdx, 10);
  const row = _formState.songRows[idx];
  if (!row) return;
  const key = e.target.dataset.key;
  if (key === 'name')     row.name = e.target.value;
  if (key === 'position') row.position = e.target.value;
  if (key === 'partner') {
    // Apply to whichever segue mode is active
    if (row.segueInto) row.segueInto = e.target.value;
    else if (row.followedBy) row.followedBy = e.target.value;
    else row.followedBy = e.target.value; // default if none selected
  }
  if (key === 'segueMode') {
    const partnerVal = rowEl.querySelector('.adv-song-partner')?.value ?? '';
    if (e.target.value === 'none')         { row.segueInto = ''; row.followedBy = ''; }
    if (e.target.value === 'followedBy')   { row.segueInto = ''; row.followedBy = partnerVal; }
    if (e.target.value === 'segueInto')    { row.segueInto = partnerVal; row.followedBy = ''; }
  }
}

function rerenderSongRows() {
  safeInnerHTML($('advSongRows'), renderSongRows());
  wireSongRowAutocomplete();
}

// Wire autocomplete on each song-row name + partner input. Called on
// initial form render AND after every add/remove of a row, since
// rerendering replaces the DOM nodes (and therefore their listeners).
function wireSongRowAutocomplete() {
  const songsList = () => currentSuggestions().songs;
  document.querySelectorAll('#advSongRows .adv-song-name').forEach(input => {
    setupAutocomplete(input, songsList);
  });
  document.querySelectorAll('#advSongRows .adv-song-partner').forEach(input => {
    setupAutocomplete(input, songsList);
  });
}

/* ── Artist change → scan check ─────────────────────────────────────── */

async function onArtistChange() {
  const slug = _formState.artistSlug;
  const filtersEl = $('advFiltersFieldset');
  const venueEl   = $('advVenueFieldset');
  const songsEl   = $('advSongsFieldset');
  const searchBtn = $('advSearchBtn');
  const statusEl  = $('advScanStatus');

  if (!slug) {
    [filtersEl, venueEl, songsEl].forEach(f => f && (f.disabled = true));
    searchBtn.disabled = true;
    statusEl.style.display = 'none';
    return;
  }

  // Supersede guard. The user can pick a different artist while this
  // call is still mid-scan; every async boundary below has to bail if
  // _formState.artistSlug has moved on, otherwise the slow scan's
  // progress / completion overwrites the new artist's status row and
  // re-enables its form prematurely. Capture the slug we started with
  // and check it at each await point.
  const mySlug = slug;
  const stillCurrent = () => _formState.artistSlug === mySlug;

  const artist = state.artists.find(a => a.slug === slug);
  if (!artist) return;

  // Check cache first
  const cached = await getArtistSetlists(artist).catch(() => null);
  if (!stillCurrent()) return;
  if (cached && cached.length) {
    // Ready — enable everything and build the autocomplete suggestion lists.
    _scanStatus.set(slug, 'ready');
    if (!_suggestionsCache.has(slug)) buildSuggestions(slug, cached);
    [filtersEl, venueEl, songsEl].forEach(f => f && (f.disabled = false));
    searchBtn.disabled = false;
    statusEl.innerHTML = `<span class="adv-scan-ready">✓ ${cached.length.toLocaleString()} setlists cached for ${esc(artist.name)} — ready to search</span>`;
    statusEl.style.display = '';
    return;
  }

  // No cached setlists — trigger a scan
  _scanStatus.set(slug, 'scanning');
  [filtersEl, venueEl, songsEl].forEach(f => f && (f.disabled = true));
  searchBtn.disabled = true;
  statusEl.innerHTML = `<span class="adv-scan-progress">Scanning setlist.fm for ${esc(artist.name)}… <span id="advScanCount">0</span></span>`;
  statusEl.style.display = '';

  try {
    let lastUpdate = 0;
    await getArtistSongCounts(artist, {
      onProgress: (scanned, total) => {
        // Skip progress updates whose target row has been replaced by a
        // later artist pick. Without this guard, an old scan keeps
        // updating the NEW artist's status row.
        if (!stillCurrent()) return;
        const now = Date.now();
        if (now - lastUpdate < 150) return;
        lastUpdate = now;
        const countEl = $('advScanCount');
        if (countEl) countEl.textContent = `${scanned}/${total}`;
      },
    });
    if (!stillCurrent()) return;
    // Scan complete — re-check cache
    const freshCache = await getArtistSetlists(artist);
    if (!stillCurrent()) return;
    if (!freshCache || !freshCache.length) {
      _scanStatus.set(slug, 'unavailable');
      statusEl.innerHTML = `<span class="adv-scan-unavailable">No setlist.fm data available for ${esc(artist.name)}.</span>`;
      return;
    }
    _scanStatus.set(slug, 'ready');
    buildSuggestions(slug, freshCache);
    [filtersEl, venueEl, songsEl].forEach(f => f && (f.disabled = false));
    searchBtn.disabled = false;
    statusEl.innerHTML = `<span class="adv-scan-ready">✓ ${freshCache.length.toLocaleString()} setlists cached for ${esc(artist.name)} — ready to search</span>`;
  } catch (err) {
    if (!stillCurrent()) return;
    _scanStatus.set(slug, 'unavailable');
    statusEl.innerHTML = `<span class="adv-scan-unavailable">Couldn't reach setlist.fm — try again later. (${esc(err.message || 'unknown error')})</span>`;
  }
}

/* ── Run search ─────────────────────────────────────────────────────── */

async function runSearch() {
  const slug = _formState.artistSlug;
  if (!slug) return;
  const artist = state.artists.find(a => a.slug === slug);
  if (!artist) return;

  const setlists = await getArtistSetlists(artist).catch(() => null);
  if (!setlists) {
    showToast('Setlist data not loaded — pick the artist first and wait for the scan.');
    return;
  }

  const criteria = buildCriteria();
  const results  = searchSetlists(setlists, criteria);
  _lastResults           = results;
  _lastResultsArtistSlug = slug;
  _lastResultsCriteria   = criteria;
  renderResults(artist, results, criteria);
}

function buildCriteria() {
  const c = {};
  if (_formState.dateFrom) c.dateFrom = _formState.dateFrom;
  if (_formState.dateTo)   c.dateTo   = _formState.dateTo;
  if (_formState.month)    c.month    = parseInt(_formState.month, 10);
  if (_formState.day)      c.day      = parseInt(_formState.day,   10);
  if (_formState.dayOfWeek !== '') c.dayOfWeek = parseInt(_formState.dayOfWeek, 10);
  if (_formState.venueName) c.venueName = _formState.venueName;
  if (_formState.city)      c.city      = _formState.city;
  if (_formState.stateCode) c.state     = _formState.stateCode;
  if (_formState.tourName)  c.tourName  = _formState.tourName;

  const songs = _formState.songRows
    .filter(r => r.name.trim())
    .map(r => {
      const row = { name: r.name.trim(), position: r.position || 'anywhere' };
      if (r.segueInto)  row.segueInto  = r.segueInto.trim();
      if (r.followedBy) row.followedBy = r.followedBy.trim();
      return row;
    });
  if (songs.length) c.songs = songs;
  return c;
}

/* ── Render: results list ───────────────────────────────────────────── */

function renderResults(artist, results, criteria) {
  const wrap = $('advResults');
  if (!wrap) return;

  if (!results.length) {
    safeInnerHTML(wrap, `
      <div class="adv-results-empty">
        <div class="adv-results-empty-icon">🔍</div>
        <p>No shows matched. Try loosening your criteria.</p>
      </div>`);
    return;
  }

  // Sort by date asc by default
  const sorted = [...results].sort((a, b) => a.date.localeCompare(b.date));

  safeInnerHTML(wrap, `
    <div class="adv-results-header">
      <strong>${results.length}</strong> show${results.length === 1 ? '' : 's'} matched
      <span class="adv-results-sub">— ${esc(artist.name)}, based on setlist.fm community data</span>
    </div>
    <div class="adv-results-list">
      ${sorted.map(sl => `
        <div class="adv-result-row" data-date="${esc(sl.date)}" data-slug="${esc(artist.slug)}">
          <div class="adv-result-date">${esc(sl.date)}</div>
          <div class="adv-result-meta">
            <div class="adv-result-venue">${esc(sl.venue ?? '—')}${sl.city ? ', ' + esc(sl.city) : ''}${sl.state ? ', ' + esc(sl.state) : ''}</div>
            ${sl.tour ? `<div class="adv-result-tour">Tour: ${esc(sl.tour)}</div>` : ''}
          </div>
          <div class="adv-result-actions">
            <button type="button" class="adv-result-btn adv-result-btn-relisten" data-action="relisten" title="Open on Relisten">▶ Relisten</button>
            <button type="button" class="adv-result-btn adv-result-btn-nugs"     data-action="nugs"     title="Try this date on Nugs">🎤 Nugs</button>
          </div>
        </div>`).join('')}
    </div>`);

  // Action dispatch. Two distinct buttons per row — Relisten (the canonical
  // open path) and Nugs (subscription-side lookup). Both do their own
  // availability check before navigating so a missing-on-Relisten or
  // missing-on-Nugs result doesn't blow away the user's search list.
  wrap.querySelectorAll('.adv-result-row').forEach(row => {
    const relistenBtn = row.querySelector('[data-action="relisten"]');
    const nugsBtn     = row.querySelector('[data-action="nugs"]');
    relistenBtn?.addEventListener('click', () => openOnRelisten(row));
    nugsBtn?.addEventListener('click',     () => openOnNugs(row, artist));
  });
}

async function openOnRelisten(row) {
  const date = row.dataset.date;
  const slug = row.dataset.slug;
  const a    = state.artists.find(x => x.slug === slug) ?? { slug, name: slug };
  const btn  = row.querySelector('[data-action="relisten"]');
  if (btn) btn.disabled = true;
  row.classList.add('adv-result-row-loading');
  try {
    await api.show(slug, date);
    const m = await import('./views-core.js');
    state.artist = a;
    m.viewShow(a, date);
  } catch (err) {
    const msg = String(err?.message ?? '');
    if (/\b404\b/.test(msg)) {
      showToast(`No Relisten recording for ${date} — setlist.fm has the setlist but there's no audio on file.`);
    } else {
      showToast(`Couldn't open show: ${msg || 'unknown error'}`);
    }
  } finally {
    row.classList.remove('adv-result-row-loading');
    if (btn) btn.disabled = false;
  }
}

async function openOnNugs(row, artist) {
  const date = row.dataset.date;
  const btn  = row.querySelector('[data-action="nugs"]');
  if (!btn) return;
  const origLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = '🎤 Looking up…';
  try {
    const result = await tryNugsLookup(artist.name, date);
    if (!result.ok) {
      if (result.error === 'not-signed-in')      showToast('Sign in to Nugs in Settings to look up subscription shows.');
      else if (result.error === 'artist-not-found') showToast(`${artist.name} isn't on Nugs.net.`);
      else if (result.error === 'no-release-for-date') showToast(`No Nugs release for ${date}.`);
      else showToast('Nugs lookup failed.');
      return;
    }
    // Found it — switch to Nugs source pane and open the release.
    const sourceTab = document.querySelector('.source-tab[data-source="nugs"]');
    if (sourceTab) sourceTab.click();
    state.artist = result.nugsArtist;
    const m = await import('./views-nugs.js');
    m.nugsViewRelease(result.nugsArtist, result.containerID);
  } catch (err) {
    showToast(`Nugs lookup failed: ${err.message || 'unknown error'}`);
  } finally {
    btn.disabled = false;
    btn.textContent = origLabel;
  }
}

/* ── Nugs lookup ────────────────────────────────────────────────────────
 * Given a Relisten artist name and an ISO date, find the matching Nugs
 * container if one exists. Returns:
 *   { ok: true,  nugsArtist, containerID }       — opens nugsViewRelease
 *   { ok: false, error: 'not-signed-in'      }   — no Nugs auth
 *   { ok: false, error: 'artist-not-found'   }   — no Nugs artist matches by name
 *   { ok: false, error: 'no-release-for-date' }  — artist exists but no container on that date
 *
 * Artist match is case-insensitive exact first, substring fallback. Date
 * match uses nugsIsoDate to normalise Nugs's M/D/YYYY format.
 * ─────────────────────────────────────────────────────────────────── */
async function tryNugsLookup(artistName, isoDate) {
  if (!nugsAuth.hasToken()) return { ok: false, error: 'not-signed-in' };

  // Step 1: resolve the Nugs artist by name.
  const directory = await nugsApi.allArtists().catch(() => []);
  if (!directory.length) return { ok: false, error: 'artist-not-found' };
  const lower = String(artistName ?? '').trim().toLowerCase();
  if (!lower) return { ok: false, error: 'artist-not-found' };
  const exact   = directory.find(a => a.artistName?.toLowerCase() === lower);
  const partial = exact ?? directory.find(a => a.artistName?.toLowerCase().includes(lower));
  if (!partial) return { ok: false, error: 'artist-not-found' };

  // Step 2: fetch (or reuse cached) Nugs catalog for that artist.
  // Cache stores either a resolved containers[] OR an in-flight Promise.
  // The Promise stash dedupes rapid sibling clicks on "🎤 Nugs" buttons
  // for results from the same artist — without it, each click would
  // independently page through the entire catalog (10-30s × N for Dead),
  // wastefully burning Nugs rate-budget. Whoever arrives second awaits
  // the first caller's fetch and gets the same containers back.
  const artistKey = String(partial.artistID);
  let cached = _nugsCatalogCache.get(artistKey);
  let containers;
  if (Array.isArray(cached)) {
    containers = cached;
  } else if (cached && typeof cached.then === 'function') {
    containers = await cached;
  } else {
    const fetchPromise = (async () => {
      const all = [];
      let offset = 1;
      const SAFETY = 20; // 20 pages × 500/page = 10k containers — way more than any real artist
      for (let i = 0; i < SAFETY; i++) {
        const data = await nugsApi.catalog(partial.artistID, offset);
        const batch = data?.Response?.containers ?? [];
        all.push(...batch);
        if (batch.length < nugsApi.CATALOG_PAGE_SIZE) break;
        offset += nugsApi.CATALOG_PAGE_SIZE;
      }
      _nugsCatalogCache.set(artistKey, all);
      return all;
    })();
    _nugsCatalogCache.set(artistKey, fetchPromise);
    try {
      containers = await fetchPromise;
    } catch (err) {
      // On failure clear the cache entry so the next click can retry
      // instead of awaiting a permanently-rejected promise.
      if (_nugsCatalogCache.get(artistKey) === fetchPromise) {
        _nugsCatalogCache.delete(artistKey);
      }
      throw err;
    }
  }

  // Step 3: find a container whose performance date matches.
  const found = containers.find(c => nugsIsoDate(c.performanceDate) === isoDate);
  if (!found) return { ok: false, error: 'no-release-for-date' };

  const nugsArtist = {
    id:    String(partial.artistID),
    name:  partial.artistName,
    slug:  `nugs-${partial.artistID}`,
    _nugs: true,
  };
  return { ok: true, nugsArtist, containerID: String(found.containerID) };
}

/* ── Clear form ─────────────────────────────────────────────────────── */

function clearForm() {
  _formState.artistSlug = '';
  _formState.dateFrom = '';
  _formState.dateTo = '';
  _formState.month = '';
  _formState.day = '';
  _formState.dayOfWeek = '';
  _formState.venueName = '';
  _formState.city = '';
  _formState.stateCode = '';
  _formState.tourName = '';
  _formState.songRows = [{ name: '', position: 'anywhere', segueInto: '', followedBy: '' }];
  clearStaleResults();
  viewAdvancedSearch();
}

function clearStaleResults() {
  _lastResults           = [];
  _lastResultsArtistSlug = null;
  _lastResultsCriteria   = null;
  const wrap = $('advResults');
  if (wrap) wrap.innerHTML = '';
}

/* ── Combobox / autocomplete utility ─────────────────────────────────────
 *
 * Single shared popover element appended to <body>. Any input opts in via
 * `setupAutocomplete(input, getOptions, { onPick, placeholder })`:
 *
 *   • Focus or input event opens the popover positioned below the input.
 *   • `getOptions()` is invoked synchronously each time the popover opens
 *     so the suggestion list reflects whatever's cached at that moment
 *     (e.g. song names update as soon as the artist scan finishes).
 *   • Options are either plain strings OR `{ value, label, ...extra }`
 *     where the input fills with `value`. The artist picker uses the
 *     object form so `slug` can ride along on the picked option.
 *   • Filtering: case-insensitive substring; entries that start-with the
 *     query come first, then contains. Capped at 50 visible items so a
 *     1000-song catalog doesn't render a huge popover.
 *   • Keyboard: ↓ / ↑ to navigate, Enter to pick, Esc to close. Click
 *     also picks. Tab and blur (after a brief delay so clicks register
 *     first) close the popover.
 * ────────────────────────────────────────────────────────────────────── */

let _acPopover     = null;
let _acActiveInput = null;
let _acItems       = [];
let _acHighlight   = -1;
let _acOnPick      = null;

function ensureAcPopover() {
  if (_acPopover) return _acPopover;
  _acPopover = document.createElement('div');
  _acPopover.className   = 'adv-ac-popover';
  _acPopover.style.display = 'none';
  document.body.appendChild(_acPopover);
  // mousedown rather than click so the input doesn't fire blur before
  // we get to handle the pick — blur would tear down the popover first.
  _acPopover.addEventListener('mousedown', e => {
    e.preventDefault();
    const li = e.target.closest('[data-ac-idx]');
    if (li) pickAcItem(parseInt(li.dataset.acIdx, 10));
  });
  window.addEventListener('scroll', () => {
    if (_acActiveInput) positionAcPopover();
  }, true);
  return _acPopover;
}

export function setupAutocomplete(inputEl, getOptions, opts = {}) {
  if (!inputEl) return;
  const { onPick = null } = opts;

  const openOrFilter = () => {
    ensureAcPopover();
    _acActiveInput = inputEl;
    _acOnPick      = onPick;
    const q   = String(inputEl.value ?? '').trim().toLowerCase();
    const all = getOptions() ?? [];
    _acItems  = filterAndRankAc(all, q, 50);
    renderAcPopover();
    positionAcPopover();
    _acPopover.style.display = _acItems.length ? '' : 'none';
  };

  inputEl.addEventListener('focus', openOrFilter);
  inputEl.addEventListener('input', openOrFilter);
  inputEl.addEventListener('keydown', onAcKeydown);
  inputEl.addEventListener('blur', () => {
    setTimeout(() => {
      if (_acActiveInput === inputEl) closeAcPopover();
    }, 150);
  });
}

function filterAndRankAc(options, q, max) {
  const norm = (opt) => String(typeof opt === 'string' ? opt : opt.label ?? opt.value ?? '').toLowerCase();
  if (!q) return options.slice(0, max);
  const starts = [];
  const contains = [];
  for (const opt of options) {
    const lo = norm(opt);
    if (lo.startsWith(q)) starts.push(opt);
    else if (lo.includes(q)) contains.push(opt);
    if (starts.length + contains.length >= max * 2) break; // cheap cap
  }
  return [...starts, ...contains].slice(0, max);
}

function renderAcPopover() {
  _acHighlight = _acItems.length ? 0 : -1;
  _acPopover.innerHTML = _acItems.map((opt, i) => {
    const label = String(typeof opt === 'string' ? opt : opt.label ?? opt.value ?? '');
    return `<div class="adv-ac-item ${i === _acHighlight ? 'highlighted' : ''}" data-ac-idx="${i}">${escAc(label)}</div>`;
  }).join('');
}

function positionAcPopover() {
  if (!_acActiveInput || !_acPopover) return;
  const r = _acActiveInput.getBoundingClientRect();
  _acPopover.style.left  = `${r.left + window.scrollX}px`;
  _acPopover.style.top   = `${r.bottom + window.scrollY + 2}px`;
  _acPopover.style.width = `${r.width}px`;
}

function pickAcItem(idx) {
  const opt = _acItems[idx];
  if (!opt) return;
  const value = String(typeof opt === 'string' ? opt : opt.value ?? opt.label ?? '');
  if (_acActiveInput) {
    _acActiveInput.value = value;
    _acActiveInput.dispatchEvent(new Event('input',  { bubbles: true }));
    _acActiveInput.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (_acOnPick) _acOnPick(opt);
  closeAcPopover();
}

function closeAcPopover() {
  if (_acPopover) _acPopover.style.display = 'none';
  _acActiveInput = null;
  _acHighlight   = -1;
}

function onAcKeydown(e) {
  if (!_acPopover || _acPopover.style.display === 'none') return;
  if (e.key === 'ArrowDown')      { e.preventDefault(); moveHighlight(1); }
  else if (e.key === 'ArrowUp')   { e.preventDefault(); moveHighlight(-1); }
  else if (e.key === 'Enter')     {
    if (_acHighlight >= 0) { e.preventDefault(); pickAcItem(_acHighlight); }
  }
  else if (e.key === 'Escape')    { closeAcPopover(); }
  else if (e.key === 'Tab')       { closeAcPopover(); /* let tab proceed */ }
}

function moveHighlight(delta) {
  const items = _acPopover.querySelectorAll('[data-ac-idx]');
  if (!items.length) return;
  _acHighlight = Math.max(0, Math.min(items.length - 1, _acHighlight + delta));
  items.forEach((el, i) => el.classList.toggle('highlighted', i === _acHighlight));
  items[_acHighlight]?.scrollIntoView({ block: 'nearest' });
}

// Tiny inline escape to avoid pulling esc() through every popover render;
// values are pre-known artist / song / venue strings, not user-generated,
// but defence-in-depth still belongs here.
function escAc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
