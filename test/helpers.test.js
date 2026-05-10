/* ── test/helpers.test.js — pure-helper unit tests ─────────────────────────
 *
 * Run via:   npm test
 * Or:        node --test test/
 *
 * These tests pin the exact behaviour of regression-prone helpers. Most of
 * them encode bugs we shipped during early dev — the assertions here are a
 * tripwire that prevents the bug from coming back during future API-shape
 * changes. When the Relisten or Nugs API responses shift, the test that
 * matches the OLD shape will fail loudly instead of silently breaking
 * production after an unrelated edit.
 * ──────────────────────────────────────────────────────────────────────── */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitizeSegment,
  extFromUrl,
  trackFilename,
  nugsIsoDate,
  parseNugsDate,
  nugsContainerImage,
  sortByRecent,
  sortByPopular,
  applyNugsFilters,
  resolveShowArtist,
  compareVersions,
  normaliseSongTitle,
  pickDisplayTitle,
  aggregateNugsSongs,
  dedupeRelistenSongs,
  trackContainsSong,
  aggregateRelistenShowsToSongs,
  aggregateSongCountsFromSetlists,
  computeArtistAffinities,
  formatAffinityReason,
} from '../app/shared/helpers.js';


/* ── sanitizeSegment ───────────────────────────────────────────────────── */

test('sanitizeSegment strips path-hostile characters', () => {
  // 3 separators + 6 trailing-special chars → 9 underscores total
  assert.equal(sanitizeSegment('foo/bar\\baz:qux*?"<>|'), 'foo_bar_baz_qux______');
});

test('sanitizeSegment collapses whitespace and trims', () => {
  assert.equal(sanitizeSegment('  hello   world  '), 'hello world');
});

test('sanitizeSegment strips trailing dots (Windows-hostile)', () => {
  assert.equal(sanitizeSegment('foo.....'), 'foo');
});

test('sanitizeSegment caps at 120 chars', () => {
  const long = 'a'.repeat(200);
  assert.equal(sanitizeSegment(long).length, 120);
});

test('sanitizeSegment returns "untitled" for empty / whitespace-only input', () => {
  assert.equal(sanitizeSegment(''),       'untitled');
  assert.equal(sanitizeSegment(null),     'untitled');
  assert.equal(sanitizeSegment(undefined),'untitled');
  assert.equal(sanitizeSegment('     '),  'untitled');
});


/* ── extFromUrl ────────────────────────────────────────────────────────── */

test('extFromUrl pulls extension from a clean URL', () => {
  assert.equal(extFromUrl('https://example.com/foo.flac'), 'flac');
});

test('extFromUrl ignores query string', () => {
  assert.equal(extFromUrl('https://example.com/foo.mp3?token=abc'), 'mp3');
});

test('extFromUrl falls back when no extension', () => {
  assert.equal(extFromUrl('https://example.com/foo'),         'mp3');
  assert.equal(extFromUrl('https://example.com/foo', 'flac'), 'flac');
});

test('extFromUrl lowercases the extension', () => {
  assert.equal(extFromUrl('https://example.com/foo.FLAC'), 'flac');
});


/* ── trackFilename ─────────────────────────────────────────────────────── */

test('trackFilename builds zero-padded archive names', () => {
  assert.equal(
    trackFilename(1, 'Sugar Magnolia', 'https://cdn/foo.flac'),
    '01 - Sugar Magnolia.flac',
  );
  assert.equal(
    trackFilename(15, 'Truckin\'', 'https://cdn/foo.mp3'),
    '15 - Truckin\'.mp3',
  );
});

test('trackFilename sanitises hostile chars in titles', () => {
  assert.equal(
    trackFilename(2, 'Track / Slash', 'foo.mp3'),
    '02 - Track _ Slash.mp3',
  );
});


/* ── nugsIsoDate ───────────────────────────────────────────────────────── */

test('nugsIsoDate normalises ISO already-correct dates', () => {
  assert.equal(nugsIsoDate('2026-04-30'), '2026-04-30');
});

test('nugsIsoDate normalises US format', () => {
  assert.equal(nugsIsoDate('4/30/2026'),   '2026-04-30');
  assert.equal(nugsIsoDate('04/30/2026'),  '2026-04-30');
  assert.equal(nugsIsoDate('12/9/1995'),   '1995-12-09');
});

test('nugsIsoDate handles US format with time suffix', () => {
  assert.equal(nugsIsoDate('5/6/2026 12:36:45 PM'), '2026-05-06');
});

test('nugsIsoDate returns empty for nullish input', () => {
  assert.equal(nugsIsoDate(''),        '');
  assert.equal(nugsIsoDate(undefined), '');
  assert.equal(nugsIsoDate(null),      '');
});


/* ── parseNugsDate ─────────────────────────────────────────────────────── */

test('parseNugsDate parses MM/DD/YYYY HH:MM:SS into Unix seconds', () => {
  const t = parseNugsDate('05/06/2026 12:36:45');
  assert.ok(t > 0);
  // Round-trip through Date — Unix seconds should match
  const d = new Date(t * 1000);
  assert.equal(d.getUTCFullYear(),  2026);
  assert.equal(d.getUTCMonth() + 1, 5);
  assert.equal(d.getUTCDate(),      6);
});

test('parseNugsDate returns 0 for empty input', () => {
  assert.equal(parseNugsDate(''), 0);
  assert.equal(parseNugsDate(null), 0);
});


/* ── nugsContainerImage ────────────────────────────────────────────────────
 * The Nugs CDN URL pattern broke twice during dev. These assertions pin
 * the exact transformation the code performs.
 * ────────────────────────────────────────────────────────────────────────── */

test('nugsContainerImage builds the canonical CDN URL from extImage + orderID', () => {
  const c = {
    extImage: 'ddonato20260430_cover.jpg',
    img: { orderID: 1 },
  };
  assert.equal(
    nugsContainerImage(c),
    'https://assets-01.nugscdn.net/livedownloads/images/shows/ddonato260430_01.jpg?h=300',
  );
});

test('nugsContainerImage zero-pads orderID', () => {
  const c = {
    extImage: 'phish20260101_cover.jpg',
    img: { orderID: 7 },
  };
  assert(nugsContainerImage(c).endsWith('phish260101_07.jpg?h=300'));
});

test('nugsContainerImage honours the width option for the hero variant', () => {
  const c = {
    extImage: 'gd19770508_cover.jpg',
    img: { orderID: 1 },
  };
  assert(nugsContainerImage(c, { width: 600 }).endsWith('?h=600'));
});

test('nugsContainerImage prefers absolute URL fields over extImage', () => {
  const c = {
    imageURL: 'https://other.cdn/foo.jpg',
    extImage: 'phish20260101_cover.jpg',
  };
  assert.equal(nugsContainerImage(c), 'https://other.cdn/foo.jpg');
});

test('nugsContainerImage falls back to verbatim extImage when regex does not match', () => {
  const c = {
    extImage: 'gdMAGL_cover.jpg',
    img: { orderID: 1 },
  };
  assert(nugsContainerImage(c).endsWith('gdMAGL_cover.jpg?h=300'));
});

test('nugsContainerImage returns null when no usable reference', () => {
  assert.equal(nugsContainerImage(null),       null);
  assert.equal(nugsContainerImage({}),         null);
  assert.equal(nugsContainerImage({ img: {} }), null);
});


/* ── sortByRecent / sortByPopular ─────────────────────────────────────────
 * These two tabs LOOKED identical for a while because both fell back to
 * performanceDate when their actual sort fields were missing. The tests
 * pin the exact field priority.
 * ────────────────────────────────────────────────────────────────────────── */

test('sortByRecent sorts by epochDateCreated desc', () => {
  const releases = [
    { containerID: 1, epochDateCreated: 1000 },
    { containerID: 2, epochDateCreated: 3000 },
    { containerID: 3, epochDateCreated: 2000 },
  ];
  const out = sortByRecent(releases);
  assert.deepEqual(out.map(r => r.containerID), [2, 3, 1]);
});

test('sortByRecent falls back to performanceDate when epoch missing', () => {
  const releases = [
    { containerID: 1, performanceDate: '2026-01-01' },
    { containerID: 2, performanceDate: '2026-03-01' },
    { containerID: 3, performanceDate: '2026-02-01' },
  ];
  const out = sortByRecent(releases);
  assert.deepEqual(out.map(r => r.containerID), [2, 3, 1]);
});

test('sortByRecent does not mutate input', () => {
  const input = [{ containerID: 1, epochDateCreated: 1 }, { containerID: 2, epochDateCreated: 2 }];
  const before = input.map(r => r.containerID);
  sortByRecent(input);
  assert.deepEqual(input.map(r => r.containerID), before);
});

test('sortByPopular sorts by salesAllTime desc', () => {
  const releases = [
    { containerID: 1, salesAllTime: 100 },
    { containerID: 2, salesAllTime: 500 },
    { containerID: 3, salesAllTime: 300 },
  ];
  const out = sortByPopular(releases);
  assert.deepEqual(out.map(r => r.containerID), [2, 3, 1]);
});

test('sortByPopular uses salesLast30 as tiebreaker', () => {
  const releases = [
    { containerID: 1, salesAllTime: 100, salesLast30: 5  },
    { containerID: 2, salesAllTime: 100, salesLast30: 50 },
    { containerID: 3, salesAllTime: 100, salesLast30: 10 },
  ];
  const out = sortByPopular(releases);
  assert.deepEqual(out.map(r => r.containerID), [2, 3, 1]);
});

test('sortByPopular falls back to sortByRecent when all sales are zero', () => {
  const releases = [
    { containerID: 1, salesAllTime: 0, epochDateCreated: 1000 },
    { containerID: 2, salesAllTime: 0, epochDateCreated: 3000 },
    { containerID: 3, salesAllTime: 0, epochDateCreated: 2000 },
  ];
  const out = sortByPopular(releases);
  assert.deepEqual(out.map(r => r.containerID), [2, 3, 1]);
});


/* ── applyNugsFilters ────────────────────────────────────────────────────── */

test('applyNugsFilters by year', () => {
  const releases = [
    { containerID: 1, performanceDate: '2024-05-01' },
    { containerID: 2, performanceDate: '2025-05-01' },
    { containerID: 3, performanceDate: '2025-06-01' },
  ];
  const out = applyNugsFilters(releases, { year: '2025' });
  assert.deepEqual(out.map(r => r.containerID).sort(), [2, 3]);
});

test('applyNugsFilters audio-only excludes video releases', () => {
  const releases = [
    { containerID: 1, performanceDate: '2025-05-01', videoURL: 'https://v.cdn/x' },
    { containerID: 2, performanceDate: '2025-06-01' },
  ];
  const out = applyNugsFilters(releases, { type: 'audio' });
  assert.deepEqual(out.map(r => r.containerID), [2]);
});


/* ── resolveShowArtist ───────────────────────────────────────────────────────
 * This was the bug behind every "On This Day" / "Trending" / "Today" 404.
 * Different Relisten endpoints serialise the artist differently — the test
 * pins behaviour for all three known shapes plus the cache-fallback path.
 * ────────────────────────────────────────────────────────────────────────── */

const ARTIST_CACHE = [
  { slug: 'phish',         uuid: 'phish-uuid',   name: 'Phish',         image_url: '/p.jpg' },
  { slug: 'grateful-dead', uuid: 'gd-uuid',      name: 'Grateful Dead', image_url: null },
];

test('resolveShowArtist returns nested artist object directly (on-date shape)', () => {
  const show   = { artist: { slug: 'phish', name: 'Phish' } };
  const artist = resolveShowArtist(show, ARTIST_CACHE);
  assert.equal(artist.slug, 'phish');
});

test('resolveShowArtist enriches nested artist via cache when slug matches', () => {
  const show   = { artist: { slug: 'phish' } };
  const artist = resolveShowArtist(show, ARTIST_CACHE);
  assert.equal(artist.image_url, '/p.jpg'); // came from cache, not from show
});

test('resolveShowArtist looks up flat artist_slug', () => {
  const show   = { artist_slug: 'phish' };
  const artist = resolveShowArtist(show, ARTIST_CACHE);
  assert.equal(artist.name, 'Phish');
});

test('resolveShowArtist resolves trending v3 artist_uuid via cache', () => {
  const show   = { artist_uuid: 'gd-uuid' };
  const artist = resolveShowArtist(show, ARTIST_CACHE);
  assert.equal(artist.slug, 'grateful-dead');
});

test('resolveShowArtist returns null when uuid not in cache', () => {
  const show = { artist_uuid: 'unknown-uuid' };
  assert.equal(resolveShowArtist(show, ARTIST_CACHE), null);
});

test('resolveShowArtist returns synthesised stub for unknown flat slug', () => {
  const show   = { artist_slug: 'mystery', artist_name: 'Mystery Band' };
  const artist = resolveShowArtist(show, ARTIST_CACHE);
  assert.equal(artist.slug, 'mystery');
  assert.equal(artist.name, 'Mystery Band');
});

test('resolveShowArtist returns null for empty payloads', () => {
  assert.equal(resolveShowArtist(null,           ARTIST_CACHE), null);
  assert.equal(resolveShowArtist({},             ARTIST_CACHE), null);
  assert.equal(resolveShowArtist({ display_date: '2026-04-30' }, ARTIST_CACHE), null);
});


/* ── compareVersions (update notifier) ───────────────────────────────────── */

test('compareVersions handles basic dotted comparisons', () => {
  assert.ok(compareVersions('1.10.0', '1.9.0')  > 0);
  assert.ok(compareVersions('1.9.0',  '1.10.0') < 0);
  assert.equal(compareVersions('1.9.0', '1.9.0'),  0);
});

test('compareVersions ignores leading "v"', () => {
  assert.equal(compareVersions('v1.9.0', '1.9.0'), 0);
});

test('compareVersions strips pre-release / build metadata', () => {
  assert.equal(compareVersions('1.9.0-rc.1', '1.9.0'), 0);
});

test('compareVersions handles missing segments as zero', () => {
  assert.ok(compareVersions('1.10', '1.10.0') === 0);
  assert.ok(compareVersions('2',    '1.99.99') > 0);
});


/* ── normaliseSongTitle (Nugs Songs tab dedup) ──────────────────────────── */

test('normaliseSongTitle handles plain titles', () => {
  assert.equal(normaliseSongTitle('Deal'), 'deal');
});

test('normaliseSongTitle strips trailing arrow markers', () => {
  assert.equal(normaliseSongTitle('Deal >'),    'deal');
  assert.equal(normaliseSongTitle('Deal ->'),   'deal');
  assert.equal(normaliseSongTitle('Deal ~'),    'deal');
});

test('normaliseSongTitle strips set / encore decorations', () => {
  assert.equal(normaliseSongTitle('Deal (set 1)'),     'deal');
  assert.equal(normaliseSongTitle('Deal (encore)'),    'deal');
  assert.equal(normaliseSongTitle('Deal (reprise)'),   'deal');
  assert.equal(normaliseSongTitle('Deal [Set 2]'),     'deal');
});

test('normaliseSongTitle strips leading track numbers', () => {
  assert.equal(normaliseSongTitle('01 - Deal'),  'deal');
  assert.equal(normaliseSongTitle('12. Deal'),   'deal');
  assert.equal(normaliseSongTitle('t01 Deal'),   'deal');
});

test('normaliseSongTitle strips taper filename prefix', () => {
  assert.equal(normaliseSongTitle('gd07191985-Deal'), 'deal');
});

test('normaliseSongTitle is case- and whitespace-insensitive', () => {
  assert.equal(normaliseSongTitle('  DEAL  '), 'deal');
});

test('aggregateNugsSongs groups across containers and dedups within a show', () => {
  const containers = [
    { containerID: 1, songs: ['Deal', 'Eyes of the World', 'Eyes of the World'] }, // dup w/in show
    { containerID: 2, songs: ['Deal >', '01 - Eyes of the World'] },
    { containerID: 3, songs: ['Tennessee Jed'] },
  ];
  const out = aggregateNugsSongs(containers);
  const byKey = Object.fromEntries(out.map(s => [s.key, s]));
  assert.equal(byKey['deal'].plays, 2);
  assert.equal(byKey['deal'].containerIDs.length, 2);
  assert.equal(byKey['eyes of the world'].plays, 2);          // not 3 — dup in show 1 collapsed
  assert.equal(byKey['eyes of the world'].containerIDs.length, 2);
  assert.equal(byKey['tennessee jed'].plays, 1);
});

test('aggregateNugsSongs picks the most-frequent display title', () => {
  const containers = [
    { containerID: 1, songs: ['Deal'] },
    { containerID: 2, songs: ['Deal'] },
    { containerID: 3, songs: ['Deal >'] },
  ];
  const out = aggregateNugsSongs(containers);
  const deal = out.find(s => s.key === 'deal');
  assert.equal(deal.displayTitle, 'Deal'); // appears 2x vs "Deal >" 1x
});


/* ── dedupeRelistenSongs ─────────────────────────────────────────────────── */

test('dedupeRelistenSongs merges decorated variants of the same canonical song', () => {
  const songs = [
    { name: 'Bertha',     shows_played_at: 412 },
    { name: 'Bertha >',   shows_played_at: 17  },
    { name: 'Bertha ->',  shows_played_at: 3   },
    { name: 'Truckin\'',  shows_played_at: 380 },
  ];
  const out = dedupeRelistenSongs(songs);
  assert.equal(out.length, 2); // Bertha + Truckin
  const bertha = out.find(s => s.name === 'Bertha');
  assert.equal(bertha.shows_played_at, 432);
  assert.equal(bertha._variants.length, 3);
});

test('dedupeRelistenSongs picks the cleanest display name', () => {
  // Decorated entries first; the clean one comes after.
  const songs = [
    { name: 'Bertha >',  shows_played_at: 1 },
    { name: 'Bertha ->', shows_played_at: 1 },
    { name: 'Bertha',    shows_played_at: 1 }, // arrives last but should win
  ];
  const out = dedupeRelistenSongs(songs);
  assert.equal(out[0].name, 'Bertha');
});

test('dedupeRelistenSongs unwraps the {success, data} envelope', () => {
  // Relisten /songs sometimes returns this shape (especially for 404s or
  // artists with no song-catalog data) instead of a raw array.
  const envelope = { success: false, error_code: 404, data: false };
  const out = dedupeRelistenSongs(envelope);
  assert.deepEqual(out, []);
});

test('dedupeRelistenSongs unwraps {data: [...]} envelope', () => {
  const envelope = { success: true, data: [{ name: 'Bertha', shows_played_at: 5 }] };
  const out = dedupeRelistenSongs(envelope);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Bertha');
});

test('dedupeRelistenSongs ignores empty names gracefully', () => {
  const songs = [
    { name: '', shows_played_at: 0 },
    { name: 'Bertha', shows_played_at: 100 },
    { shows_played_at: 50 },
  ];
  const out = dedupeRelistenSongs(songs);
  assert.equal(out.length, 1);
  assert.equal(out[0].shows_played_at, 100);
});


/* ── trackContainsSong (smarter song-detail matching) ────────────────────── */

test('trackContainsSong matches plain titles', () => {
  assert.ok(trackContainsSong('Bertha', 'bertha'));
});

test('trackContainsSong matches transition-decorated titles', () => {
  assert.ok(trackContainsSong('Bertha >',  'bertha'));
  assert.ok(trackContainsSong('Bertha ->', 'bertha'));
  assert.ok(trackContainsSong('Bertha ~',  'bertha'));
});

test('trackContainsSong matches BOTH songs in a composite jam track', () => {
  assert.ok(trackContainsSong('Bertha > Eyes of the World', 'bertha'));
  assert.ok(trackContainsSong('Bertha > Eyes of the World', 'eyes of the world'));
});

test('trackContainsSong does NOT match "Bertha Tease" for "bertha"', () => {
  // "Bertha Tease" is its own thing in jam-band parlance.
  assert.equal(trackContainsSong('Bertha Tease', 'bertha'), false);
});

test('trackContainsSong does NOT false-match unrelated substrings', () => {
  assert.equal(trackContainsSong('My Eyes Are Blue', 'eyes'), false);
});

test('trackContainsSong handles leading track-number / set markers', () => {
  assert.ok(trackContainsSong('01 - Bertha (encore)', 'bertha'));
});


/* ── aggregateRelistenShowsToSongs (Songs-tab fallback) ────────────────── */

test('aggregateRelistenShowsToSongs builds song list from show setlists', () => {
  const shows = [
    { sources: [{ sets: [{ tracks: [
      { title: 'Bertha' }, { title: 'Truckin\'' }, { title: 'Sugar Magnolia' }
    ]}]}]},
    { sources: [{ sets: [{ tracks: [
      { title: 'Bertha >' }, { title: 'Eyes of the World' }
    ]}]}]},
    { sources: [{ sets: [{ tracks: [
      { title: 'Truckin\'' }, { title: 'Bertha (encore)' }
    ]}]}]},
  ];
  const out = aggregateRelistenShowsToSongs(shows);
  const map = Object.fromEntries(out.map(s => [s.name.toLowerCase(), s.shows_played_at]));
  assert.equal(map['bertha'], 3);              // played in all three shows
  assert.equal(map['truckin\''], 2);
  assert.equal(map['eyes of the world'], 1);
  assert.equal(map['sugar magnolia'], 1);
});

test('aggregateRelistenShowsToSongs splits composite tracks across both songs', () => {
  const shows = [
    { sources: [{ sets: [{ tracks: [
      { title: 'Bertha > Eyes of the World' }
    ]}]}]},
  ];
  const out = aggregateRelistenShowsToSongs(shows);
  const names = out.map(s => s.name.toLowerCase()).sort();
  assert.deepEqual(names, ['bertha', 'eyes of the world']);
});

test('aggregateRelistenShowsToSongs dedupes within a single show', () => {
  const shows = [
    { sources: [{ sets: [
      { tracks: [{ title: 'Bertha' }] },
      { tracks: [{ title: 'Bertha (encore)' }] },
    ]}]},
  ];
  const out = aggregateRelistenShowsToSongs(shows);
  const bertha = out.find(s => s.name.toLowerCase() === 'bertha');
  assert.equal(bertha.shows_played_at, 1); // not 2 — same show
});

test('aggregateRelistenShowsToSongs returns [] for empty input', () => {
  assert.deepEqual(aggregateRelistenShowsToSongs([]),         []);
  assert.deepEqual(aggregateRelistenShowsToSongs(undefined),  []);
});


/* ── aggregateSongCountsFromSetlists (setlist.fm) ────────────────────────── */

test('aggregateSongCountsFromSetlists counts across multiple setlists', () => {
  const setlists = [
    { sets: { set: [
      { song: [{ name: 'Bertha' }, { name: 'Truckin\'' }] },
      { song: [{ name: 'Sugar Magnolia' }] },
    ]}},
    { sets: { set: [
      { song: [{ name: 'Bertha' }, { name: 'Eyes of the World' }] },
    ]}},
    { sets: { set: [
      { song: [{ name: 'Truckin\'' }] },
    ]}},
  ];
  const counts = aggregateSongCountsFromSetlists(setlists);
  assert.equal(counts.get('bertha'), 2);
  assert.equal(counts.get("truckin'"), 2);
  assert.equal(counts.get('sugar magnolia'), 1);
  assert.equal(counts.get('eyes of the world'), 1);
});

test('aggregateSongCountsFromSetlists dedupes within a single setlist', () => {
  const setlists = [
    { sets: { set: [
      { song: [{ name: 'Bertha' }] },
      { song: [{ name: 'Bertha (encore)' }] },  // reprise — same setlist
    ]}},
  ];
  const counts = aggregateSongCountsFromSetlists(setlists);
  assert.equal(counts.get('bertha'), 1);
});

test('aggregateSongCountsFromSetlists normalises titles consistently', () => {
  const setlists = [
    { sets: { set: [{ song: [{ name: 'Bertha >' }] }]}},
    { sets: { set: [{ song: [{ name: 'Bertha ->' }] }]}},
    { sets: { set: [{ song: [{ name: '01 - Bertha' }] }]}},
  ];
  const counts = aggregateSongCountsFromSetlists(setlists);
  assert.equal(counts.get('bertha'), 3);
});

test('aggregateSongCountsFromSetlists handles malformed input gracefully', () => {
  assert.equal(aggregateSongCountsFromSetlists([]).size, 0);
  assert.equal(aggregateSongCountsFromSetlists(undefined).size, 0);
  assert.equal(aggregateSongCountsFromSetlists([{}]).size, 0);
  assert.equal(aggregateSongCountsFromSetlists([{ sets: {} }]).size, 0);
});

/* ── computeArtistAffinities ─────────────────────────────────────────────── */

test('computeArtistAffinities returns empty Map on empty input', () => {
  assert.equal(computeArtistAffinities().size, 0);
  assert.equal(computeArtistAffinities({}).size, 0);
});

test('computeArtistAffinities single-signal: attended only', () => {
  const m = computeArtistAffinities({
    attended: [
      { artistSlug: 'phish',     artistName: 'Phish',     date: '2024-07-04' },
      { artistSlug: 'phish',     artistName: 'Phish',     date: '2024-07-05' },
      { artistSlug: 'dead-co',   artistName: 'Dead & Co', date: '2023-08-01' },
    ],
  });
  assert.equal(m.get('phish').score, 6);    // 2 × 3
  assert.equal(m.get('dead-co').score, 3);  // 1 × 3
  assert.equal(m.get('phish').signals.attended, 2);
});

test('computeArtistAffinities single-signal: pinned only', () => {
  const m = computeArtistAffinities({
    artistFavs: ['phish', 'dead-co'],
  });
  assert.equal(m.get('phish').score, 5);    // pinned ×5
  assert.equal(m.get('dead-co').score, 5);
});

test('computeArtistAffinities single-signal: plays only', () => {
  const hist = Array.from({ length: 10 }, () => ({ artistSlug: 'phish', artistName: 'Phish' }));
  const m    = computeArtistAffinities({ history: hist });
  assert.equal(m.get('phish').score, 5);    // 10 × 0.5
  assert.equal(m.get('phish').signals.plays, 10);
});

test('computeArtistAffinities blended weights: attended outweighs casual plays', () => {
  // Phish: 1 attended (×3 = 3) + 4 plays (×0.5 = 2) → 5
  // Dead:  20 plays (×0.5 = 10), no attended → 10
  // So Dead wins on score even though Phish has the rarer attended signal.
  const m = computeArtistAffinities({
    attended: [{ artistSlug: 'phish', artistName: 'Phish', date: '2024-07-04' }],
    history:  [
      ...Array(4).fill({ artistSlug: 'phish',   artistName: 'Phish' }),
      ...Array(20).fill({ artistSlug: 'dead-co', artistName: 'Dead & Co' }),
    ],
  });
  assert.equal(m.get('phish').score,   5);
  assert.equal(m.get('dead-co').score, 10);
});

test('computeArtistAffinities ignores entries without a slug', () => {
  const m = computeArtistAffinities({
    history:  [{ artistName: 'Unknown' }, { artistSlug: 'phish' }],
    attended: [{ }, { artistSlug: 'phish' }],
  });
  assert.equal(m.size, 1);
  assert.ok(m.has('phish'));
});

test('computeArtistAffinities recovers artist name from any signal', () => {
  const m = computeArtistAffinities({
    artistFavs: ['phish'],                                  // pinned has no name
    history:    [{ artistSlug: 'phish', artistName: 'Phish' }],
  });
  // Even though pinned was added first (no name), history backfills the name.
  assert.equal(m.get('phish').name, 'Phish');
});

/* ── formatAffinityReason ────────────────────────────────────────────────── */

test('formatAffinityReason returns null when signals are empty / missing', () => {
  assert.equal(formatAffinityReason(), null);
  assert.equal(formatAffinityReason({ name: 'Phish', signals: { attended: 0, plays: 0, pinned: 0, favShows: 0 } }), null);
});

test('formatAffinityReason picks attended-singular form', () => {
  assert.equal(
    formatAffinityReason({ name: 'Phish', signals: { attended: 1, plays: 0, pinned: 0, favShows: 0 } }),
    'You saw Phish live'
  );
});

test('formatAffinityReason picks attended-plural form', () => {
  assert.equal(
    formatAffinityReason({ name: 'Dead & Co', signals: { attended: 3, plays: 0, pinned: 0, favShows: 0 } }),
    'You attended Dead & Co 3×'
  );
});

test('formatAffinityReason prefers attended over plays when both present', () => {
  // attended×3=3 vs plays×0.5=2.5 → attended wins
  const r = formatAffinityReason({
    name: 'Phish',
    signals: { attended: 1, plays: 5, pinned: 0, favShows: 0 },
  });
  assert.equal(r, 'You saw Phish live');
});

test('formatAffinityReason falls back to plays when no attended', () => {
  assert.equal(
    formatAffinityReason({ name: 'Phish', signals: { attended: 0, plays: 12, pinned: 0, favShows: 0 } }),
    "You've played Phish 12×"
  );
});

test('formatAffinityReason picks pinned when it dominates', () => {
  // pinned×5=5 vs plays×0.5=4 → pinned wins
  assert.equal(
    formatAffinityReason({ name: 'Phish', signals: { attended: 0, plays: 8, pinned: 1, favShows: 0 } }),
    'Pinned: Phish'
  );
});
