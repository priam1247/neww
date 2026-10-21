// engine/providers/torrent/eztv.js — EZTV series indexer.
import { Provider, register } from '../../core/registry.js';
import { req } from '../../core/http.js';
import { parseRelease } from '../../core/release.js';
import { magnet } from './_trackers.js';

const HOSTS = ['https://eztvx.to', 'https://eztv.wf'];

export function parseEztvTorrents(payload, { season, episode } = {}) {
  return (payload?.torrents || []).flatMap((t) => {
    const name = String(t.filename || t.title || '').trim();
    const hash = String(t.hash || '').trim();
    if (!name || (!hash && !t.magnet_url)) return [];

    const rel = parseRelease(name);
    const apiSeason = Number(t.season);
    const apiEpisode = Number(t.episode);
    const gotSeason = Number.isFinite(apiSeason) && apiSeason > 0 ? apiSeason : rel.season;
    const gotEpisode = Number.isFinite(apiEpisode) && apiEpisode > 0 ? apiEpisode : rel.episode;
    const isPack = apiEpisode === 0 || rel.isPack;

    if (season != null && gotSeason !== Number(season)) return [];
    if (episode != null && !isPack && gotEpisode !== Number(episode)) return [];
    if (episode != null && !isPack && gotEpisode == null) return [];

    return [{
      provider: 'eztv',
      kind: 'torrent',
      title: name,
      hash: hash || null,
      magnet: t.magnet_url || magnet(hash, name),
      quality: rel.quality,
      codec: rel.codec,
      sourceTag: rel.sourceTag === 'UNKNOWN' ? 'HDTV' : rel.sourceTag,
      network: rel.network,
      audio: rel.audio,
      langs: rel.langs,
      isPack,
      isEpisode: !isPack,
      season: gotSeason,
      episode: isPack ? null : gotEpisode,
      sizeMB: Number(t.size_bytes || 0) / 1048576,
      seeds: Number(t.seeds || 0),
      __name: name,
    }];
  });
}

class Eztv extends Provider {
  constructor() { super({ id: 'eztv', tier: 1, kinds: ['torrent'], supports: ['series'], trust: 1.3 }); }

  async search(media, opts) {
    if (!media.imdbId) return [];
    if (opts.season == null || opts.episode == null) return [];
    const imdbId = String(media.imdbId).replace(/^tt/i, '');
    if (!/^\d+$/.test(imdbId)) return [];

    let lastErr;
    for (const host of HOSTS) {
      try {
        const out = [];
        const seen = new Set();
        for (let page = 1; page <= 10; page++) {
          const query = new URLSearchParams({ imdb_id: imdbId, limit: '100', page: String(page) });
          const data = await req(`${host}/api/get-torrents?${query}`);
          const rows = Array.isArray(data?.torrents) ? data.torrents : [];
          for (const candidate of parseEztvTorrents(data, opts)) {
            const key = candidate.hash || candidate.magnet;
            if (!seen.has(key)) {
              seen.add(key);
              out.push(candidate);
            }
          }
          if (rows.length < 100) break;
        }
        return out;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('EZTV unreachable');
  }
}

const instance = new Eztv();
register(instance);
export default instance;
export { Eztv };
