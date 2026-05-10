/* ── personalization.js — taste-aware welcome page picks ─────────────────────
 *
 * Combines local signals (attended shows, listening history, pinned artists,
 * favorited shows) into per-artist affinity scores, then uses those scores
 * to pick a "Show of the Day for You" from the candidates a caller passes in.
 *
 * Architecture
 * ────────────
 * The math lives in `app/shared/helpers.js` as a pure function so it stays
 * unit-testable. This module is the impure shell — it reads the renderer
 * store, calls the Relisten API for fallback random picks, and returns a
 * structured pick the welcome view can render directly.
 *
 * Public API
 * ──────────
 *   getArtistAffinityList()            — sorted [{ slug, name, score, signals, reason }, …]
 *   pickPersonalizedSotd(today, pool)  — { show, artist, reason } | null
 *   hasEnoughSignal()                  — true when at least one artist has score > 0
 *
 * Why this lives in renderer (not shared): it touches `store` and `api`,
 * neither of which exist outside the browser context. The pure helpers it
 * leans on are isolated in shared/ for testing.
 * ────────────────────────────────────────────────────────────────────── */

import {
  computeArtistAffinities,
  formatAffinityReason,
  resolveShowArtist,
} from '../shared/helpers.js';
import { store, state } from './state.js';
import { api } from './api.js';

/** Read all four signal sources and produce a sorted affinity list. */
export function getArtistAffinityList() {
  const map = computeArtistAffinities({
    history:    store.getHistory(),
    attended:   store.getAttended(),
    artistFavs: store.getArtistFavs(),
    showFavs:   store.getFavs(),
  });
  const list = [];
  for (const [slug, v] of map) {
    list.push({
      slug,
      name:    v.name,
      score:   v.score,
      signals: v.signals,
      reason:  formatAffinityReason(v),
    });
  }
  list.sort((a, b) => b.score - a.score);
  return list;
}

/** Quick check — used to decide whether to show the toggle at all. */
export function hasEnoughSignal() {
  return getArtistAffinityList().some(a => a.score > 0);
}

/** Try to pick a personalized Show-of-the-Day from a candidate pool
 *  (typically the trending list, already fetched for the global SOTD).
 *
 *  Algorithm:
 *    1. Compute affinity, take top N artists with score > 0.
 *    2. Filter candidates to shows by those artists. If non-empty, pick
 *       one deterministically by today's date (so the same user sees the
 *       same pick all day, but it changes tomorrow).
 *    3. If no candidates match: pick the top-affinity artist and fall
 *       back to api.random(slug) for that artist.
 *    4. Return null on total failure — caller should fall back to
 *       global pick gracefully.
 *
 *  Returns: { show, artist, reason } | null */
export async function pickPersonalizedSotd(todayISO, candidatePool = []) {
  const affinityList = getArtistAffinityList().filter(a => a.score > 0);
  if (!affinityList.length) return null;

  // Top N — keep small so the daily seed actually picks meaningfully.
  const TOP_N = 5;
  const top   = affinityList.slice(0, TOP_N);
  const slugs = new Set(top.map(a => a.slug));

  // ── Path A: filter the existing pool to top-affinity artists ─────────
  const matches = (candidatePool ?? []).filter(s => {
    const a = resolveShowArtist(s, state.artists);
    return a?.slug && slugs.has(a.slug);
  });

  if (matches.length) {
    // Deterministic by date — same user sees same pick all day.
    const seed = parseInt(todayISO.replace(/-/g, '').slice(-4), 10) || 0;
    const show = matches[seed % matches.length];
    const artist = resolveShowArtist(show, state.artists);
    const aff    = top.find(a => a.slug === artist.slug);
    return {
      show,
      artist,
      reason: aff?.reason ?? null,
    };
  }

  // ── Path B: random pick from the top-affinity artist ────────────────
  // Cycle through top artists so we don't always hit the same one if its
  // /random endpoint flakes.
  for (const aff of top) {
    try {
      const show = await api.random(aff.slug);
      if (!show) continue;
      const artist = state.artists.find(a => a.slug === aff.slug)
                  ?? { slug: aff.slug, name: aff.name };
      return {
        show,
        artist,
        reason: aff.reason,
      };
    } catch {
      // try next artist
    }
  }
  return null;
}
