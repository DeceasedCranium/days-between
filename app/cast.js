'use strict';
const mdns = require('multicast-dns')();
const { Client, DefaultMediaReceiver } = require('castv2-client');

let _client = null, _player = null, _onStatus = null;

function _teardown() {
  try { _player?.close(); } catch {}
  try { _client?.close(); } catch {}
  _player = null; _client = null; _onStatus = null;
}

function discover(durationMs = 5000) {
  return new Promise(resolve => {
    const found = new Map();
    function onResponse(res) {
      const recs = [...(res.answers ?? []), ...(res.additionals ?? [])];
      let host = null, port = null, name = null;
      for (const r of recs) {
        if (r.type === 'PTR') name = r.data;
        if (r.type === 'SRV') { host = r.data.target; port = r.data.port; }
        if (r.type === 'A' && !host) host = r.data;
      }
      if (host && port) {
        const key = `${host}:${port}`;
        if (!found.has(key)) found.set(key, { name: name ?? host, host, port });
      }
    }
    mdns.on('response', onResponse);
    mdns.query('_googlecast._tcp.local', 'PTR');
    setTimeout(() => { mdns.removeListener('response', onResponse); resolve([...found.values()]); }, durationMs);
  });
}

function connect(host, port, onStatus) {
  return new Promise((resolve, reject) => {
    _teardown();
    _onStatus = onStatus;
    const client = new Client();
    _client = client;
    client.on('error', err => { _teardown(); onStatus({ state: 'DISCONNECTED', error: err.message }); });
    client.connect({ host, port }, () => {
      client.launch(DefaultMediaReceiver, (err, player) => {
        if (err) { _teardown(); return reject(err); }
        _player = player;
        player.on('status', s => _onStatus?.({ state: s.playerState, currentTime: s.currentTime }));
        resolve();
      });
    });
  });
}

function load({ url, contentType, title = '', artUrl = '' }) {
  if (!_player) return Promise.reject(new Error('cast: not connected'));
  const media = {
    contentId: url, contentType,
    streamType: contentType === 'application/x-mpegURL' ? 'LIVE' : 'BUFFERED',
    metadata: { metadataType: 3, title, images: artUrl ? [{ url: artUrl }] : [] },
  };
  return new Promise((resolve, reject) =>
    _player.load(media, { autoplay: true }, (err, s) => err ? reject(err) : resolve(s)));
}

const pause = () => _player ? new Promise(r => _player.pause(r)) : Promise.resolve();
const play  = () => _player ? new Promise(r => _player.play(r))  : Promise.resolve();
const seek  = (s) => _player ? new Promise(r => _player.seek(s, r)) : Promise.resolve();
const stop  = () => _teardown();

module.exports = { discover, connect, load, pause, play, seek, stop };
