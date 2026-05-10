# Days Between

A desktop app for streaming live concert recordings from [Relisten](https://relisten.net) and [nugs.net](https://nugs.net) — 70,000+ shows from Grateful Dead, Phish, and hundreds more.

Built with Electron, no bundler. All your data stays local on your machine.

![Days Between screenshot](assets/icon.png)

---

## Download

Grab the latest installer from the [**Releases page**](https://github.com/DeceasedCranium/days-between/releases/latest) — no account required.

| Platform | File | Notes |
|----------|------|-------|
| macOS (Apple Silicon) | `.dmg` | Open DMG, drag to Applications |
| Windows | `Days Between Setup …exe` (installer) or `Days Between …exe` (portable) | Run the installer |
| Linux | `.AppImage` | `chmod +x`, then run |
| Linux (Debian/Ubuntu) | `.deb` | `sudo dpkg -i` |

> **No Electron installation required** — the installers bundle everything.

---

## Features

### Playback
- **Relisten + nugs.net** — Browse and stream HLS and direct MP3/FLAC recordings
- **Gapless playback** — Dual-buffer crossfade engine swaps audio elements seamlessly between tracks
- **5-band graphic EQ** — Boost or cut 60 Hz, 250 Hz, 1 kHz, 4 kHz, 12 kHz; bypass toggle; settings persisted across sessions
- **Chromecast** — Cast audio and video to any Cast device on your network
- **HLS streaming** — via hls.js with automatic fallback

### nugs.net Integration
- **Live Hub** — Browse live and upcoming webcasts; stream HLS video directly in the app
- **Recent Livestreams** — One-click access to the latest nugs.net video releases; video shows auto-play inline, audio recordings navigate to the full track list
- **My Library / Stash** — Access your purchased and saved recordings
- **Inline video player** — Full hls.js video playback with Fullscreen and **Cast to TV** buttons
- **Search & Pin sidebar** — Instant artist search (no page loads); pin favourite artists for quick access; pinned artists shown by default
- **Nugs global search** — Artist name search surfaced alongside Relisten results

### Discovery
- **Artist / Year / Show / Track** browsing with full-text search
- **On This Day** — every show played on today's date, any year
- **Trending & Recent** — community-popular shows surfaced from the Relisten API
- **Artist Radio** — auto-queues related artists when your queue ends
- **Decades view** — browse by era (60s, 70s, 80s…)

### Personal Library
- **Saved shows** — heart any show to bookmark it
- **Listening history** — every track you've played
- **Tapes** — custom playlists you build manually
- **Stats** — plays, artists, hours listened
- **Last.fm scrobbling** — connect your account in Settings
- **Local archival** — ⬇ Download Show button on any release saves the full
  setlist plus cover art to `~/Music/Days Between/<Artist>/<Date - Venue>/`.
  Sequential downloads with randomized human-cadence delays, persistent
  bottom-right progress pill, and (for Nugs) auto-pause/resume of live
  playback to respect the single-active-stream policy

### Interface
- **Glass UI** — frosted-glass sidebar, titlebar, and floating player bar with backdrop-filter blur; transparent Electron window for native compositor integration
- **8 themes** — Dark, Cinema, Midnight, Dusk, Slate, Amber, Forest, Light
- **Accent colours** — 10 presets that override any theme's highlight colour
- **Comfortable / Compact density** — toggle in Settings
- **Mini player** — compact always-on-top mode pinned near the system tray
- **Now Playing overlay** — full setlist with song times
- **Queue panel** — reorder, shuffle, repeat

---

## Requirements

**Pre-built installers** — no extra dependencies. Download from the [Actions tab](https://github.com/DeceasedCranium/days-between/actions) and run the installer for your platform.

**Running from source** requires:
- [Node.js](https://nodejs.org/) 22+
- The Electron binary that `npm install` pulls (currently 41) — bundled, no system dependency
- Native ES modules; no bundler step

---

## Setup

### From source (development)

```bash
git clone https://github.com/DeceasedCranium/days-between.git
cd days-between
npm install

# Optional — needed for Last.fm scrobbling, Artist Radio, and
# setlist.fm authoritative play counts. The app boots fine without it
# (those features just stay dormant).
cp config.example.js config.js
# Edit config.js and add your API keys (links inside the file).

npm start
```

### Build installers locally

```bash
npm run dist
# Output: dist/  (DMG / EXE / AppImage+deb depending on your platform)
```

### Last.fm

Scrobbling and Artist Radio require a Last.fm API key. Get one free at [last.fm/api/account/create](https://www.last.fm/api/account/create) and add it to `config.js`. The app works without it — only these two features are disabled.

### nugs.net

Requires an active nugs.net subscription. Sign in from **Settings → Nugs.net**. The app authenticates with your own credentials and does not store or share your password beyond the session token.

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `[ / ]` | Previous / Next track |
| `← / →` | Seek back / forward 15 s |
| `Shift ← / →` | Seek back / forward 60 s |
| `↑ / ↓` | Volume up / down |
| `S` | Toggle shuffle |
| `R` | Cycle repeat (off → one → all) |
| `Ctrl+E` | Toggle EQ bypass |
| `Alt ← / →` | Navigate back / forward |
| `/` | Global search |
| `Q` | Toggle queue |
| `M` | Mini player |
| `?` | Keyboard shortcuts reference |
| `Esc` | Close overlay |

---

## Data & Privacy

All user data is stored locally — nothing leaves your machine:

| Data | Storage |
|------|---------|
| Listening history, saved shows, tapes, notes | IndexedDB (via localforage) |
| Settings (theme, EQ bands, density…) | IndexedDB (via localforage) |
| Last.fm session token | IndexedDB (via localforage) |
| nugs.net session token | IndexedDB (via localforage) |

Legacy data from `localStorage` is automatically migrated to IndexedDB on first launch of v1.1+.

No telemetry, no accounts, no cloud sync.

---

## Architecture Notes

- **Native ES modules** — no webpack/vite; Electron loads `app.js` as `type="module"` directly
- **Audio engine** (`audio-engine.js`) — dual-buffer gapless with element-swap crossfade; event-routing proxy so listener bindings survive primary/staging swaps
- **EQ engine** (`eq-engine.js`) — singleton `AudioContext`; both audio elements permanently connected to the same 5-node peaking BiquadFilter chain; virtual bypass (gains → 0 dB, nodes stay connected)
- **Storage** (`state.js`) — in-memory cache with synchronous reads; async writes fire-and-forget to IndexedDB; v1.0 → v1.1 migration runs once on `loadAll()`
- **nugs API** (`api.js`) — pure JS fetch against `streamapi.nugs.net`; no ghost browser for stream resolution; ghost window used only for DOM scraping (live hub, library pages)
- **XSS hardening** — all template strings go through `safeInnerHTML()` (strips `on*` attributes and `javascript:` hrefs); dynamic user content always wrapped in `esc()`
- **CORS** — `crossorigin="anonymous"` on both `<audio>` elements; main-process `onHeadersReceived` injects `Access-Control-Allow-Origin: *` for archive.org audio and nugs image CDN; `onBeforeSendHeaders` injects `Referer`/`Origin`/`User-Agent` for nugs API, stream, and Akamai CDN requests

---

## Version History

| Version | Highlights |
|---------|-----------|
| **v1.14.0** | **Personalized Show of the Day.** The welcome page's daily pick stops treating every user as a fresh install. New `[For You] [Global]` pill toggle on the Show-of-the-Day card: **For You** picks from artists you actually care about (filtering today's trending pool to your top-affinity artists, falling back to a random show from your top artist if none match), **Global** is the original deterministic-trending behavior. Each card shows a small accent-tinted reason chip explaining *why* it was picked — `"You attended Dead & Co 3×"` / `"You've played Phish 47×"` / `"Pinned: Goose"` / `"🔥 Trending today"`. Affinity score blends four signals: attended shows ×3, pinned artists ×5, listening history ×0.5, favorited shows ×1; the dominant signal drives the chip text. Mode persists in localStorage; both modes cache today's pick separately so toggling is instant. Toggle stays hidden on a fresh install (no signal yet). New `app/renderer/personalization.js` module orchestrates the picker; pure math (`computeArtistAffinities`, `formatAffinityReason`) lives in `app/shared/helpers.js` with 13 new unit tests (82 total). **Sidebar layout fix**: replaced the fragile `height: calc(100vh - title - player)` with `height: 100%` inside its flex parent — eliminates a visible gap between the sidebar bottom and the player bar that drifted with DPR / scrollbar gutter. |
| **v1.13.0** | **setlist.fm live integration** — solves the long-running per-song undercount (Bertha showing 25 plays when the real number is 77+). Per-song stats card on the Relisten Songs tab now flips its primary tile from "Recorded shows" to setlist.fm's authoritative **"Total plays"**, with a `"N with Relisten recordings"` subtext preserving the gap and a `📋 Per setlist.fm` row underneath. New `app/renderer/setlistfm.js` API client: 600 ms-spaced rate limiter (under the free-tier 2 req/sec cap), 429 retry with 15 s backoff, paginated `/artist/{mbid}/setlists` walker with a 200-page safety cap, two-tier localforage cache (30-day MBID, 7-day song counts). Live progress UI ticks per-page during the first scan; subsequent song clicks for the same artist are instant. Uses Relisten's `musicbrainz_id` directly when present (skips the search step) and `/search/artists` only for sources like Nugs that don't carry MBIDs. New `aggregateSongCountsFromSetlists` pure helper dedupes within a single setlist and normalises titles consistently with the Relisten path; 4 new unit tests (69 total). API key plumbed via `config.js` → `config:setlistfm-key` IPC handler → `getSetlistFmKey` preload bridge → `initSetlistFm()` at renderer boot; integration is dormant when the key isn't configured (callers handle null gracefully). |
| **v1.12.0** | **Setlist Intelligence kickoff** — the start of the v2.0 reframing. Songs tabs land on both Relisten and Nugs artist pages with sortable Most Played / 🦄 Rarities views, filter input, and a 🎧 indicator next to songs heard at attended shows. Click a song → stats card with debut, last played, longest gap between plays, longest run of consecutive shows containing it, top venues, attended count, and a list of the best shows by rating with click-through to playback. **"I Was There" attendance** mirrored to the Nugs show detail page; the Library router opens Nugs entries via `nugsViewRelease` (with a small `nugs` badge) instead of falling through to Relisten. Title normalisation collapses canonical-name variants — "Bertha" / "Bertha >" / "Bertha ->" group into a single entry whose play count is the sum of all variants. Smarter scan matching splits composite tracks like "Bertha > Eyes of the World" into segments and exact-matches each, so Bertha plays register without false-matching unrelated substrings. **Setlist-scan fallback** for artists where Relisten's `/songs` endpoint is empty (Dead & Company is the canonical example) — the Songs tab walks every setlist and builds the catalog locally with a progress bar, cached per session. Catalog page-size for Nugs bumped 100→500 with per-page logging. **setlist.fm key plumbing** wired (config + IPC + stub module + boot init) — no live calls yet, foundation for v1.13's authoritative play counts. 15 new helper tests (65 total). |
| **v1.11.0** | Quality pass — no behaviour change beyond a preserved accent. Pure helpers (`sanitizeSegment`, `extFromUrl`, `trackFilename`, `nugsIsoDate`, `parseNugsDate`, `nugsContainerImage`, `sortByRecent`, `sortByPopular`, `applyNugsFilters`, `resolveShowArtist`, `compareVersions`) extracted into `app/shared/helpers.js` with no browser/Node deps. New `test/helpers.test.js` (42 tests via `node:test`) pins behaviour against the regression-prone API-shape changes from prior releases. `npm test` script + a CI gate (`release.yml` runs the suite before any build matrix job; bad helper code can no longer ship). `app/src/` (dead v1.0 code) removed. New `ARCHITECTURE.md` documents the trust boundaries, storage layer, audio engine, and how to add a feature. **Fix**: preset accent colour reset to default on every launch — `applyGlassTheme` was stripping the inline accent variable on boot and on every glass-slider adjustment; now `applyAccent` runs last on boot and re-applies after glass changes. |
| **v1.10.0** | Welcome page polish + global accent fix. **In-app update notifier** polls `api.github.com/repos/.../releases/latest` 4 seconds after launch and shows a dismissable badge in the bottom-right when a newer version is available. **Listening stats** appear at the bottom of the Relisten welcome page as a one-line strip (`X tracks · Y shows · Z artists · Nh listening`) plus a "Pick up where you left off" resume card; hidden when history is empty. Welcome page icon swapped from a placeholder "D" to the actual `assets/icon.svg`. **Accent respect**: every hardcoded orange (`#f0952c`/`#d4790e`) and red (`rgba(233,69,96,…)`) replaced with `var(--accent)` / `var(--accent2)` / `color-mix(in srgb, var(--accent) N%, transparent)` so the entire UI now retints live when you pick a new accent in Settings. |
| **v1.9.0** | Nugs welcome view rebuilt with four album-art rows: **Live & Recent Webcasts**, **Your Pinned Artists**, **Recently Added** (probes streamapi globally, falls back to a pool of recent containers across pinned artists with on-demand catalog pre-fetch), and **Discover Artists** (random catalog sample, ↻ Shuffle to reroll). Artist tile images use the artist's most recent release cover from the Nugs CDN — bypasses Wikipedia / Last.fm entirely so it works for niche jam-band artists too. Persistent (localStorage, 30-day TTL) Wikipedia/Last.fm cache + 4-at-a-time concurrency limiter for the Relisten side's image lookups. Race-safe loaders with token-based supersede + DOM re-query at write time. Subtle hover-only scrollbars on welcome rows. |
| **v1.8.0** | Nugs artist page overhaul to mirror the Relisten side. Three-tab navigation: **Recently Added** (sorted by `epochDateCreated` — Nugs's catalog-add timestamp), **Most Popular** (`salesAllTime` desc with `salesLast30` tiebreaker), and **By Year** (two-step: year-picker grid → year-detail with `← All years` back button + month/sort/Audio-Video filters). Vertical show list replaced with the album-cover grid styling shared by Relisten (`.show-cards`/`.show-card`); cover art now resolves through `nugsContainerImage()` using the Nugs CDN path `assets-01.nugscdn.net/livedownloads/images/shows/<file>?h=N` derived from `extImage` + `img.orderID` — fixes broken art on the show-detail hero too. Tab-hint subtitle explains which sort each tab applies. Fix Settings ✕ button leaving stale DOM when closed from a Nugs artist page (now restores source-pane visibility before `nav.back()`). Artist avatars deferred — `streamapi.catalog.artist` returns `NOT_AVAILABLE` and the `catalog.nugs.net` artist endpoint 404s; revisit when the play.nugs.net SPA's data flow is mapped. |
| **v1.7.2** | Extend the v1.7.1 artist-slug fix to the **Today** tab (`viewToday`), which had the same `s.artist_slug` direct-read pattern. Year-grouped OTD list now uses `resolveShowArtist()` and skips shows it can't resolve to a slug instead of rendering rows with empty data-slug. |
| **v1.7.1** | Fix 404 on Show of the Day, On This Day, Trending, and search-result clicks. The Relisten v3 trending endpoint only ships `artist_uuid` (no slug, no nested artist), and on-date nests it under `artist.slug` — the renderer was reading a flat `artist_slug` field that didn't exist on either, producing empty `data-slug` attributes and `/artists//shows/<date>` 404s. New `resolveShowArtist()` helper walks all three payload shapes and falls back to the cached artist list for uuid→slug. Plus a 3s wait on first welcome render so the lookup has `state.artists` populated. |
| **v1.7.0** | Main-process stabilisation pass. Lazy `getDownloadDir()` removes the boot race that could leave archival downloads with "directory not initialized". Ghost-scraper block (~660 lines) extracted from `main.js` into `app/nugs-scraper.js`. Per-scrape `AbortController` replaces the global `uncaughtException` swallow — "Object has been destroyed" races now exit polling loops cleanly instead of being silently suppressed. Subscription-gated nugs.net endpoints are captured directly via Chrome DevTools Protocol (`Network.getResponseBody`) and surfaced as `jsonResponses` in the scrape result, opt-in for the renderer parser. |
| **v1.6.2** | Fix Nugs auth UI showing "logged out" while streaming continued to work. `expires_at` now uses the JWT's real `exp` claim instead of a synthetic 10-hour window; Settings UI gates on token presence (`hasToken`) rather than the stricter `isValid` so a recoverable expiry doesn't flip the form to sign-in; refresh failures are now loud — a 4xx from `id.nugs.net` clears auth and dispatches a `nugs:logged-out` event that toasts the user and re-renders Settings. One-shot boot refresh upgrades existing sessions whose `expires_at` was set under the old scheme. |
| **v1.6.1** | Rebrand build artifacts to "Days Between" — DMG, AppImage, NSIS installer and portable EXE now ship under the project name (was "Relisten"). App ID changed to `com.daysbetween.desktop`. No code/feature changes vs. v1.6.0. |
| **v1.6.0** | Local archival: ⬇ Download Show button on Relisten and Nugs releases archives the full setlist + cover art to `~/Music/Days Between/<Artist>/<Date - Venue>/` with a persistent bottom-right progress pill. Nugs single-stream mitigations: auto-pause/resume of live playback during downloads (with opt-out confirm dialog), prefetch disabled, and audio teardown on app quit to free the upstream stream slot. Hybrid audio+video Nugs releases now render Play All alongside Watch Video. |
| **v1.5.4** | Ghost scraper hardening: `did-fail-load` fast-fail on Cloudflare/network errors; Akamai header WAF bypass; unified vacuum harvest for virtualized DOM (sweep-scroll, step-scroll, IntersectionObserver fallback); class-selector extractors (`[class*="Tile"]`, `[class*="grid"]`); Referer/Origin spoof restored; img-anchor fallback for empty card sweeps |
| **v1.5.3** | HLS buffer caps (30 s / 60 s max) applied to main audio player and video-player.js — prevents RAM exhaustion on long shows |
| **v1.5.2** | Security hardening: `shell.openExternal` restricted to http/https; ghost scraper domain-gated to nugs.net only; dead `fetch-image` proxy removed; HLS buffer capped at 30/60 s to prevent RAM bloat |
| **v1.5.1** | Nugs show art now renders correctly — fixed CDN URL construction (`assets-01.nugscdn.net`) that was pointing at the wrong host |
| **v1.5** | nugs.net Search & Pin sidebar (instant search, localStorage pins); inline HLS video player for livestreams and VOD with Fullscreen + Cast buttons; API-native stream resolution (no ghost browser for playback); audio-only releases auto-route to track list |
| **v1.4** | Glass UI — transparent window, backdrop-filter blur on sidebar/titlebar/player, Inter typography, floating player bar, 20px-radius cards, CSS enter animation on view swap |
| **v1.3** | 5-band graphic EQ with IndexedDB persistence and `Ctrl+E` bypass shortcut |
| **v1.2** | Gapless playback via dual-buffer audio engine with 0.4 s element-level crossfade |
| **v1.1** | Storage migrated from `localStorage` to IndexedDB via localforage |
| **v1.0** | Initial release — Relisten + nugs streaming, Chromecast, Last.fm, themes |

---

## Credits

- **[Relisten](https://github.com/RelistenNet/relisten-web)** — open API powering all Relisten content
- **[nugs.net](https://nugs.net)** — official source for nugs streaming content
- **[hls.js](https://github.com/video-dev/hls.js)** — HLS streaming (Apache 2.0)
- **[localforage](https://github.com/localForage/localForage)** — IndexedDB wrapper (Apache 2.0)
- **[castv2-client](https://github.com/thibauts/node-castv2-client)** — Chromecast protocol (MIT)

---

## Disclaimer & Educational Use

This is a personal portfolio project built to learn Electron, HLS streaming, Web Audio API, and browser security techniques (Content Security Policy, ES module architecture, XSS mitigation). It is not affiliated with, endorsed by, or connected to Nugs.net or Relisten.

- **Nugs.net content** is only accessible to users with an active nugs.net subscription. This app authenticates using your own credentials and does not bypass, circumvent, or share any paywall.
- **Relisten content** is served via the public Relisten API and is freely available per that project's terms.
- All streams are fetched live from the providers' own CDNs. The optional **Local archival** feature saves files to your own machine for personal offline listening only — it does not redistribute, share, or upload anything. Relisten recordings are taper/community sourced and freely distributable per the Relisten terms; Nugs.net downloads remain bound by your subscription's terms of use.

Use of this software is solely your responsibility. Review each service's terms before use.

## License

MIT
