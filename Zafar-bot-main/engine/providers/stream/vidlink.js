// src/providers/stream/vidlink.js — vidlink JSON endpoint (cheapest stream tier).
import { Provider, register } from '../../core/registry.js';
import { req } from '../../core/http.js';

class VidLink extends Provider {
  constructor() { super({ id: 'vidlink', tier: 3, kinds: ['hls'], trust: 1.0 }); }

  async search(media, opts) {
    const path = media.type === 'movie'
      ? `movie/${media.tmdbId}`
      : `tv/${media.tmdbId}/${opts.season}/${opts.episode}`;

    const d = await req(`https://vidlink.pro/api/b/${path}`);
    const playlist = d?.stream?.playlist || d?.playlist;
    if (!playlist) return [];

    const qualities = d?.stream?.qualities || d?.qualities || {};
    const mk = (url, title, quality) => ({
      provider: this.id, kind: 'hls', url, title, quality,
      codec: 'x264', sourceTag: 'WEBRIP', audio: [], langs: [],
      isPack: false, isEpisode: media.type === 'series',
      season: opts.season ?? null, episode: opts.episode ?? null,
      sizeMB: 0, seeds: 999, __name: title
    });

    const entries = Array.isArray(qualities)
      ? qualities.map(v => [v.quality || v.resolution || v.label, v])
      : Object.entries(qualities);

    const out = entries
      .map(([q, v]) => mk(v?.url || v, `vidlink ${q || 'auto'}p`, parseInt(q, 10) || 1080))
      .filter(c => typeof c.url === 'string' && /^https?:/.test(c.url));

    // the master playlist is the reliable fallback (ffmpeg picks the best variant)
    if (typeof playlist === 'string' && /^https?:/.test(playlist)) out.push(mk(playlist, 'vidlink master', 1080));
    return out;
  }

  async resolve(c) { return { url: c.url, sizeMB: c.sizeMB, filename: c.title }; }
}

const instance = new VidLink();
register(instance);
export default instance;
export { VidLink };
