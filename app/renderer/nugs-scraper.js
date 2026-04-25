/* ── nugs-scraper.js — ghost-scraper DOM parser for nugs.net ───────
   nugs.net uses React SSR with Cloudflare bot protection.  All page
   fetches are delegated to the Main process ghost scraper (a hidden
   BrowserWindow) via window.ipc.scrapeNugsHtml().  Because the ghost
   window is a real Chromium browser on the shared session it:
     • solves Cloudflare JS challenges transparently
     • carries any nugs.net login cookies automatically
     • is never blocked by the WAF that rejects plain fetch() calls

   Selector strategy: nugs.net hashes React class names, so we rely
   on STRUCTURAL selectors (href patterns, img+a proximity) rather
   than class-name matching.  If nothing is found the raw body HTML
   is logged to the console so you can inspect what the ghost returned.
   ─────────────────────────────────────────────────────────────────── */

import { nugsAuth } from './state.js';

const BASE     = 'https://play.nugs.net';
const WWW_BASE = 'https://www.nugs.net'; // kept for image URL resolution only

/* ── Core fetch helpers ─────────────────────────────────────────── */
async function fetchPage(url) {
  const result = await window.ipc.scrapeNugsHtml(url);
  if (!result?.ok) {
    throw new Error(result?.error ?? `ghost scrape failed for ${url}`);
  }
  return result.html;
}

// fetchFull returns the entire result object so callers can access .artists/.stashItems JSON
async function fetchFull(url) {
  const result = await window.ipc.scrapeNugsHtml(url);
  if (!result?.ok) {
    throw new Error(result?.error ?? `ghost scrape failed for ${url}`);
  }
  return result; // { ok, html, artists?, stashItems? }
}

/* ── DOM helpers ────────────────────────────────────────────────── */
function parseDoc(html) {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** Resolve a possibly-relative URL to an absolute nugs.net URL. */
function abs(href) {
  if (!href) return '';
  if (href.startsWith('http')) return href;
  return BASE + (href.startsWith('/') ? href : '/' + href);
}

/** Extract the best image src from an element or its children. */
function extractImg(el) {
  const img = el.querySelector('img');
  if (img) return img.dataset.src || img.src || img.dataset.lazySrc || '';
  const style = el.getAttribute('style')
    ?? el.querySelector('[style]')?.getAttribute('style') ?? '';
  const m = style.match(/url\(['"]?([^'")]+)['"]?\)/);
  return m ? abs(m[1]) : '';
}

/** Try a list of selectors; return text from the first match. */
function extractText(el, selectors) {
  for (const sel of selectors) {
    const found = el.querySelector(sel);
    if (found?.textContent?.trim()) return found.textContent.trim();
  }
  return '';
}

/* ── Artist ID resolver ─────────────────────────────────────────── */
// Extracts the numeric Nugs artist ID needed to call nugsApi.catalog().
// Results are cached in a module-level Map so repeated clicks cost nothing.
const _artistIdCache = new Map();

export async function resolveArtistId(linkUrl) {
  if (_artistIdCache.has(linkUrl)) return _artistIdCache.get(linkUrl);

  const cache = id => { _artistIdCache.set(linkUrl, id); return id; };

  // Fast path: numeric ID already embedded in the URL itself
  // Covers play.nugs.net/artist/123, www.nugs.net/artist/123, ?artistId=123
  const urlId =
    linkUrl.match(/\/artist\/(\d+)/)?.[1] ??
    linkUrl.match(/[?&]artistId=(\d+)/i)?.[1] ??
    linkUrl.match(/artistList=(\d+)/i)?.[1];
  if (urlId) return cache(urlId);

  try {
    const html    = await fetchPage(linkUrl);
    const doc     = parseDoc(html);
    const scripts = [...doc.querySelectorAll('script')]
      .map(s => s.textContent).join('\n');

    // "artistId":12345  or  "artist_id":12345
    const m1 = scripts.match(/"artist(?:Id|_id|ID)"\s*:\s*(\d+)/i);
    if (m1) return cache(m1[1]);

    // artistId=12345 anywhere in script content
    const m2 = scripts.match(/[&?]?artistId=(\d+)/i)
            ?? scripts.match(/artistList=(\d+)/i);
    if (m2) return cache(m2[1]);

    // data-artist-id / data-artistid attribute
    const attrEl = doc.querySelector('[data-artist-id],[data-artistid]');
    if (attrEl) {
      const id = attrEl.dataset.artistId ?? attrEl.dataset.artistid;
      if (id) return cache(id);
    }

    // /artist/12345 in any page link
    for (const a of doc.querySelectorAll('a[href*="/artist/"]')) {
      const m = a.getAttribute('href').match(/\/artist\/(\d+)/);
      if (m) return cache(m[1]);
    }

    // Not found — log for debugging
    console.warn('[nugs-scraper] resolveArtistId: no ID found for', linkUrl);
    console.warn('[nugs-scraper] page scripts (first 3000):', scripts.slice(0, 3000));
    return cache(null);
  } catch (e) {
    console.error('[nugs-scraper] resolveArtistId failed:', e.message);
    return null;
  }
}

/* ── Structural card extractor — img + a proximity ─────────────── */
// Finds containers that have BOTH an <img> AND an <a href>, skipping
// nav/header/footer chrome.  Falls back to bare <a>+<img> links.
function extractStructuralCards(doc, isLive) {
  const SKIP = 'nav, header, footer, .nav, .header, .footer, .menu, .breadcrumb';
  const TEXT_SELS = ['h1','h2','h3','h4','h5','.title','[class*="title"]','.name','[class*="name"]'];
  const ART_SELS  = ['.artist','[class*="artist"]','.performer','.band','.subtitle'];
  const DATE_SELS = ['.date','time','[datetime]','[class*="date"]'];

  // Candidate containers: structural block-level elements with both img & a
  const candidates = [
    ...doc.querySelectorAll(
      'li, article, [class*="card"], [class*="item"], ' +
      '[class*="show"], [class*="event"], [class*="product"], [class*="tile"]'
    ),
  ].filter(el =>
    !el.closest(SKIP) &&
    el.querySelector('img') &&
    el.querySelector('a[href]')
  );

  if (candidates.length) {
    return candidates.map(el => {
      const a = el.querySelector('a[href]');
      return {
        title:    extractText(el, TEXT_SELS) || 'Show',
        artist:   extractText(el, ART_SELS),
        date:     extractText(el, DATE_SELS),
        imageUrl: el.querySelector('img')?.src
               ?? el.querySelector('img')?.dataset?.src ?? '',
        linkUrl:  abs(a?.getAttribute('href') ?? ''),
        isLive,
      };
    }).filter(c => c.linkUrl && c.linkUrl !== BASE + '/');
  }

  // Fallback: <a> tags that directly wrap or contain an <img>
  const links = [...doc.querySelectorAll('a[href]')]
    .filter(a => !a.closest(SKIP) && a.querySelector('img'));

  return links.map(a => ({
    title:    (a.getAttribute('title')
           ?? a.getAttribute('aria-label')
           ?? extractText(a, TEXT_SELS)
           ?? a.textContent.trim().slice(0, 80))
           || 'Show',
    artist:   '',
    date:     '',
    imageUrl: a.querySelector('img')?.src ?? '',
    linkUrl:  abs(a.getAttribute('href') ?? ''),
    isLive,
  })).filter(c => c.linkUrl && c.linkUrl !== BASE + '/');
}

/* ── Public scrapers ────────────────────────────────────────────── */

/** Deduplicate a card array by linkUrl so the same show never appears twice. */
function dedupeByUrl(cards) {
  const seen = new Map();
  for (const card of cards) {
    const key = card.linkUrl?.split('?')[0] ?? '';   // strip query string for key
    if (key && !seen.has(key)) seen.set(key, card);
  }
  return [...seen.values()];
}

export async function scrapeLive() {
  // play.nugs.net /watch — the dedicated web player live/VOD hub
  const html    = await fetchPage(`${BASE}/watch`);
  const doc     = parseDoc(html);
  const raw     = extractStructuralCards(doc, true);
  const results = dedupeByUrl(raw);

  if (!results.length) {
    console.warn('[nugs-scraper] scrapeLive: 0 results. Body HTML (first 6000):');
    console.warn(doc.body?.innerHTML?.slice(0, 6000));
  } else {
    console.info(`[nugs-scraper] scrapeLive: ${results.length} unique shows (${raw.length} raw)`);
  }
  return results;
}

export async function scrapeRecent() {
  // play.nugs.net /watch/livestreams/recent — the dedicated recent livestreams page.
  const html    = await fetchPage(`${BASE}/watch/livestreams/recent`);
  const doc     = parseDoc(html);
  const raw     = extractStructuralCards(doc, false);
  const results = dedupeByUrl(raw);

  if (!results.length) {
    console.warn('[nugs-scraper] scrapeRecent: 0 results. Body HTML (first 6000):');
    console.warn(doc.body?.innerHTML?.slice(0, 6000));
  } else {
    console.info(`[nugs-scraper] scrapeRecent: ${results.length} unique shows (${raw.length} raw)`);
  }
  return results;
}

export async function scrapeStash() {
  // play.nugs.net /library/ is the new My Library hub.
  // Ghost window does a full scroll+harvest and returns result.stashItems JSON.
  // We fall through to HTML parse only if stashItems is absent.
  const urls = [
    `${BASE}/library/livestreams`, // primary — video/live recordings
    `${BASE}/library/audio`,       // audio recordings
    `${BASE}/library`,             // root library (may redirect)
    `${WWW_BASE}/stash/`,          // legacy storefront fallback
  ];

  let result = null, lastErr = null;
  for (const url of urls) {
    try { result = await fetchFull(url); break; }
    catch (e) { lastErr = e; }
  }
  if (!result) throw lastErr ?? new Error('nugs-scraper: stash page not found');

  // ── Fast path: ghost returned scroll-harvest JSON ────────────────────
  if (Array.isArray(result.stashItems) && result.stashItems.length > 0) {
    console.info(`[nugs-scraper] scrapeStash: ${result.stashItems.length} items from scroll-harvest`);
    const cards = result.stashItems.map(item => ({
      title:    item.title || item.artist || 'Show',
      artist:   item.artist ?? '',
      date:     item.date   ?? '',
      venue:    item.venue  ?? '',
      imageUrl: item.imageUrl ?? '',
      linkUrl:  item.linkUrl  ? abs(item.linkUrl) : '',
      isLive:   false,
    })).filter(c => c.linkUrl);
    return dedupeByUrl(cards);
  }

  // ── HTML fallback: parse the snapshot ───────────────────────────────
  const html = result.html ?? '';
  if (!html) {
    console.warn('[nugs-scraper] scrapeStash: no stashItems and no HTML snapshot');
    return [];
  }
  const doc = parseDoc(html);

  // ── Parse confirmed .stash-grid-item cards ───────────────────────────
  const items = [...doc.querySelectorAll('.stash-grid-item')];
  if (items.length > 0) {
    console.info(`[nugs-scraper] scrapeStash: ${items.length} .stash-grid-item elements (HTML snapshot)`);
    const cards = items.map(item => {
      const title    = item.querySelector('.showtitle-st')?.textContent?.trim()     ?? '';
      const artist   = item.querySelector('.grid-artist-name')?.textContent?.trim() ?? '';
      const date     = item.querySelector('.grid-launch-date')?.textContent?.trim() ?? '';
      const venue    = item.querySelector('.grid-venue')?.textContent?.trim()       ?? '';
      const img      = item.querySelector('img');
      const imageUrl = img?.src ?? img?.dataset?.src ?? '';
      const a        = item.querySelector('a[href]');
      const linkUrl  = a ? abs(a.getAttribute('href') ?? '') : '';
      return { title: title || artist, artist, date, venue, imageUrl, linkUrl, isLive: false };
    }).filter(c => c.linkUrl);
    return dedupeByUrl(cards);
  }

  // ── Fallback: generic structural card extractor ──────────────────────
  console.warn('[nugs-scraper] scrapeStash: no .stash-grid-item found — using generic extractor');
  const results = dedupeByUrl(extractStructuralCards(doc, false));
  if (!results.length) {
    console.warn('[nugs-scraper] scrapeStash: 0 results. Body HTML (first 6000):');
    console.warn(doc.body?.innerHTML?.slice(0, 6000));
  }
  return results;
}

/** Convert a URL slug like "billy-strings-concerts-live-downloads-…" into "Billy Strings" */
function nameFromSlug(href) {
  // Strip leading slash, grab the first path segment
  const seg = href.replace(/^\//, '').split('/')[0];
  // Remove the long nugs suffix (and any trailing slug segments)
  const stripped = seg
    .replace(/-concerts-live-downloads[\w-]*/i, '')
    .replace(/-+$/, '');
  if (!stripped) return '';
  // Title-case each word
  return stripped
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Detect whether the scraped page looks like a logged-out / login-wall page.
 *  Returns true if we see a "Sign In" / "Log In" call-to-action but NO user
 *  profile indicator (avatar, "My Account", username element, etc.).         */
function detectLoginRequired(doc) {
  const bodyText = doc.body?.textContent?.toLowerCase() ?? '';
  const hasLoginCta = (
    doc.querySelector('a[href*="/login"], a[href*="/sign-in"], button[data-action*="login"]') !== null ||
    /\b(sign in|log in|login)\b/.test(bodyText)
  );
  const hasProfile = (
    doc.querySelector(
      '[class*="avatar"], [class*="user-nav"], [class*="account"], ' +
      '[class*="profile"], [aria-label*="account"], [aria-label*="profile"]'
    ) !== null ||
    /\b(my stash|my library|my account|log out|sign out)\b/.test(bodyText)
  );
  return hasLoginCta && !hasProfile;
}


export async function scrapeArtists() {
  // Kept for legacy callers — now delegates to the '#' letter page
  // (which covers all artists on a fresh /browse/artists/ load).
  // Primary entry point for the sidebar is scrapeArtistsByLetter().
  const result = await fetchFull(`${BASE}/browse/artists/`);

  // ── Fast path: ghost returned pre-extracted JSON ──────────────────────
  if (Array.isArray(result.artists) && result.artists.length > 10) {
    console.info(`[nugs-scraper] scrapeArtists: ${result.artists.length} artists from tab-iteration`);
    // Still run login detection on whatever HTML snippet was captured
    const snapDoc = parseDoc(result.html || '');
    if (detectLoginRequired(snapDoc)) {
      console.warn('[nugs-scraper] scrapeArtists: login wall detected (fast path)');
      return { loginRequired: true, artists: [] };
    }
    return dedupeByUrl(result.artists).sort((a, b) => a.name.localeCompare(b.name));
  }

  // ── HTML fallback: parse the snapshot with confirmed 2026 selectors ───
  const html = result.html ?? '';
  const doc  = parseDoc(html);

  // ── Login detection — show a friendly message instead of returning [] ─────
  if (detectLoginRequired(doc)) {
    console.warn('[nugs-scraper] scrapeArtists: login wall detected');
    // Return a sentinel object the caller can identify
    return { loginRequired: true, artists: [] };
  }

  const allLinks = [...doc.querySelectorAll('a[href]')];
  console.info(`[nugs-scraper] scrapeArtists: total <a href> in page: ${allLinks.length}`);

  // Log a sample of hrefs so we can see the actual URL patterns in the console
  const hrefSample = [...new Set(allLinks.map(a => a.getAttribute('href') ?? '').filter(Boolean))]
    .slice(0, 40);
  console.info('[nugs-scraper] href sample:', hrefSample);

  // ── AGGRESSIVE MATCHER ───────────────────────────────────────────────────
  // Rule: ANY link whose href contains "-concerts-live-downloads" is an artist
  // page. Nugs wraps each artist card in 1-2 <a> tags (one for the image, one
  // for the name). We deduplicate by URL slug so both map to one entry.
  //
  // Fallbacks (in order):
  //   1. Legacy /artist/<slug> or /artist/<id>
  //   2. Demandware URLs mentioning 'artist'
  //   3. Grid/tile container membership

  const SKIP_SEL = 'nav, header, footer, .breadcrumb, .nav, [class*="footer"], [class*="header"]';
  const ARTIST_CONTAINER_SEL =
    '[class*="artist-tile"], [class*="artist-grid"], [class*="artist-card"], ' +
    '[class*="alphabetical"], [class*="directory"], [class*="ArtistTile"], ' +
    '[class*="ArtistGrid"], [class*="AlphaList"]';

  let artistLinks = allLinks.filter(a => {
    const href = a.getAttribute('href') ?? '';
    if (href.includes('-concerts-live-downloads'))                               return true;
    if (/^\/artist\/[^/]+/.test(href) || /\/artist\/\d+/.test(href))            return true;
    if (href.includes('/on/demandware.store/') && /artist/i.test(href))         return true;
    if (a.closest(ARTIST_CONTAINER_SEL))                                         return true;
    return false;
  }).filter(a => !a.closest(SKIP_SEL));

  console.info(`[nugs-scraper] pass-1 (aggressive): ${artistLinks.length} candidate links`);

  // ── Pass 2: broad content-area scan (only if pass 1 finds nothing) ────────
  if (!artistLinks.length) {
    console.warn('[nugs-scraper] pass-1 empty — falling back to broad content scan…');
    const contentRoot =
      doc.querySelector('main, #main-content, [class*="main-content"], [role="main"]') ??
      doc.querySelector('#root, #app, [class*="app-"], [class*="container"]') ??
      doc.body;
    console.info(`[nugs-scraper] content root: ${contentRoot?.tagName} .${contentRoot?.className?.slice(0, 60)}`);
    artistLinks = [...contentRoot.querySelectorAll('a[href]')].filter(a => {
      if (a.closest(SKIP_SEL)) return false;
      const href = a.getAttribute('href') ?? '';
      return (
        href.startsWith('/') && href.length > 1 &&
        !/^\/(cart|checkout|login|account|faq|help|contact|search|terms|privacy)/i.test(href)
      );
    });
    console.info(`[nugs-scraper] pass-2 (broad): ${artistLinks.length} candidates`);
  }

  if (!artistLinks.length) {
    console.warn('[nugs-scraper] BOTH passes empty. Full body HTML (first 8000):');
    console.warn(doc.body?.innerHTML?.slice(0, 8000));
    return [];
  }

  // ── Deduplicate by URL SLUG (not full href) ───────────────────────────────
  // Nugs often emits 2 <a> per artist (image link + text link) with the same
  // href. Dedup by the first path segment so we get exactly one entry per band.
  const seenSlug = new Set();
  const artists  = [];

  for (const a of artistLinks) {
    const href = a.getAttribute('href') ?? '';
    // Normalise: strip query string + trailing slash, take first path segment
    const slug = href.split('?')[0].replace(/\/$/, '').split('/').filter(Boolean)[0] ?? href;
    if (seenSlug.has(slug)) continue;
    seenSlug.add(slug);

    // Name: aria-label → title attr → innerText → parsed from URL slug (fallback)
    let name =
      a.getAttribute('aria-label')?.trim() ||
      a.getAttribute('title')?.trim()       ||
      a.textContent?.trim().replace(/\s+/g, ' ') ||
      '';

    // Strip the long nugs suffix from innerText if it leaked through
    name = name.replace(/\s*-?\s*concerts\s+live\s+downloads[\w\s-]*/i, '').trim();

    // Last resort: reconstruct from the URL slug
    if (!name || name.length < 2 || name.length > 120) {
      name = nameFromSlug(href);
    }
    if (!name || name.length < 2) continue;

    // Image: look in the <a> itself, then walk up to the nearest card ancestor
    let imageUrl = '';
    const directImg = a.querySelector('img');
    if (directImg) {
      imageUrl = directImg.dataset.src || directImg.src || '';
    } else {
      const card = a.closest('li, article, [class*="card"], [class*="item"]') ?? a.parentElement;
      const cardImg = card?.querySelector('img');
      if (cardImg) imageUrl = cardImg.dataset.src || cardImg.src || '';
    }

    artists.push({ name, imageUrl, linkUrl: abs(href) });
  }

  console.info(`[nugs-scraper] scrapeArtists: ${artists.length} unique artists extracted`);
  return artists.sort((a, b) => a.name.localeCompare(b.name));
}

/* ── Resolve a nugs show/product page URL to a container ID ─────── */
export function extractContainerId(linkUrl) {
  const patterns = [
    /[?&]cid=(\d+)/,
    /\/container[- _]?(\d+)/i,
    /\/p\/[^/]+\/[^/]+-(\d+)/,
    /\/(\d{5,})\/?$/,
    /-(\d{5,})(?:[?#]|$)/,
  ];
  for (const re of patterns) {
    const m = linkUrl.match(re);
    if (m) return m[1];
  }
  return null;
}
