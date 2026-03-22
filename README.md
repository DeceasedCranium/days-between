# Days Between

A desktop app for streaming live concert recordings from [Relisten](https://relisten.net) and [nugs.net](https://nugs.net) — 70,000+ shows from Grateful Dead, Phish, and hundreds more.

Built with Electron. All your data (history, saved shows, settings) stays local on your machine.

![Days Between screenshot](assets/icon.png)

## Features

- **Relisten + nugs.net** — Browse and stream HLS/MP3 recordings
- **Artist/Year/Show/Track** browsing with search
- **Chromecast support** — Cast audio and video to any Cast device
- **Last.fm scrobbling** — Connect your account in Settings
- **Artist Radio** — Auto-queue related artists when your queue ends
- **On This Day** — Shows played on today's date, any year
- **Sleep timer** — 15/30/60/90 min with audio fade
- **8 themes** — Dark, Cinema, Midnight, Dusk, Slate, Amber, Forest, Light
- **Queue, History, Saved shows, Stats, Tapes** (playlists)
- **Mini player** — Compact always-on-top mode
- **Now Playing overlay** with setlist

## Requirements

- [Electron](https://www.electronjs.org/) — any recent version (39+ recommended)
- On Arch Linux: `sudo pacman -S electron39`

## Setup

```bash
git clone https://github.com/YOUR_USERNAME/days-between.git
cd days-between
npm install

# Set up your Last.fm API key (optional — needed for scrobbling and Artist Radio)
cp config.example.js config.js
# Edit config.js and add your Last.fm API key
# Get a free key at https://www.last.fm/api/account/create

# Run
electron39 .
```

### Last.fm

Scrobbling and Artist Radio require a Last.fm API key. Get a free one at [last.fm/api/account/create](https://www.last.fm/api/account/create), then add it to `config.js`. The app works without it — only these two features are disabled.

### nugs.net

Requires an active nugs.net subscription. Sign in from Settings → Nugs.net.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `← / →` | Previous / Next track |
| `S` | Toggle shuffle |
| `R` | Toggle repeat |
| `Alt ←/→` | Navigate back / forward |
| `/` | Global search |
| `Q` | Toggle queue |
| `M` | Mini player |
| `?` | Keyboard shortcuts |
| `Esc` | Close overlay |
| `↑ / ↓` | Volume |

## Data & Privacy

All user data is stored locally:
- Listening history, saved shows, tapes → `localStorage`
- Settings and Last.fm session → `localStorage`
- No telemetry, no accounts, no cloud sync

## Credits

- **[Relisten](https://github.com/RelistenNet/relisten-web)** — open API powering all Relisten content
- **[nugs.net](https://nugs.net)** — official source for nugs streaming content
- **[hls.js](https://github.com/video-dev/hls.js)** — HLS streaming library (Apache 2.0)
- **[castv2-client](https://github.com/thibauts/node-castv2-client)** — Chromecast protocol (MIT)

## License

MIT
