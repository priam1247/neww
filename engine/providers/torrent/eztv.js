// src/providers/torrent/eztv.js — EZTV series indexer (3 hosts, imdb filter).
import { Provider, register } from '../../core/registry.js';
import { req } from '../../core/http.js';
import { parseRelease } from '../../core/release.js';
import { magnet } from './_trackers.js';

const HOSTS = ['https://eztvx.to', 'https://eztz.re', 'https://eztv.wf'];

class Eztv extends Provider {
  constructor() { super({ id: 'eztv', tier: 1, kinds: ['torrent'], supports: ['series'], trust: 1.3 }); }

  async search(media, opts) {
    if (!media.imdbId) return [];
    if (opts.season == null || opts.episode == null) return [];
    let lastErr;
    for (const host of HOSTS) {
      try {
        const d = await req(`${host}/api/get-torrents?imdb_id=${media.imdbId}&limit=200`);
        return (d.torrents || [])
          .filter(t => Number(t.season) === Number(opts.season) && Number(t.episode) === Number(opts.episode))
          .map(t => {
            const rel = parseRelease(t.title || t.filename);
            return {
              provider: this.id, kind: 'torrent',
              title: t.title || t.filename, hash: t.hash,
              magnet: t.magnet?.length ? t.magnet : magnet(t.hash, t.filename),
              quality: rel.quality, codec: rel.codec, sourceTag: rel.sourceTag || 'HDTV',
              network: rel.network, audio: rel.audio, langs: rel.langs,
              isPack: false, isEpisode: true, season: opts.season, episode: opts.episode,
              sizeMB: Number(t.size_bytes || 0) / 1048576,
              seeds: t.seeds || 0, __name: t.filename
            };
          });
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('EZTV unreachable');
  }
}

const instance = new Eztv();
register(instance);
export default instance;
export { Eztv };
