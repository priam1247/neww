// src/providers/torrent/apibay.js — NEW in 3.0: ThePirateBay via apibay.org
// (official TPB JSON API mirror). Strong for old content 2.0's indexers missed.
import { Provider, register } from '../../core/registry.js';
import { req } from '../../core/http.js';
import { parseRelease } from '../../core/release.js';
import { magnet } from './_trackers.js';

const HOSTS = ['https://apibay.org', 'https://tpb.apibay.org'];

class Apibay extends Provider {
  constructor() { super({ id: 'apibay', tier: 1, kinds: ['torrent'], trust: 0.9, label: 'TPB (apibay)' }); }

  async search(media, opts) {
    let lastErr;
    for (const host of HOSTS) {
      try {
        const q = opts.query || `${media.title} ${media.year || ''}`;
        const d = await req(`${host}/q.php?q=${encodeURIComponent(q.trim())}`);
        // apibay returns [{"name","info_hash","leechers","seeders","size"}] or [{"name":"No results..."}]
        if (!Array.isArray(d) || d[0]?.info_hash === undefined) return [];
        return d
          .filter(t => t.info_hash && Number(t.seeders) >= 0)
          .slice(0, 60)
          .map(t => {
            const rel = parseRelease(t.name);
            return {
              provider: this.id, kind: 'torrent',
              title: t.name, hash: String(t.info_hash).toLowerCase(),
              magnet: magnet(t.info_hash, t.name),
              quality: rel.quality, codec: rel.codec, sourceTag: rel.sourceTag,
              network: rel.network, audio: rel.audio, langs: rel.langs,
              isPack: rel.isPack, isEpisode: rel.episode !== null,
              season: rel.season, episode: rel.episode,
              sizeMB: Number(t.size || 0) / 1048576,
              seeds: Number(t.seeders || 0), __name: t.name
            };
          });
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('apibay unreachable');
  }
}

const instance = new Apibay();
register(instance);
export default instance;
export { Apibay };
