// src/providers/torrent/solidtorrents.js — NEW in 3.0: SolidTorrents JSON API.
import { Provider, register } from '../../core/registry.js';
import { req } from '../../core/http.js';
import { parseRelease } from '../../core/release.js';
import { magnet } from './_trackers.js';

const HOSTS = ['https://solidtorrents.eu', 'https://solidtorrents.to', 'https://alpha.solidtorrents.to'];

class SolidTorrents extends Provider {
  constructor() { super({ id: 'solidtorrents', tier: 1, kinds: ['torrent'], trust: 0.9 }); }

  async search(media, opts) {
    let lastErr;
    for (const host of HOSTS) {
      try {
        const q = opts.query || `${media.title} ${media.year || ''}`;
        const u = new URL(`${host}/api/v1/search`);
        u.searchParams.set('q', q.trim());
        u.searchParams.set('sort', 'seeders');
        u.searchParams.set('limit', '50');
        const d = await req(u.toString());
        const results = d?.results || d?.data || [];
        return results
          .filter(t => t.infoHash || t.info_hash)
          .map(t => {
            const name = t.title || t.name;
            const rel = parseRelease(name);
            const hash = (t.infoHash || t.info_hash).toLowerCase();
            return {
              provider: this.id, kind: 'torrent',
              title: name, hash,
              magnet: magnet(hash, name),
              quality: rel.quality, codec: rel.codec, sourceTag: rel.sourceTag,
              network: rel.network, audio: rel.audio, langs: rel.langs,
              isPack: rel.isPack, isEpisode: rel.episode !== null,
              season: rel.season, episode: rel.episode,
              sizeMB: Number(t.size || t.fileSize || 0) / 1048576,
              seeds: Number(t.seeders || t.swarm?.seeders || 0), __name: name
            };
          });
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('solidtorrents unreachable');
  }
}

const instance = new SolidTorrents();
register(instance);
export default instance;
export { SolidTorrents };
