// engine/providers/torrent/torrentscsv.js — Torrents-CSV JSON API.
import { Provider, register } from '../../core/registry.js';
import { req } from '../../core/http.js';
import { parseRelease, matchesEpisode } from '../../core/release.js';
import { magnet } from './_trackers.js';

const API = 'https://torrents-csv.com/service/search';

export function parseTorrentsCsv(payload, media, opts = {}) {
  const rows = Array.isArray(payload?.torrents) ? payload.torrents : [];
  return rows.flatMap((t) => {
    const name = String(t.name || '').trim();
    const hash = String(t.infohash || '').trim();
    if (!name || !/^[a-f\d]{40}$/i.test(hash)) return [];

    const rel = parseRelease(name);
    if (media?.type === 'series') {
      if (opts.season == null || opts.episode == null) return [];
      if (!matchesEpisode(rel, Number(opts.season), Number(opts.episode), name)) return [];
    }

    return [{
      provider: 'torrentscsv',
      kind: 'torrent',
      title: name,
      hash,
      magnet: magnet(hash, name),
      quality: rel.quality,
      codec: rel.codec,
      sourceTag: rel.sourceTag,
      network: rel.network,
      audio: rel.audio,
      langs: rel.langs,
      isPack: rel.isPack,
      isEpisode: rel.episode !== null,
      season: rel.season,
      episode: rel.episode,
      sizeMB: Number(t.size_bytes || 0) / 1048576,
      seeds: Number(t.seeders || 0),
      __name: name,
    }];
  });
}

class TorrentsCsv extends Provider {
  constructor() { super({ id: 'torrentscsv', tier: 1, kinds: ['torrent'], trust: 1.2 }); }

  async search(media, opts) {
    if (media.type === 'series' && (opts.season == null || opts.episode == null)) return [];
    const query = media.type === 'series'
      ? `${media.title} S${String(opts.season).padStart(2, '0')}E${String(opts.episode).padStart(2, '0')}`
      : `${media.title} ${media.year || opts.year || ''}`.trim();
    const params = new URLSearchParams({ q: query, size: '50' });
    const data = await req(`${API}?${params}`);
    return parseTorrentsCsv(data, media, opts);
  }
}

const instance = new TorrentsCsv();
register(instance);
export default instance;
export { TorrentsCsv };
