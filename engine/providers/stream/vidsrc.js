// src/providers/stream/vidsrc.js — vidsrc embed → cloudorizon RCP → m3u8.
import { Provider, register } from '../../core/registry.js';
import { req } from '../../core/http.js';
import { sniffUrls } from '../../core/extract.js';

class VidSrc extends Provider {
  constructor() { super({ id: 'vidsrc', tier: 3, kinds: ['hls'], trust: 0.9 }); }

  async search(media, opts) {
    const path = media.type === 'movie'
      ? `embed/movie?tmdb=${media.tmdbId}`
      : `embed/tv?tmdb=${media.tmdbId}&season=${opts.season}&episode=${opts.episode}`;

    const res = await req(`https://vidsrc.net/${path}`, { json: false });
    const html = await res.text();

    const hash = /data-hash="([^"]+)"/.exec(html)?.[1]
      || /cloudorizon\.com\/rcp\/([a-z0-9]+)/i.exec(html)?.[1]
      || /"hash":"([a-z0-9]+)"/.exec(html)?.[1];
    if (!hash) return [];

    const rcp = await req(`https://cloudorizon.com/rcp/${hash}`, { json: false });
    const urls = sniffUrls(await rcp.text(), { exts: ['.m3u8'] });
    if (!urls.length) return [];

    return urls.map((u, i) => ({
      provider: this.id, kind: 'hls', url: u, title: `vidsrc ${i}`,
      quality: /2160/.test(u) ? 2160 : /1080/.test(u) ? 1080 : /720/.test(u) ? 720 : 480,
      codec: 'x264', sourceTag: 'WEBRIP', audio: [], langs: [],
      isPack: false, isEpisode: media.type === 'series',
      season: opts.season ?? null, episode: opts.episode ?? null,
      sizeMB: 0, seeds: 999, __name: `vidsrc ${i}`
    }));
  }

  async resolve(c) { return { url: c.url, sizeMB: c.sizeMB, filename: c.title }; }
}

const instance = new VidSrc();
register(instance);
export default instance;
export { VidSrc };
