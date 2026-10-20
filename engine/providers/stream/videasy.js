// src/providers/stream/videasy.js — NEW in 3.0. 2.0's media index REQUIRED
// this module but it was missing from the shipped source (a boot crash waiting
// for anyone who imported lib/media). Videasy exposes player JSON per tmdb id.
import { Provider, register } from '../../core/registry.js';
import { req } from '../../core/http.js';
import { sniffUrls } from '../../core/extract.js';

class Videasy extends Provider {
  constructor() { super({ id: 'videasy', tier: 3, kinds: ['hls'], trust: 0.9 }); }

  async search(media, opts) {
    const path = media.type === 'movie'
      ? `movie/${media.tmdbId}`
      : `tv/${media.tmdbId}/${opts.season ?? 1}/${opts.episode ?? 1}`;

    const res = await req(`https://player.videasy.net/${path}`, { json: false });
    const body = await res.text();

    // player pages either embed JSON sources or a packer payload
    let urls = sniffUrls(body, { exts: ['.m3u8', '.mp4'] });

    if (!urls.length) {
      try {
        const d = JSON.parse(body);
        const arr = d?.sources || d?.streams || d?.url ? [d.url || d.sources].flat() : [];
        urls = arr.filter(u => typeof u === 'string' && /m3u8|mp4/.test(u));
      } catch {}
    }
    if (!urls.length) return [];

    return urls.map((u, i) => ({
      provider: this.id, kind: 'hls', url: u, title: `videasy ${i}`,
      quality: /2160/.test(u) ? 2160 : /1080/.test(u) ? 1080 : /720/.test(u) ? 720 : 480,
      codec: 'x264', sourceTag: 'WEBRIP', audio: [], langs: [],
      isPack: false, isEpisode: media.type === 'series',
      season: opts.season ?? null, episode: opts.episode ?? null,
      sizeMB: 0, seeds: 999, __name: `videasy ${i}`
    }));
  }

  async resolve(c) { return { url: c.url, sizeMB: c.sizeMB, filename: c.title }; }
}

const instance = new Videasy();
register(instance);
export default instance;
export { Videasy };
