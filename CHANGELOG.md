# Changelog

Per-release notes for Days Between, newest first. The README's
[Version History](./README.md#version-history) section links here.

## v2.2.3 — Delta-audit fixes

Four targeted bug fixes from a structural review of everything added
between v2.0.0 and v2.2.2. No new features; no schema or API changes.
Each fix prevents a different latent failure that wouldn't surface
under normal usage but would absolutely show up in a user report.

1. **"Play Best Recording" now agrees with the source picker.** The
   button at the top of every show page used a deprecated
   `s.is_soundboard` shortcut to pick a source, while the picker
   itself was upgraded in v2.1 to use the smarter
   `pickPreferredSourceIdx`. Two paths could disagree on the same
   show — open a 1977 Dead show with "Prefer Soundboard" off, the
   picker correctly auto-selected the top-rated AUD, but Play Best
   would pick a Matrix (because Matrix recordings have
   `is_soundboard: true` since they include a board feed). Now both
   route through the same picker, so the visible auto-selection and
   the Play Best result match.

2. **setlist.fm cache "upgraded" guard requires non-empty data.**
   The v2.2.0 migration gate (`Array.isArray(cached.setlists)`)
   counted an empty array as "upgraded." If `normalizeSetlistForSearch`
   ever produced zero valid entries for an artist — every setlist
   malformed, date-format change at setlist.fm, etc. — the cache
   would be permanently locked in a stale state with no recovery
   until the 7-day TTL or a manual forceRefresh. Now requires
   `setlists.length > 0` so a bad normalize pass triggers a re-fetch
   on the next use.

3. **Advanced Search artist-picker supersede guard.** Picking artist
   A → mid-scan → picking artist B previously left A's scan running
   in the background; its progress callback kept writing into B's
   status row and its completion overwrote B's "ready" state. Added
   a captured-slug check at every async boundary so a superseded
   scan bails silently. Same pattern v1.9 introduced for the Nugs
   welcome rows.

4. **Nugs catalog fetch in-flight dedupe.** Clicking "🎤 Nugs" on
   several Advanced Search results in quick succession used to kick
   off duplicate paginated catalog fetches (10-30s each for Dead's
   1,200+ containers), independently writing to the same cache key
   and burning Nugs rate budget. Now the cache stashes the in-flight
   Promise so concurrent callers await the same fetch and get the
   same containers back. Cleared on failure so a transient error
   doesn't leave a permanently-rejected Promise behind.

Existing 130 unit tests still pass; no new tests added. All four
changes are at call sites or wrapper layers, not in helpers that
need test coverage.

## v2.3.0 — UI revamp

A focused visual pass across the entire app. Pure UI work — no API
changes, no schema changes, no new IPC. Built on a feature branch
(`ui-revamp`) with six per-phase commits so individual pieces can be
audited or reverted in isolation. Each phase landed independently
and was validated in the user's daily install before the next began.

**Phase 1 — Sidebar icons.** Every nav button gets an inline Lucide
icon stacked above its label — users / calendar-days / trending-up /
cassette-tape on the top row, heart / clock / bookmark / bar-chart-3
on the second, search on the Advanced Search feature row. Icons
inherit `currentColor` stroke so they pick up the accent in the
active state and brighten on hover. No new dependencies — SVGs are
inlined verbatim from lucide.dev (ISC licence).

**Phase 2C — Hover & transition vocabulary.** Show cards lift on
hover with spring easing and an accent-tinted shadow. Show rows
(list mode) slide right with a coloured accent bar appearing on
the left edge. Track rows get a faint accent pseudo-bar on hover,
solid on the currently-playing track. Primary CTAs get a glowing
accent shadow. Source chips lift on hover; active chip gets a soft
glow. Real `focus-visible` rings on every clickable surface for
keyboard nav. Page transitions strengthened from 240ms slide to
280ms slide-plus-scale.

**Phase 2A — Show page cinematic hero.** The existing
`.show-header` is now a real poster: taller padding,
radial-highlight + vertical gradient backdrop tinted by the
artist's hash colour, 200×200 artwork (was 160) with triple-layer
shadow + inner highlight ring, 36px date heading with tightened
letter-spacing, refined tag pills with backdrop-blurred glass
background plus accent-tinted green / gold variants for the
Soundboard / rating tags.

**Phase 2 (NPO) — Cinematic Now Playing overlay.** The headline
visual lift. Refactored the 380px centered-column layout into a
wide two-column grid (≥880px viewport): art + track info on the
left, full-height setlist column on the right. Backdrop intensity
significantly stronger — track-color drives a blurred backdrop
with two layered radial highlights and a soft vignette. 340×340
artwork with triple-layer shadow including a track-color tinted
glow plus a soft "floor reflection" blur underneath. Track title
poster-sized at 36px with a faint track-color text-shadow. Setlist
is now a glass-panel full-height column on the right with
tabular-numeric durations; active row gets an accent-tinted
background. Primary play button gets the accent-glow treatment.
Narrow-window guard (<880px) falls back to the v2.2 single-column
stack.

**Phase 2B — Welcome page tabbed feature card.** Stronger hero:
96px logo with accent-tinted glow, 32px heading with tightened
letter-spacing, subtle accent-tinted radial wash at the top of the
view. Show of the Day and On This Day consolidated into a single
tabbed card — header hosts two pill-tabs (🎵 Show of the Day /
📅 On This Day · date), tab selection persists in localStorage.
OTD list lazy-fetched on first tab click, cached in-memory by
month-day. For You / Global sub-toggle only visible when the SOTD
tab is active. Welcome view now scrolls vertically when content
overflows so smaller windows don't clip the bottom.

**Phase 2 wrap-up — Artist hero + Set labels + Cross-source
setlist.fm-driven sets.** Artist Years page gets the same cinematic
treatment as show pages — gradient backdrop, 160px circular
artwork with triple-layer shadow, 48px artist name. Set labels in
track lists bumped from utilitarian muted-grey 10px to a proper
chip-like accent heading with a short bar on the left and a faint
gradient line extending to the right.

The biggest behavioural change in v2.3 is in this last phase:
**a new `buildSetlistFmSongMap(artist, displayDate)` helper that
both the Relisten and Nugs show-page renderers use to insert real
set headers based on cached setlist.fm data.** Many Relisten sources
ship as a single unnamed "Set" with everything crammed in (Cornell
'77 is the canonical example — 20 tracks, one "Set" label, no
actual Set 1 / Set 2 / Encore delineation). Nugs ships completely
flat with no set structure at all. The cross-reference resolves
both by reading the setlist.fm setlist for the date and using its
sets to inject / override structure.

Coverage:
- Works for any artist whose song-stats card has been opened, or
  whose Advanced Search has been used — those flows populate the
  setlist.fm cache. Modern jam-band catalogs are the sweet spot.
- Falls back to a flat list with no labels when no cache or no
  matching date exists. Status quo, no regression.
- Tracks that don't match any setlist.fm song (jam interludes,
  unlogged segues) inherit the running set context, so a single
  unmatched song doesn't visually break the set boundary.

Per-source delineation logic preserved as the fallback: when no
setlist.fm map is available, the Relisten side uses
`source.sets[].name` like before, and the Nugs side stays flat.

**130 unit tests still pass.** No new tests — UI work doesn't need
helper-level coverage. The one new pure-ish addition
(`buildSetlistFmSongMap`) is a thin orchestration wrapper around
already-tested helpers (`normaliseSongTitle`, `nugsIsoDate`,
`getArtistSetlists`).

**Files touched** (~1,400 LOC across the branch):
- `app/renderer/style.css` — bulk of the work, all overrides
  appended at the bottom of the stylesheet for surgical revert
- `app/renderer/index.html` — sidebar icons, welcome-tab markup
- `app/renderer/views-core.js` — async `renderShow`, new
  `renderRelistenTrackList` helper, welcome-tab switcher
- `app/renderer/views-nugs.js` — `renderNugsTracksWithSetLabels`,
  imports the shared map builder
- `app/renderer/setlistfm.js` — new exported
  `buildSetlistFmSongMap` helper

## v2.2.2 — Configurable downloads folder + source-switch no-pause

Two tweaks driven by user feedback.

**Configurable downloads folder.** Settings → Data now has a Downloads
folder row showing the current path, with three actions:
- ↗ Open — reveals the folder in the OS file manager (Finder /
  Explorer / Nautilus)
- Change folder… — opens a native folder picker; choice is persisted
  to `<userData>/download-config.json`, validated for writability
  before saving
- Reset — only appears when a non-default path is configured, clears
  the override

Defaults stay exactly as before:
- macOS: `~/Music/Days Between/`
- Linux: `~/Music/Days Between/` (or `$XDG_MUSIC_DIR/Days Between`)
- Windows: `C:\Users\<User>\Music\Days Between\`

When changing the folder, existing downloads stay where they are
(no migration) — the toast notes this. If a previously-configured
path becomes unavailable on next launch (removable drive unplugged,
network share offline), `getDownloadDir()` silently falls back to
the default and logs a warning, so downloads never fail because of
a stale config.

**Source-switch no longer pauses playback.** v2.2 added a
"surface-the-switch" auto-pause when clicking between source chips
on the show page. In practice that punished the common "I just want
to see who taped this" browse-while-listening pattern. Reverted to
the historical v1.x behavior: switching sources just re-renders the
chip metadata and track list; playback continues. Clicking an actual
track in the new source's list still replaces the current track
cleanly via the normal play path.

No new tests — both changes are I/O / UI wiring. Existing 130 unit
tests still pass.

## v2.2.1 — Nugs sign-in error handling

Bug-fix release prompted by a user report (thanks OddKey2242) — Nugs
sign-in was failing for some accounts with the generic message
"Sign-in failed. Check your connection." which hid the actual cause.

The previous login flow collapsed every failure path into a single
`nugs:login_failed` error: bad credentials, Cloudflare challenge,
captcha required, 2FA, transient network error — all looked
identical to the user (and to us trying to diagnose). Worse, the
catch block in the Settings login handler discarded the underlying
error.message entirely, so even a console-savvy user had nothing to
copy back.

Login flow now distinguishes:
- `nugs:login_failed` — true bad credentials (HTTP 400 / 401 from
  the OAuth token endpoint)
- `nugs:no_subscription` — credentials work but no active sub
- `nugs:network` — fetch threw before getting a response (DNS,
  offline, connection refused, etc.)
- `nugs:bad_response` — Nugs returned a non-JSON body (Cloudflare
  challenge page is the canonical case; also fires when their
  load balancer returns HTML error pages)
- `nugs:auth_<status>` — any other non-OK status, surfaced with
  the HTTP code so 403 / 429 / 503 each get their own message

Every failure path now `console.error`s the upstream response body
(capped at 400 chars) so future user-reported issues are
copy-pasteable. The Settings UI maps each typed error to a clear
message and explicitly points at DevTools when the upstream cause
needs investigation.

**Critical secondary fix:** the better error reporting flushed out a
latent bug — `parseNugsDate` was *re-exported* from `api.js` but
never actually imported into local module scope, so the final
`nugsAuth.set(...)` call inside `login()` crashed with a
`ReferenceError`. Nobody hit it for months because the only path
that reaches that line is a *fresh* sign-in; every existing user has
been on refresh-token flows since they originally signed in during
an earlier version. Logging out and logging back in (which the
user-reported bug forced people to do) exposed it. Adding an
explicit `import { parseNugsDate } from '../shared/helpers.js'`
fixes the regression.

No new tests — this is purely error-handling structure around
network code; the existing 130 unit tests still pass.

## v2.2.0 — Setlist Intelligence II

The first feature release after v2.0's "ready for strangers" pass.
Three new capabilities aimed squarely at tape-trader use, plus
supporting hardening to the setlist.fm integration.

**Source picker rebuilt**
- Every Relisten show payload ships multiple `sources[]`, each with a
  free-text `source` field, taper credit, transferrer, lineage,
  rating, and `upstream_identifier` (archive.org item). v1.x labelled
  all of them as either 🎤 Soundboard or 🎧 Audience N — collapsing
  the SBD / AUD / MTX / FM distinctions tape traders specifically
  care about.
- New picker shows colour-coded type badges (SBD green, AUD amber,
  MTX purple, FM pink) plus taper name and rating + review count
  per chip. A clearly-best source gets a BEST pill.
- Default view shows the top 6 sources by rating; "Show N more ▾"
  expander reveals the rest. Cornell '77's 23 sources are now
  scannable instead of overwhelming.
- Metadata block underneath the chips shows the active source's
  full provenance: source description, taper / transferrer / lineage,
  duration + track + set counts, review count, jam-charts flag, and
  a clickable archive.org link.
- Switching sources mid-track auto-pauses playback so the source
  change is unmistakable.
- Pure-helper classifier (`classifySource`) parses both the
  free-text `source` field and the archive.org slug (`.sbd.` /
  `.aud.` / `.matrix.` / `.fm.`) so Matrix recordings flagged
  `is_soundboard=true` (because they include a board feed) now
  correctly classify as MTX. 20 new unit tests covering edge cases.

**"Prefer Soundboard when available" setting**
- New toggle in Settings → Playback. When enabled, opening a show
  defaults to the highest-rated SBD source instead of the highest-
  rated overall. Matrix deliberately doesn't promote — the
  preference is for dry board feed specifically. Falls back to top
  overall when no SBD exists. 7 new unit tests.

**Advanced Search (the big one)**
- JerryBase-style multi-criteria search across an artist's entire
  setlist.fm setlist history. Filter by date range, month/day (any
  year), day-of-week, venue / city / state, tour, and one or more
  songs with position constraints.
- 15 position keywords per song: anywhere, show-opener, show-closer,
  set-1/2/3-opener/closer/anywhere, encore-opener/closer/anywhere.
  Optional segueInto (real segue — X → Y) or followedBy (just
  consecutive) partner song.
- Multiple song rows are ANDed. "Jack Straw as Set 1 opener AND
  Eyes of the World in Set 2 AND venue contains Barton" works.
- New "🔎 Advanced Search" featured sidebar tab as the entry point.
- Typeahead combobox autocomplete on every text input — artist
  picker (1000+ artists, type to narrow), song names (artist's
  full repertoire), venues, cities, tours. Single shared popover,
  keyboard navigable (↓ ↑ Enter Esc Tab).
- Scan-aware progress: picking an artist whose setlist.fm scan
  hasn't run yet triggers it with live "N/M setlists" progress;
  form unlocks when ready, hidden when the artist isn't on
  setlist.fm.
- Each result row has TWO action buttons: `▶ Relisten` (pre-checks
  availability — a setlist.fm-known date that Relisten doesn't
  have a recording for shows a clear toast instead of navigating
  away to an error page) and `🎤 Nugs` (resolves the Nugs artist
  by name, fetches the catalog, finds the matching container,
  navigates via nugsViewRelease — works even for shows Relisten
  doesn't have).
- Form + result state survives view navigation. Click a result →
  open the show → press Back → land on Advanced Search with form
  and results intact, ready to tweak.
- Pure search engine (`searchSetlists`) lives in shared/helpers.js
  with 21 new unit tests covering every position type, segue vs
  followedBy distinction, date / venue / tour filters, multi-row
  AND logic, and malformed input handling.

**setlist.fm API hardening**
- Send `Accept-Language: en` on every request. setlist.fm started
  returning 406 Not Acceptable on `/artist/{mbid}/setlists` when
  the header is absent; without this, every fresh scan failed
  instantly.
- Pin a vanilla User-Agent (`DaysBetween/2.x …`) to match what
  setlist.fm's docs expect from API clients.
- Bump per-request gap from 600ms to 850ms (~1.18 req/sec). Big
  catalogs like Dead's 1,000+ setlists were tripping 429s every
  4-5 pages on the old rate; 850ms keeps us comfortably below the
  burst threshold so scans complete cleanly.
- Cache schema extended to store normalized raw setlists alongside
  the existing play counts. Pre-v2.2 caches (counts-only) are
  auto-migrated on next use — anyone who opened a song-stats page
  in v2.0/v2.1 gets their cache upgraded silently and unlocks
  Advanced Search.

**Tests**
- 130 unit tests in total (82 + 48 new), all passing. New coverage
  on classifySource / formatTaperLabel / isBestSource /
  pickPreferredSourceIdx / searchSetlists.

## v2.0.0 — Distribution release

Polish + stability + identity pass. The point at which Days Between stops
being "Sean's personal Electron app" and becomes a thing other people can
install and use cleanly. No new headline features — every change closes a
gap that would have embarrassed us in front of a new user.

**Audit fixes (the bugs we kept under the rug):**
- "Clear History" wrote to localStorage but history lives in IndexedDB —
  the toast was lying. Now actually clears.
- Backup import wrote to the wrong storage layer too — re-importing a
  backup gave the user nothing back after restart. Fixed; the backup
  format also gained `attended`, `bookmarks`, `ratings`, `artistFavs`,
  and `nugsArtists` so a v3 backup is actually complete.
- Wrapped the unprotected `JSON.parse` in nugs catalog/release fetches
  so non-JSON 200 responses (Cloudflare error pages, etc.) throw a
  clear `nugs:bad-response` instead of silently breaking the catalog.
- Last.fm session-rejection (codes 4 / 9) is now detected and surfaced —
  previously every track scrobbled silently against a dead session.
- Last.fm Connect button blocks instead of opening a half-broken auth
  URL when the API key is missing.
- Removed the `[CLICK]` capture-phase logger that fired on every click,
  including potentially sensitive form fields.

**Build correctness:**
- Pinned wildcard npm versions (`castv2-client`, `multicast-dns`,
  `mpris-service`) to `^x.y.z`. Reproducible builds.
- Aligned Electron version: README + setup instructions match what
  `npm install` actually pulls (currently 41.x). Removed the
  Arch-specific `electron39` framing.
- Moved developer-only tooling (`days-update.sh`, `install-pkg.sh`,
  `PKGBUILD`) to `scripts/local/` with a "not for end users" README.
- Bundled Inter font locally — removed `fonts.googleapis.com`
  fetch-on-launch. Offline launches now render correctly.
- Swept ~3.1 GB of stale `.pkg.tar.zst` build artifacts from the
  working tree.

**First-run experience:**
- Welcome banner on Relisten side for fresh installs explaining how
  to get started. Dismissable; auto-hides after first listen.
- "Sign in to nugs.net" call-to-action on the Nugs welcome page when
  not authenticated, with a one-click "Open Settings" button.
- Help (`?`) modal now leads with a paragraph explaining what the app
  is, with clickable links to Relisten / Nugs / Mixlr. Keyboard
  shortcuts grid follows below.
- Settings → About is no longer a placeholder. Real version chip,
  GitHub repo / Release notes / Check-for-updates buttons, and a
  credits paragraph.

**Quieter console:**
- New debug-gating helpers (`dlog` / `dinfo`, gated by
  `localStorage.daysBetweenDebug='1'` in renderer or
  `DAYS_BETWEEN_DEBUG=1` in main). Per-card / per-page logs that used
  to spam the console (Nugs art loading, catalog pagination, song-tab
  samples, wiki-batch summaries, ghost-window per-poll trace) are now
  silent in production.

**Friendlier failures:**
- `showError` now maps raw error strings (HTTP status codes,
  `nugs:*` sentinels, ghost timeouts, network errors) to a readable
  title + sub. The original message is preserved underneath in muted
  text so screenshots still help debug.

**UX polish:**
- Listening-history cap raised from 100 → 1000 entries. Heavy listeners
  hit the old cap in days, silently truncating stats math.
- Sidebar layout: removed an `80 px` gap at the bottom caused by an
  always-hidden footer with `display: flex !important` overriding
  the JS-set `display: none`. Fixed across both Relisten and Nugs
  modes.
- Replaced deprecated `-webkit-appearance: slider-vertical` (Chromium
  warned in v123+) with the standard `writing-mode: vertical-lr +
  direction: rtl` pattern.

**Distribution:**
- electron-builder `build` block fleshed out — explicit `icon: assets/icon.png`
  for all three platforms (electron-builder generates `.icns` / `.ico` /
  256-px desktop icons from the source PNG), Linux desktop entry with
  `GenericName` + `Keywords` so KDE/GNOME launchers index the app, .deb
  metadata with synopsis + long description, NSIS installer config
  (custom install dir, preserve user data on uninstall), DMG title with
  version, `copyright` + `author` + `license: MIT` fields.
- Source icon regenerated at 1024×1024 (was 256×256) so macOS .icns
  generation succeeds.
- Release-notes template in `.github/workflows/release.yml` rewritten —
  documents the unsigned-binary workarounds for macOS Gatekeeper and
  Windows SmartScreen explicitly, points at CHANGELOG.md instead of the
  old README#version-history anchor.
- macOS / Windows code signing deferred — paid certs aren't worth it
  for a personal-use project; documented workarounds inline.
- electron-updater deferred to v2.1. The existing in-app update notifier
  (polls api.github.com once per launch) handles the "tell users a new
  version exists" path; one-click auto-install is the v2.1 enhancement.

## v1.14.0 — Personalized Show of the Day

The welcome page's daily pick stops treating every user as a fresh
install. New `[For You] [Global]` pill toggle on the Show-of-the-Day
card: **For You** picks from artists you actually care about (filtering
today's trending pool to your top-affinity artists, falling back to a
random show from your top artist if none match), **Global** is the
original deterministic-trending behavior. Each card shows a small
accent-tinted reason chip explaining *why* it was picked — `"You
attended Dead & Co 3×"` / `"You've played Phish 47×"` / `"Pinned:
Goose"` / `"🔥 Trending today"`. Affinity score blends four signals:
attended shows ×3, pinned artists ×5, listening history ×0.5,
favorited shows ×1; the dominant signal drives the chip text. Mode
persists in localStorage; both modes cache today's pick separately so
toggling is instant. Toggle stays hidden on a fresh install (no signal
yet). New `app/renderer/personalization.js` module orchestrates the
picker; pure math (`computeArtistAffinities`, `formatAffinityReason`)
lives in `app/shared/helpers.js` with 13 new unit tests (82 total).
**Sidebar layout fix**: replaced the fragile `height: calc(100vh -
title - player)` with `height: 100%` inside its flex parent — eliminates
a visible gap between the sidebar bottom and the player bar.

## v1.13.0 — setlist.fm live integration

Solves the long-running per-song undercount (Bertha showing 25 plays
when the real number is 77+). Per-song stats card on the Relisten Songs
tab now flips its primary tile from "Recorded shows" to setlist.fm's
authoritative **"Total plays"**, with a `"N with Relisten recordings"`
subtext preserving the gap and a `📋 Per setlist.fm` row underneath.
New `app/renderer/setlistfm.js` API client: 600 ms-spaced rate limiter
(under the free-tier 2 req/sec cap), 429 retry with 15 s backoff,
paginated `/artist/{mbid}/setlists` walker with a 200-page safety cap,
two-tier localforage cache (30-day MBID, 7-day song counts). Live
progress UI ticks per-page during the first scan; subsequent song
clicks for the same artist are instant. Uses Relisten's `musicbrainz_id`
directly when present (skips the search step) and `/search/artists`
only for sources like Nugs that don't carry MBIDs. New
`aggregateSongCountsFromSetlists` pure helper dedupes within a single
setlist and normalises titles consistently with the Relisten path; 4
new unit tests (69 total). API key plumbed via `config.js` →
`config:setlistfm-key` IPC handler → `getSetlistFmKey` preload bridge
→ `initSetlistFm()` at renderer boot; integration is dormant when the
key isn't configured (callers handle null gracefully).

## v1.12.0 — Setlist Intelligence kickoff

The start of the v2.0 reframing. Songs tabs land on both Relisten and
Nugs artist pages with sortable Most Played / 🦄 Rarities views, filter
input, and a 🎧 indicator next to songs heard at attended shows. Click
a song → stats card with debut, last played, longest gap between plays,
longest run of consecutive shows containing it, top venues, attended
count, and a list of the best shows by rating with click-through to
playback. **"I Was There" attendance** mirrored to the Nugs show
detail page; the Library router opens Nugs entries via `nugsViewRelease`
(with a small `nugs` badge) instead of falling through to Relisten.
Title normalisation collapses canonical-name variants — "Bertha" /
"Bertha >" / "Bertha ->" group into a single entry whose play count is
the sum of all variants. Smarter scan matching splits composite tracks
like "Bertha > Eyes of the World" into segments and exact-matches each,
so Bertha plays register without false-matching unrelated substrings.
**Setlist-scan fallback** for artists where Relisten's `/songs`
endpoint is empty (Dead & Company is the canonical example) — the Songs
tab walks every setlist and builds the catalog locally with a progress
bar, cached per session. Catalog page-size for Nugs bumped 100→500 with
per-page logging. **setlist.fm key plumbing** wired (config + IPC + stub
module + boot init) — no live calls yet, foundation for v1.13's
authoritative play counts. 15 new helper tests (65 total).

## v1.11.0 — Quality pass

No behaviour change beyond a preserved accent. Pure helpers
(`sanitizeSegment`, `extFromUrl`, `trackFilename`, `nugsIsoDate`,
`parseNugsDate`, `nugsContainerImage`, `sortByRecent`, `sortByPopular`,
`applyNugsFilters`, `resolveShowArtist`, `compareVersions`) extracted
into `app/shared/helpers.js` with no browser/Node deps. New
`test/helpers.test.js` (42 tests via `node:test`) pins behaviour
against the regression-prone API-shape changes from prior releases.
`npm test` script + a CI gate (`release.yml` runs the suite before any
build matrix job; bad helper code can no longer ship). `app/src/`
(dead v1.0 code) removed. New `ARCHITECTURE.md` documents the trust
boundaries, storage layer, audio engine, and how to add a feature.
**Fix**: preset accent colour reset to default on every launch —
`applyGlassTheme` was stripping the inline accent variable on boot and
on every glass-slider adjustment; now `applyAccent` runs last on boot
and re-applies after glass changes.

## v1.10.0 — Welcome polish + update notifier

**In-app update notifier** polls
`api.github.com/repos/.../releases/latest` 4 seconds after launch and
shows a dismissable badge in the bottom-right when a newer version is
available. **Listening stats** appear at the bottom of the Relisten
welcome page as a one-line strip (`X tracks · Y shows · Z artists ·
Nh listening`) plus a "Pick up where you left off" resume card; hidden
when history is empty. Welcome page icon swapped from a placeholder
"D" to the actual `assets/icon.svg`. **Accent respect**: every
hardcoded orange (`#f0952c` / `#d4790e`) and red
(`rgba(233,69,96,…)`) replaced with `var(--accent)` / `var(--accent2)`
/ `color-mix(in srgb, var(--accent) N%, transparent)` so the entire
UI now retints live when you pick a new accent in Settings.

## v1.9.0 — Nugs welcome rebuilt

Four album-art rows: **Live & Recent Webcasts**, **Your Pinned
Artists**, **Recently Added** (probes streamapi globally, falls back to
a pool of recent containers across pinned artists with on-demand
catalog pre-fetch), and **Discover Artists** (random catalog sample,
↻ Shuffle to reroll). Artist tile images use the artist's most recent
release cover from the Nugs CDN — bypasses Wikipedia / Last.fm
entirely so it works for niche jam-band artists too. Persistent
(localStorage, 30-day TTL) Wikipedia/Last.fm cache + 4-at-a-time
concurrency limiter for the Relisten side's image lookups. Race-safe
loaders with token-based supersede + DOM re-query at write time.
Subtle hover-only scrollbars on welcome rows.

## v1.8.0 — Nugs artist page overhaul

Mirrored to the Relisten side. Three-tab navigation: **Recently
Added** (sorted by `epochDateCreated` — Nugs's catalog-add timestamp),
**Most Popular** (`salesAllTime` desc with `salesLast30` tiebreaker),
and **By Year** (two-step: year-picker grid → year-detail with `← All
years` back button + month/sort/Audio-Video filters). Vertical show
list replaced with the album-cover grid styling shared by Relisten;
cover art now resolves through `nugsContainerImage()` using the Nugs
CDN path `assets-01.nugscdn.net/livedownloads/images/shows/<file>?h=N`
derived from `extImage` + `img.orderID`. Tab-hint subtitle explains
which sort each tab applies. Fix Settings ✕ button leaving stale DOM
when closed from a Nugs artist page (now restores source-pane
visibility before `nav.back()`).

## v1.7.x — Stabilisation pass + slug fixes

- **v1.7.2** — Extend the v1.7.1 artist-slug fix to the **Today** tab.
- **v1.7.1** — Fix 404 on Show of the Day, On This Day, Trending, and
  search-result clicks. New `resolveShowArtist()` helper walks all
  three Relisten v3 payload shapes.
- **v1.7.0** — Main-process stabilisation pass. Lazy
  `getDownloadDir()` removes the boot race. Ghost-scraper block
  (~660 lines) extracted from `main.js` into `app/nugs-scraper.js`.
  Per-scrape `AbortController` replaces the global
  `uncaughtException` swallow. Subscription-gated nugs.net endpoints
  captured directly via Chrome DevTools Protocol
  (`Network.getResponseBody`).

## v1.6.x — Local archival + branding

- **v1.6.2** — Fix Nugs auth UI showing "logged out" while streaming
  continued to work. JWT `exp` claim used for real expiry.
- **v1.6.1** — Rebrand build artifacts to "Days Between" (was
  "Relisten"). App ID changed to `com.daysbetween.desktop`.
- **v1.6.0** — Local archival downloads via the ⬇ button. Persistent
  bottom-right progress pill. Nugs single-stream auto-pause/resume
  during downloads.

## v1.5.x — Nugs polish + ghost hardening

- **v1.5.4** — Ghost scraper hardening: fast-fail on Cloudflare,
  Akamai header WAF bypass, unified vacuum harvest for virtualized
  DOMs.
- **v1.5.3** — HLS buffer caps (30 s / 60 s).
- **v1.5.2** — Security hardening: `shell.openExternal` restricted
  to http/https; ghost scraper domain-gated to nugs.net.
- **v1.5.1** — Nugs show art CDN URL fix.
- **v1.5** — Nugs Search & Pin sidebar; inline HLS video player for
  livestreams + VOD with Fullscreen + Cast buttons; API-native stream
  resolution (no ghost browser for playback).

## v1.4 — Glass UI

Transparent window, backdrop-filter blur on sidebar/titlebar/player,
Inter typography, floating player bar, 20px-radius cards, CSS enter
animation on view swap.

## v1.3 — 5-band graphic EQ

IndexedDB persistence, `Ctrl+E` bypass shortcut.

## v1.2 — Gapless playback

Dual-buffer audio engine with 0.4 s element-level crossfade.

## v1.1 — IndexedDB migration

Storage migrated from `localStorage` to IndexedDB via localforage.

## v1.0 — Initial release

Relisten + Nugs streaming, Chromecast, Last.fm, themes.
