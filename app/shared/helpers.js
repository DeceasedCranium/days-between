/* ── app/shared/helpers.js — pure-JS helpers ────────────────────────────────
 *
 * Functions in this module:
 *   • have NO browser dependencies (no DOM, no localStorage, no fetch)
 *   • have NO renderer-process dependencies (no `state`, no `nav`)
 *   • are deterministic for a given input
 *
 * They live here so they can be unit-tested in plain Node via the standard
 * `node:test` runner — see `test/helpers.test.js`. Renderer modules import
 * them from this single source of truth; tests import directly.
 *
 * If you find yourself reaching for `document` or `localStorage` while
 * editing this file, the function does NOT belong here — keep it in the
 * renderer module that actually needs the runtime side-effects.
 * ────────────────────────────────────────────────────────────────────────── */


/* ── Path-safety helpers (used by archive.js for filename construction) ─── */

/** Strip path-hostile characters from a filename / folder segment. Returns
 *  a non-empty fallback string ('untitled') so we never produce empty
 *  segments that could break path joins. */
export function sanitizeSegment(s) {
  return String(s ?? '')
    .replace(/[\/\\\0:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '')
    .slice(0, 120) || 'untitled';
}

/** Pull the file extension off a URL, ignoring query string. Lowercased. */
export function extFromUrl(url, fallback = 'mp3') {
  const m = String(url ?? '').split('?')[0].match(/\.([a-z0-9]{2,5})$/i);
  return (m?.[1] ?? fallback).toLowerCase();
}

/** "01 - Sugar Magnolia.flac" — zero-padded track number, sanitized title. */
export function trackFilename(idx, title, url) {
  return `${String(idx).padStart(2, '0')} - ${sanitizeSegment(title)}.${extFromUrl(url)}`;
}


/* ── Nugs catalog helpers ─────────────────────────────────────────────────── */

/** Normalize Nugs `performanceDate` to YYYY-MM-DD. Handles ISO, US (MM/DD/YYYY),
 *  and US-with-time. Returns the input verbatim if neither pattern matches. */
export function nugsIsoDate(d) {
  if (!d) return '';
  const iso = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = d.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  return d;
}

/** Parse Nugs date strings like "03/19/2026 18:31:47" → Unix seconds.
 *  Returns 0 if the input is empty or malformed. */
export function parseNugsDate(s) {
  if (!s) return 0;
  const [datePart, timePart] = s.split(' ');
  const [mm, dd, yyyy] = datePart.split('/');
  return new Date(`${yyyy}-${mm}-${dd}T${timePart ?? '00:00:00'}Z`).getTime() / 1000;
}

/** Resolve a Nugs container's cover-art URL.
 *
 *  Empirical pattern (from inspecting actual nugs.net image URLs):
 *    extImage:  "ddonato20260430_cover.jpg"
 *    img:       { orderID: 1, ... }
 *    real URL:  https://assets-01.nugscdn.net/livedownloads/images/shows/
 *               ddonato260430_01.jpg?h=600
 *
 *  Transform applied:
 *    • Drop the first two year digits (2026 → 26)
 *    • Replace the trailing token (e.g. `_cover`) with the zero-padded
 *      `img.orderID`
 *    • Prepend the `livedownloads/images/shows/` path
 *
 *  Falls back to the verbatim extImage filename if the regex doesn't match.
 *  Returns null when no usable reference exists, so the caller can render
 *  typographic art instead of a broken image. */
export function nugsContainerImage(c, { width = 300 } = {}) {
  if (!c) return null;

  // Already-absolute URL fields take priority.
  const abs = c.imageURL ?? c.image ?? c.coverArt ?? c.coverImage ?? c.pic ?? null;
  if (abs && typeof abs === 'string' && abs.startsWith('http')) return abs;

  const ext = c.extImage;
  if (!ext || typeof ext !== 'string') return null;

  const orderID = String(c.img?.orderID ?? 1).padStart(2, '0');
  const m = ext.match(/^(.+?)(\d{4})(\d{4})_[^.]+\.(\w+)$/);
  let fname;
  if (m) {
    const [, prefix, yyyy, mmdd, fileExt] = m;
    fname = `${prefix}${yyyy.slice(-2)}${mmdd}_${orderID}.${fileExt}`;
  } else {
    fname = ext; // best-effort fallback for non-standard names
  }
  return `https://assets-01.nugscdn.net/livedownloads/images/shows/${fname}?h=${width}`;
}

/** Recently Added — sorts by `epochDateCreated` (the Unix timestamp Nugs
 *  attaches when the container is first added to the catalog). This is
 *  distinct from `performanceDate` (the actual concert date). Falls back
 *  to releaseDate, then performanceDate. */
export function sortByRecent(releases) {
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
export function sortByPopular(releases) {
  const score = c => Number(c.salesAllTime ?? 0);
  const tie   = c => Number(c.salesLast30  ?? 0);
  const sorted = [...releases].sort((a, b) => score(b) - score(a) || tie(b) - tie(a));
  return sorted.some(c => score(c) > 0 || tie(c) > 0) ? sorted : sortByRecent(releases);
}

/** Apply Nugs filter object {sortAsc, year, month, type} over a release list. */
export function applyNugsFilters(releases, { sortAsc, year, month, type }) {
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


/* ── Relisten show → artist resolution ─────────────────────────────────────── */

/** Resolve the artist for a Relisten show object. Different Relisten
 *  endpoints serialise the artist differently:
 *    • /shows/on-date     → `show.artist = { slug, name, uuid, ... }` (nested)
 *    • /trending/shows    → `show.artist_uuid` only — no nested artist, no slug
 *    • /search            → `show.artist_slug` (flat string)
 *
 *  Walks all three shapes and falls back to the supplied artistsCache
 *  (typically `state.artists`) for the uuid → slug lookup. Returns
 *  `{ slug, name, image_url, ... }` or null. */
export function resolveShowArtist(show, artistsCache = []) {
  if (!show) return null;
  if (show.artist?.slug) {
    const cached = artistsCache.find(a => a.slug === show.artist.slug);
    return cached ?? show.artist;
  }
  if (show.artist_slug) {
    return artistsCache.find(a => a.slug === show.artist_slug)
        ?? { name: show.artist_name ?? show.artist_slug, slug: show.artist_slug };
  }
  if (show.artist_uuid) {
    return artistsCache.find(a => a.uuid === show.artist_uuid) ?? null;
  }
  return null;
}


/* ── Song-title normalisation (Nugs Songs tab) ────────────────────────────
 * Nugs has no canonical Song table — each container ships its raw track
 * titles. To dedupe "Deal", "Deal >", "Deal (encore)", "01 - Deal", and
 * "gd07191985-deal-set1" into a single bucket we strip common decorations:
 *   - Leading track numbers ("01 - ", "12. ")
 *   - Filename prefixes ("gd07191985-")
 *   - Trailing arrows / markers (" >", " ->", " (set 1)", " (encore)", "~")
 *   - Whitespace + case
 * Returns the lowercased canonical key. Use the original title in the UI;
 * the key is for grouping only.
 * ──────────────────────────────────────────────────────────────────────── */
export function normaliseSongTitle(s) {
  if (!s || typeof s !== 'string') return '';
  let t = s.trim();
  // Strip leading track-number prefix: "01 - ", "12. ", "t01 "
  t = t.replace(/^t?\d{1,3}\s*[-.\s]\s*/i, '');
  // Strip filename-style prefix: "gd07191985-"
  t = t.replace(/^[a-z]+\d{6,8}-/i, '');
  // Strip trailing decorations: arrows, set markers, encore tags, jam suffixes
  t = t.replace(/\s*[~>\-]+\s*$/g, '');                    // " >", " -", " ~"
  t = t.replace(/\s*->\s*$/, '');                          // " -> "
  t = t.replace(/\s*\((set\s*\d|encore|reprise|jam|cont\.|continued|partial)[^)]*\)\s*$/i, '');
  t = t.replace(/\s*\[(set\s*\d|encore|reprise|jam)[^\]]*\]\s*$/i, '');
  // Collapse whitespace
  t = t.replace(/\s+/g, ' ').trim();
  return t.toLowerCase();
}

/** Best display title for a normalised group — picks the most-frequent
 *  variant and prefers the title-cased one to ALLCAPS. */
export function pickDisplayTitle(titles) {
  if (!titles?.length) return '';
  const counts = new Map();
  for (const t of titles) counts.set(t, (counts.get(t) ?? 0) + 1);
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return ordered[0][0];
}

/** Pull the most useful song-title array off a Nugs container.
 *
 *  Different Nugs endpoints + different artist tiers return setlist data in
 *  different shapes:
 *    • catalog.containersAll → `songs: [{songTitle, ...}, ...]` (most common)
 *    • catalog.containersAll → `songList: [...]` for some artists
 *    • catalog.container     → `tracks: [{songTitle, ...}, ...]` (per-show
 *                              detail endpoint, fuller track listing)
 *  We try each in turn and return the first non-empty one. Items can be
 *  raw strings or objects — both shapes are handled. */
export function pickContainerTracklist(c) {
  if (!c) return [];
  for (const field of ['songs', 'songList', 'tracks', 'Tracks', 'setList']) {
    const arr = c[field];
    if (Array.isArray(arr) && arr.length) return arr;
  }
  return [];
}

/** Build a map of normalised-key → { displayTitle, plays, containerIDs }
 *  from a list of Nugs containers. Used to drive the Nugs Songs tab. */
export function aggregateNugsSongs(containers) {
  const map = new Map();
  for (const c of containers ?? []) {
    const items = pickContainerTracklist(c);
    const titles = items.map(s =>
      typeof s === 'string' ? s : (s.songTitle ?? s.title ?? s.name ?? '')
    ).filter(Boolean);
    const seenInThisShow = new Set();
    for (const title of titles) {
      const key = normaliseSongTitle(title);
      if (!key) continue;
      // Don't double-count the same song twice in one show.
      if (seenInThisShow.has(key)) continue;
      seenInThisShow.add(key);
      let entry = map.get(key);
      if (!entry) {
        entry = { key, titles: [], plays: 0, containerIDs: new Set() };
        map.set(key, entry);
      }
      entry.titles.push(title);
      entry.plays++;
      entry.containerIDs.add(String(c.containerID));
    }
  }
  // Finalise: pick display title, freeze container set into array.
  return [...map.values()].map(e => ({
    key:           e.key,
    displayTitle:  pickDisplayTitle(e.titles),
    plays:         e.plays,
    containerIDs:  [...e.containerIDs],
  }));
}

/** Diagnostic counts useful when the Songs tab returns fewer plays than
 *  expected — answers "is the data actually in the catalog response?". */
export function nugsSongsDiagnostics(containers) {
  const total = containers?.length ?? 0;
  let withSongs = 0, totalTracks = 0, sampleEmpty = null, sampleFilled = null;
  for (const c of containers ?? []) {
    const items = pickContainerTracklist(c);
    if (items.length) {
      withSongs++;
      totalTracks += items.length;
      if (!sampleFilled) sampleFilled = c;
    } else if (!sampleEmpty) {
      sampleEmpty = c;
    }
  }
  return {
    totalContainers:  total,
    withSetlist:      withSongs,
    coveragePct:      total ? Math.round((withSongs / total) * 100) : 0,
    totalTracks,
    avgTracksPerShow: withSongs ? Math.round(totalTracks / withSongs) : 0,
    sampleEmpty,
    sampleFilled,
  };
}

/** Group a list of Relisten Song objects by their normalised title.
 *
 *  Relisten's canonical Song table is mostly clean, but artists with messy
 *  taper data sometimes ingest "Bertha", "Bertha >", and "Bertha ->" as
 *  three separate Song rows. This helper merges them: groups by
 *  `normaliseSongTitle(name)`, sums `shows_played_at`, and picks the
 *  cleanest variant (shortest + no decoration markers) as the display name.
 *  Keeps the original variants on `_variants` for debugging.
 *
 *  Defensive: Relisten's /songs endpoint sometimes returns an envelope
 *  `{success, error_code, data}` instead of a raw array (typically when
 *  the artist has no song-catalog data). We unwrap and tolerate empty.
 *
 *  Pure function — call it after `api.songs(slug)` resolves. */
export function dedupeRelistenSongs(songs) {
  // Unwrap envelope if present.
  if (songs && !Array.isArray(songs) && typeof songs === 'object') {
    songs = Array.isArray(songs.data) ? songs.data
          : Array.isArray(songs.songs) ? songs.songs
          : [];
  }
  if (!Array.isArray(songs)) songs = [];

  const groups = new Map();
  for (const s of songs) {
    if (!s?.name) continue;
    const key = normaliseSongTitle(s.name);
    if (!key) continue;
    let g = groups.get(key);
    if (!g) {
      g = { ...s, name: s.name, shows_played_at: 0, _variants: [] };
      groups.set(key, g);
    }
    g.shows_played_at += s.shows_played_at ?? 0;
    g._variants.push(s);
    // Pick the cleanest display name: prefer one without trailing decoration
    // markers, then shorter wins on ties.
    const cleaner =
      hasDecoration(g.name) && !hasDecoration(s.name) ||
      (!hasDecoration(g.name) === !hasDecoration(s.name) && s.name.length < g.name.length);
    if (cleaner) g.name = s.name;
  }
  return [...groups.values()];
}

function hasDecoration(name) {
  return /[~>]|->/.test(name);
}

/** Aggregate per-show track lists into a Songs-tab-shaped list. Used as
 *  a fallback when Relisten's `/songs` endpoint is empty for an artist
 *  (Dead & Company is the canonical example) — we walk every show's
 *  setlist and build the canonical song list ourselves.
 *
 *  Input: array of "full show" objects (each with `sources[].sets[].tracks[]`).
 *  Output: same shape as `dedupeRelistenSongs` returns:
 *    [{ name, shows_played_at }, ...]
 *
 *  Composite tracks like "Bertha > Eyes of the World" are split on
 *  transition markers so both songs register. Within a single show, the
 *  same song is counted at most once. */
export function aggregateRelistenShowsToSongs(showsWithTracks) {
  const map = new Map();
  for (const show of showsWithTracks ?? []) {
    const tracks = (show?.sources ?? []).flatMap(src =>
      (src.sets ?? []).flatMap(s => s.tracks ?? [])
    );
    const seenInThisShow = new Set();
    for (const t of tracks) {
      if (!t?.title) continue;
      for (const seg of String(t.title).split(/\s*(?:->|>|~)\s*/)) {
        const key = normaliseSongTitle(seg);
        if (!key || seenInThisShow.has(key)) continue;
        seenInThisShow.add(key);
        let entry = map.get(key);
        if (!entry) {
          entry = { key, titles: [], plays: 0 };
          map.set(key, entry);
        }
        entry.titles.push(seg.trim());
        entry.plays++;
      }
    }
  }
  return [...map.values()].map(e => ({
    name: pickDisplayTitle(e.titles),
    shows_played_at: e.plays,
  }));
}

/** Determine whether a Relisten track title represents a play of the given
 *  target song. Splits on jam-band transition markers (`>`, `->`, `~`) and
 *  exact-matches each segment after normalisation, so:
 *
 *    "Bertha"                          → matches "bertha"
 *    "Bertha >"                        → matches "bertha"
 *    "Bertha > Eyes of the World"      → matches "bertha" AND "eyes of the world"
 *    "01 - Bertha (encore)"            → matches "bertha"
 *    "Bertha Tease"                    → does NOT match "bertha" (own thing)
 *
 *  This is more precise than substring matching while still capturing the
 *  composite-track convention that's standard in jam-band setlists. */
export function trackContainsSong(trackTitle, targetKey) {
  if (!trackTitle || !targetKey) return false;
  const segments = String(trackTitle).split(/\s*(?:->|>|~)\s*/);
  for (const seg of segments) {
    if (normaliseSongTitle(seg) === targetKey) return true;
  }
  return false;
}

/* ── Semver-ish comparison (update notifier) ──────────────────────────────── */

/** Compare two semver-ish strings (e.g. "1.9.0" vs "1.10.0").
 *  Returns >0 if a is newer, <0 if b is newer, 0 if equal. Ignores the
 *  optional leading "v". Tolerates pre-release / build metadata by stripping
 *  anything past the first hyphen. */
export function compareVersions(a, b) {
  const parse = s => String(s ?? '0')
    .replace(/^v/, '')
    .split('-')[0]
    .split('.')
    .map(n => parseInt(n, 10) || 0);
  const ap = parse(a);
  const bp = parse(b);
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const av = ap[i] ?? 0, bv = bp[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}
