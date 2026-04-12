/* ── nugs-scraper.js — authenticated DOM scraper for nugs.net ──────
   nugs.net uses React SSR — no clean JSON endpoints for the browse
   pages we need.  We fetch the rendered HTML using the user's active
   Electron session credentials plus the stored OAuth bearer token,
   then parse with DOMParser to extract card data.

   Each scraper returns an array of NugsCard objects:
   {
     title:    string,
     artist:   string,
     date:     string,
     imageUrl: string,
     linkUrl:  string,     // href on the card
     isLive:   boolean,
   }

   Selector strategy: nugs.net ships React SSR so class names may be
   hashed. We try several common patterns in order and take the first
   that yields results. The caller should handle empty arrays gracefully.
   ─────────────────────────────────────────────────────────────────── */

import { nugsAuth } from './state.js';

const BASE = 'https://www.nugs.net';

/* ── Core fetch helper ──────────────────────────────────────────── */
async function fetchPage(url) {
  const auth = nugsAuth.get();
  const headers = {
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control':   'no-cache',
  };
  // Attach bearer token so SSR sees us as authenticated
  if (auth?.access_token) {
    headers['Authorization'] = `Bearer ${auth.access_token}`;
  }

  const r = await fetch(url, {
    credentials: 'include', // send any Electron session cookies too
    headers,
  });

  if (!r.ok) throw new Error(`nugs-scraper: HTTP ${r.status} for ${url}`);
  return r.text();
}

/* ── DOM helpers ────────────────────────────────────────────────── */
function parseDoc(html) {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** Try a list of selectors, return elements from the first that matches. */
function trySelectors(doc, selectors) {
  for (const sel of selectors) {
    const nodes = [...doc.querySelectorAll(sel)];
    if (nodes.length) return nodes;
  }
  return [];
}

/** Resolve a possibly-relative URL to an absolute nugs.net URL. */
function abs(href) {
  if (!href) return '';
  if (href.startsWith('http')) return href;
  return BASE + (href.startsWith('/') ? href : '/' + href);
}

/** Extract the best image src from a card element. */
function extractImg(el) {
  // Try <img>, then background-image style, then data-src (lazy-load)
  const img = el.querySelector('img');
  if (img) return img.dataset.src || img.src || img.dataset.lazySrc || '';
  const style = el.getAttribute('style') ?? el.querySelector('[style]')?.getAttribute('style') ?? '';
  const m = style.match(/url\(['"]?([^'")]+)['"]?\)/);
  return m ? abs(m[1]) : '';
}

/** Extract visible text from several fallback selectors. */
function extractText(el, selectors) {
  for (const sel of selectors) {
    const found = el.querySelector(sel);
    if (found?.textContent?.trim()) return found.textContent.trim();
  }
  return '';
}

/* ── Card extractor — shared logic ─────────────────────────────── */
function extractCards(doc, isLive = false) {
  // nugs.net uses several layouts. Try the most common card wrappers.
  const cardSels = [
    'article.product-card',
    '.product-item',
    '.card--product',
    '[class*="ProductCard"]',
    '[class*="product-card"]',
    '[class*="ShowCard"]',
    '[class*="show-card"]',
    '[class*="EventCard"]',
    '[class*="event-card"]',
    '.product',              // older nugs layout
    'li.product',
    '.catalogue-grid-item',
    '[data-product-id]',
    '[data-container-id]',
  ];

  const titleSels   = ['h2','h3','h4','.title','[class*="title"]','[class*="Title"]','.name'];
  const artistSels  = ['.artist','[class*="artist"]','[class*="Artist"]','.performer','.band','.subtitle'];
  const dateSels    = ['.date','[class*="date"]','time','[class*="Date"]','.show-date','.performance-date'];

  const cards = trySelectors(doc, cardSels);

  return cards.map(card => {
    const linkEl  = card.closest('a') ?? card.querySelector('a');
    const linkUrl = abs(linkEl?.getAttribute('href') ?? '');
    const title   = extractText(card, titleSels)   || 'Untitled';
    const artist  = extractText(card, artistSels)  || '';
    const date    = extractText(card, dateSels)    || '';
    const imageUrl = extractImg(card);

    return { title, artist, date, imageUrl, linkUrl, isLive };
  }).filter(c => c.title !== 'Untitled' || c.imageUrl);
}

/* ── Public scrapers ────────────────────────────────────────────── */

export async function scrapeLive() {
  const html = await fetchPage(`${BASE}/live-music-webcasts/`);
  const doc  = parseDoc(html);

  // Live pages sometimes show events in a calendar/list, not product cards
  const eventSels = [
    '[class*="LiveEvent"]',
    '[class*="live-event"]',
    '[class*="Webcast"]',
    '[class*="webcast"]',
    '.upcoming-show',
    '.live-show',
  ];
  const events = trySelectors(doc, eventSels);
  if (events.length) {
    return events.map(el => {
      const a = el.querySelector('a');
      return {
        title:    extractText(el, ['h2','h3','h4','.title','[class*="title"]']) || 'Live Webcast',
        artist:   extractText(el, ['.artist','[class*="artist"]','.performer']),
        date:     extractText(el, ['.date','time','[class*="date"]','.when']),
        imageUrl: extractImg(el),
        linkUrl:  abs(a?.getAttribute('href') ?? ''),
        isLive:   true,
      };
    });
  }

  // Fallback to generic card extraction
  return extractCards(doc, true);
}

export async function scrapeRecent() {
  const html = await fetchPage(`${BASE}/recent-exclusive-audio/`);
  return extractCards(parseDoc(html), false);
}

export async function scrapeStash() {
  // Try common stash/library URLs
  const urls = [
    `${BASE}/my-stash/`,
    `${BASE}/my-library/`,
    `${BASE}/my-collection/`,
  ];

  let html = null;
  let lastErr = null;
  for (const url of urls) {
    try { html = await fetchPage(url); break; }
    catch (e) { lastErr = e; }
  }
  if (!html) throw lastErr ?? new Error('nugs-scraper: stash page not found');

  return extractCards(parseDoc(html), false);
}

/* ── Resolve a nugs page link to a playable stream URL ─────────── */
// nugs.net show/product pages contain the containerID in the URL or
// in JSON-LD / data attributes.  We extract it so views-nugs can
// call nugsApi.catalog() or nugsApi.streamUrl() appropriately.
export function extractContainerId(linkUrl) {
  // URLs like /p/artist-name/container-12345  or ?cid=12345  or /12345/
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
