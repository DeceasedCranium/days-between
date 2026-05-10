# Screenshots — capture guide

The main README references PNGs in this directory. Drop them in with the
exact filenames listed below and the README will render correctly on
GitHub. PNG, ~1600 px wide, no compression artefacts. Crop the OS chrome
(window-manager border / shadow); keep the app's own titlebar.

## Required

| Filename | What to capture | Notes |
|---|---|---|
| `welcome.png` | Relisten welcome page with the personalized "For You" Show of the Day visible. | The reason chip ("You attended Dead & Co 3×" or similar) should be readable. Show the Listening-stats strip + resume card if you have one. |
| `song-stats.png` | A song detail page where setlist.fm has flipped the count — Bertha or any well-played song. | The accent-tinted "Total plays" tile, the "N with Relisten recordings" subtext, and the 📋 Per setlist.fm row should all be visible. |
| `library.png` | Settings → Bookmarks → "I Was There" tab with a few attended shows. | Any window state. If you have a Nugs entry, the small "nugs" badge is a nice detail to show. |
| `nugs-artist.png` | A Nugs artist page (e.g. Dead & Company) showing the album-cover grid + the four-tab bar (Recently / Most Popular / By Year / 🎵 Songs). | Recently Added or Most Popular tab is fine — whichever has the best visual density. |
| `settings.png` | The new About panel inside Settings. | Version chip + GitHub / Release notes / Check for updates buttons + credits paragraph all visible. |

## Optional

| Filename | What to capture |
|---|---|
| `demo.gif` | 15–30s screen capture of the headline flow: open Dead & Company → Songs tab → click Bertha → wait for setlist.fm progress → see count flip from "25 Recorded shows" to "77 Total plays". This is the single best demonstration of what the app uniquely does. |
| `themes.png` | A side-by-side or grid showing 2-3 of the 8 themes (Dark / Cinema / Light is a good combination). |

## Cropping & polish tips

- Take screenshots at the **default window size** — don't go fullscreen. The app's proportions read better at ~1600×1000.
- Make sure no debug console / DevTools are visible.
- For the song-stats shot, take it AFTER setlist.fm has resolved — otherwise you'll capture the progress spinner.
- If your accent colour isn't the default orange, that's fine — colour variety is a feature.
