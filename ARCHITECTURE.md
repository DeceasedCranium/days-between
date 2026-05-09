# Architecture

A one-page overview of how Days Between is wired internally. Read this before
making structural changes.

---

## High-level layout

```
days-between/
├── app/
│   ├── main.js            ← Electron main process (Node + Chromium control)
│   ├── preload.js         ← contextBridge — defines window.ipc.* in renderer
│   ├── cast.js            ← Chromecast (castv2-client) wrapper, main-process
│   ├── nugs-scraper.js    ← Headless ghost BrowserWindow + CDP capture
│   ├── shared/            ← Pure-JS helpers (no DOM, no Node, no Electron)
│   │   └── helpers.js     ← Tested in test/helpers.test.js
│   └── renderer/          ← Browser context — index.html and ES modules
│       ├── index.html
│       ├── app.js         ← Boot + global event wiring
│       ├── api.js         ← Relisten + Nugs HTTP clients
│       ├── audio-engine.js← Dual-buffer gapless audio + EQ chain
│       ├── eq-engine.js   ← 5-band BiquadFilter chain (singleton AudioContext)
│       ├── archive.js     ← Local archival queue (sequential downloader)
│       ├── lastfm.js      ← Scrobbling + Wikipedia/Last.fm artist images
│       ├── nugs-scraper.js← Renderer-side parser of ghost-scraped HTML
│       ├── player.js      ← Now-playing state, queue, repeat, shuffle
│       ├── state.js       ← In-memory cache + localforage persistence
│       ├── theme.js       ← Theme / accent / density / glass settings
│       ├── update-check.js← In-app GitHub release notifier
│       ├── views-core.js  ← Relisten browsing views (artists / shows / search)
│       ├── views-nugs.js  ← Nugs browsing views (welcome / artist / release)
│       ├── views-user.js  ← Settings, stats, history, tapes, saved
│       ├── video-player.js← Inline HLS video for nugs livestreams
│       └── mixlr-player.js← Mixlr embed for live audio webcasts
├── assets/                ← icon.svg, icon.png, tray.png
├── test/
│   └── helpers.test.js    ← node:test suite for app/shared/helpers.js
└── .github/workflows/
    └── release.yml        ← Test → build matrix → publish on `v*` tag
```

## Process model

Days Between is an Electron app with two trust boundaries:

### 1. Main process (`app/main.js`)
- Node-capable, full filesystem and OS access.
- Owns the BrowserWindow, the system tray, MPRIS (Linux media keys), the
  Chromecast client, the headless ghost BrowserWindow, all `webRequest`
  header rewrites, and Last.fm signing (`LFM_SECRET` never leaves here).
- Exposes capability-narrow IPC handlers — see the bottom of `main.js`
  and `preload.js` for the complete surface.

### 2. Renderer process (`app/renderer/*`)
- Sandboxed Chromium context. No `require`, no Node.
- Talks to the main process exclusively via `window.ipc.*` (defined in
  `preload.js`).
- All UI lives here. ES modules loaded directly — no bundler, no
  transpiler, no build step.

### 3. Ghost BrowserWindow (managed from `app/nugs-scraper.js`)
- A headless BrowserWindow with `partition: 'persist:nugs'` so cookies +
  Cloudflare clearance survive across launches.
- Used for two things:
  - Loading nugs.net pages that require a real Chromium browser to
    bypass Cloudflare / Demandware bot challenges.
  - Capturing JSON response bodies via Chrome DevTools Protocol
    (`webContents.debugger` + `Network.getResponseBody`) — the
    `webRequest` API exposes URLs and headers but not bodies.
- Each scrape uses a per-call `AbortController`. Hard timer fires →
  controller aborts → polling loops exit cleanly.

## Storage layer

All user data lives in IndexedDB via [localforage](https://github.com/localForage/localForage).
The `state.js` module wraps localforage with an in-memory cache so reads
are synchronous and writes are fire-and-forget:

```
state.js  →  in-memory cache (synchronous reads)
              ↓ async writes
              localforage  →  IndexedDB  (per-key db-* entries)
```

Persisted keys (all prefixed `db-`):

| Key | Type | Notes |
|---|---|---|
| `db-faves`, `db-fav-artists` | Array | Saved shows + favourite artists |
| `db-history` | Array | Listening history (capped at 100 entries) |
| `db-ratings` | Object | Personal show ratings 1–5 |
| `db-tapes` | Array | User-built playlists |
| `db-settings` | Object | Theme, accent, EQ bands, density, etc. |
| `db-nugs-auth` | Object | Nugs OAuth tokens (access, refresh, exp) |
| `db-lfm-session` | String | Last.fm session key |

Plus localStorage (smaller, simpler, used for things that need synchronous
top-level access on boot):

| Key | Notes |
|---|---|
| `nugs_pinned_artists` | Array of `{id, name}` |
| `db-wiki-cache`, `db-lfm-img-cache` | Artist-image lookup caches (30-day TTL) |
| `dismissedUpdateVersion` | Last update-notifier dismissal |
| `sotd` | Today's Show-of-the-Day pick |

Migration from `localStorage` → IndexedDB happens once on `loadAll()`.

## Audio architecture

`audio-engine.js` exposes a single `audio` element to the rest of the app
but maintains a *primary + staging* pair internally for gapless playback:

```
audio (proxy)  →  primary  ─┐
                            ├─ AudioContext → 5x BiquadFilter → destination
                  staging ──┘
```

- Tracks load on the staging element while the primary is playing.
- At the end of a track, the engine fades over 0.4s and swaps the roles.
- Both elements are permanently connected to the same EQ filter chain.
- `eq-engine.js` is a singleton. Bypass mode sets all gains to 0 dB
  rather than disconnecting nodes — preserves the audio graph state.

## Network layer

Two separate paths for two different problems:

### Direct fetch (renderer → host)
- `api.relisten.net` — public, no auth, served via plain `fetch`.
- `streamapi.nugs.net`, `id.nugs.net`, `subscriptions.nugs.net` — Nugs's
  documented OAuth APIs. Renderer-side `nugsApi` (in `api.js`) calls
  these directly with the cached Bearer token.

### Header-rewrite path (renderer → main → host)
- Some hosts reject Electron's default User-Agent or require specific
  Referer/Origin headers (Akamai HLS, archive.org CORS, nugs CDN images).
- `main.js` registers a single `session.defaultSession.webRequest.
  onBeforeSendHeaders` listener that rewrites these per-host before the
  request leaves the box. See the giant switch in main.js — it's the
  one source of truth for "which host needs which spoofed headers".

### Ghost-scrape path (renderer → main → ghost browser → host)
- Used for nugs.net web pages (live hub, library, video player) where
  no documented JSON API exists. The ghost loads the page, the renderer
  parses the resulting HTML or consumes JSON captured via CDP.

## Pure helpers (app/shared/)

A small module of side-effect-free functions used in many places:

- `sanitizeSegment` / `extFromUrl` / `trackFilename` — filename safety
  for the local archival downloader.
- `nugsContainerImage` / `nugsIsoDate` / `parseNugsDate` — Nugs catalog
  data normalisation.
- `sortByRecent` / `sortByPopular` / `applyNugsFilters` — Nugs artist-page
  tab logic.
- `resolveShowArtist` — Relisten `show → artist` resolution that walks
  the three different payload shapes the API ships.
- `compareVersions` — semver-ish comparison for the update notifier.

These have **no browser or Node dependencies** by construction. Tests
in `test/helpers.test.js` exercise the full surface; CI runs them
before any build job and gates publishing.

## How to add a new feature

1. Decide which trust boundary it belongs to.
   - **Filesystem / OS / cookies / Cast** → main process
   - **UI / playback** → renderer
   - **Pure data transformation** → `app/shared/helpers.js` + a test
2. If it crosses the boundary, define a narrow IPC channel in
   `main.js` + `preload.js`. Don't expose `ipcRenderer` directly.
3. If it deals with a Relisten or Nugs response shape, write the
   pure transformation in `helpers.js` and pin its behaviour with
   a test. The UI imports from there.
4. Run `npm test` before committing.

## Build & release

| Trigger | Action |
|---|---|
| Push to `main` | Test → build matrix (artifacts only, no release) |
| Push tag `v*` | Test → build matrix → publish GitHub Release |

Local Linux Arch package:

```bash
makepkg -f
sudo pacman -U days-between-X.Y.Z-1-any.pkg.tar.zst
```

For day-to-day source iteration without rebuilding the package:

```bash
./days-update.sh    # rsyncs the working tree into /opt/days-between/
```
