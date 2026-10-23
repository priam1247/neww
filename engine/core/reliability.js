// engine/core/reliability.js — canonical provider reliability ranking.
//
// Ordered from fastest & most reliable to last-resort fallback:
//   #1 moviebox — direct BFF CDN HTTP MP4 + subtitles, fast even on multi-GB files
//   #2–#6       — direct/HLS stream CDNs ordered by uptime & throughput
//   #7–#14      — torrent indexers ordered by encode quality, seed health & API speed

export const PROVIDER_RELIABILITY_ORDER = [
  'moviebox',
  'vixsrc',
  'vidlink',
  'videasy',
  'vidsrc',
  'vaplayer',
  'yts',
  'torrentio',
  'eztv',
  'nyaa',
  'knaben',
  'solidtorrents',
  'torrentscsv',
  'apibay',
];

const RANK_INDEX = new Map(
  PROVIDER_RELIABILITY_ORDER.map((id, idx) => [id, idx]),
);

const BONUS_BY_ID = {
  moviebox: 36,
  vixsrc: 28,
  vidlink: 24,
  videasy: 20,
  vidsrc: 16,
  vaplayer: 12,
  yts: 22,
  torrentio: 18,
  eztv: 16,
  nyaa: 14,
  knaben: 10,
  solidtorrents: 7,
  torrentscsv: 4,
  apibay: 2,
};

export function reliabilityRank(id) {
  const key = String(id || '').toLowerCase();
  return RANK_INDEX.has(key) ? RANK_INDEX.get(key) : 999;
}

export function reliabilityBonus(id) {
  const key = String(id || '').toLowerCase();
  return BONUS_BY_ID[key] ?? 0;
}
