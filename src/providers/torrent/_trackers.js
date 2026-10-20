// src/providers/torrent/_trackers.js — tracker list for magnet building.
// 30 trackers = more peers found → faster start, better old-content retention.
export const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://opentracker.i2p.rocks:6969/announce',
  'udp://tracker.internetwarriors.net:1337/announce',
  'udp://tracker.leechers-paradise.org:6969/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
  'udp://tracker.cyberia.is:6969/announce',
  'udp://tracker.pirateparty.gr:6969/announce',
  'udp://p4p.arenabg.com:1337/announce',
  'udp://9.rarbg.to:2710/announce',
  'udp://tracker.moeking.me:6969/announce',
  'udp://tracker.birkenwald.de:6969/announce',
  'udp://tracker.srv00.com:6969/announce',
  'udp://tracker.zer0day.to:1337/announce',
  'https://tracker.zhuqiy.com:443/announce',
  'https://tracker.pmman.tech:443/announce',
  'https://tracker.moeblog.cn:443/announce',
  'https://tracker.gbitt.info:443/announce',
  'https://tracker.tamersunion.org:443/announce',
  'https://tracker.qu.ax:443/announce',
  'https://tr.burnabyhighstar.com:443/announce',
  'https://tr.kxmp.cf:443/announce',
  'https://tr.ready4.icu:443/announce',
  'https://tracker.hexagon.cc:2710/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.opentrackr.org:1337/announce'
];

export const magnet = (hash, name) =>
  `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name || '')}` +
  TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('');
