// src/providers/torrent/yts.js — YTS movie indexer (3 API hosts).
import { Provider, register } from '../../core/registry.js';
import { req } from '../../core/http.js';
import { magnet } from './_trackers.js';

const HOSTS = ['https://yts.mx/api/v2', 'https://yts.bz/api/v2', 'https://yts.gg/api/v2'];

class Yts extends Provider {
  constructor() { super({ id: 'yts', tier: 1, kinds: ['torrent'], supports: ['movie'], trust: 1.2 }); }

  async search(media, opts) {
    let lastErr;
    for (const host of HOSTS) {
      try {
        const u = new URL(`${host}/list_movies.json`);
        u.searchParams.set('query_term', media.title);
        u.searchParams.set('limit', '30');
        u.searchParams.set('sort_by', 'seeds');
        const d = await req(u.toString());

        const out = [];
        for (const m of d?.data?.movies || []) {
          if (media.year && m.year && Math.abs(m.year - Number(media.year)) > 1) continue;
          for (const t of m.torrents || []) {
            out.push({
              provider: this.id, kind: 'torrent',
              title: `${m.title} (${m.year}) ${t.quality} ${t.type}`,
              hash: t.hash, magnet: magnet(t.hash, `${m.title} ${m.year} ${t.quality}`),
              quality: t.quality === '4K' ? 2160 : parseInt(t.quality, 10) || 0,
              codec: /x265|hevc/i.test(t.type || '') ? 'x265' : 'x264',
              sourceTag: 'BLURAY', network: null, audio: [], langs: [],
              isPack: false, isEpisode: false, season: null, episode: null,
              sizeMB: t.size_bytes ? t.size_bytes / 1048576 : 0,
              seeds: t.seeds || 0, __name: `${m.title} ${t.quality}`
            });
          }
        }
        return out;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('YTS unreachable');
  }
}

const instance = new Yts();
register(instance);
export default instance;
export { Yts };
