// Days Between — configuration template
// Copy this file to config.js and fill in your own keys.
//
//   cp config.example.js config.js
//
// config.js is gitignored and never committed.
module.exports = {
  // Last.fm API credentials
  // Register a free app at https://www.last.fm/api/account/create
  // Needed for: scrobbling, Artist Radio (getSimilar), Now Playing updates
  LFM_KEY:    '',
  LFM_SECRET: '',

  // setlist.fm API key (optional)
  // Register a free key at https://api.setlist.fm/docs/1.0/index.html
  // Used (when set) for authoritative per-song play counts and tour data —
  // setlist.fm has wider coverage than Relisten alone for jam bands. The
  // app falls back gracefully when this is empty: features that depend on
  // it stay dormant.
  SETLIST_FM_KEY: '',
};
