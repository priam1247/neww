// src/providers/torrent/knaben.js — Knaben indexer (POST API).
import { Provider, register } from '../../core/registry.js';
import { req } from '../../core/http.js';
import { parseRelease } from '../../core/release.js';
import { magnet } from './_trackers.js';

class Knaben extends Provider {
  constructor() { super({ id: 'knaben', tier: 1, kinds: ['torrent'], trust: 1.3 }); }

  async search(media, opts) {
    const body = {
      search_field: 'title',
      query: opts.query,                       // built by caller (episode-aware)
      order_by: 'seeders',
      order_direction: 'desc',
      size: 100,
      hide_unsafe: false,                      // old content lives in "unsafe"
      hide_xxx: true
    };
    if (!opts.old) body.seconds_since_last_seen = 60 * 60 * 24 * 120;

    const d = await req('https://api.knaben.org/v1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });

    return (d.hits || [])
      .filter(h => h.magnetUrl || h.hash)
      .map(h => {
        const rel = parseRelease(h.title);
        return {
          provider: this.id, kind: 'torrent',
          title: h.title, hash: h.hash || null,
          magnet: h.magnetUrl || magnet(h.hash, h.title),
          quality: rel.quality, codec: rel.codec, sourceTag: rel.sourceTag,
          network: rel.network, audio: rel.audio, langs: rel.langs,
          isPack: rel.isPack, isEpisode: rel.episode !== null,
          season: rel.season, episode: rel.episode,
          sizeMB: (h.bytes || 0) / 1048576,
          seeds: h.seeders || 0,
          __name: h.title
        };
      });
  }
}

const instance = new Knaben();
register(instance);
export default instance;
export { Knaben };
