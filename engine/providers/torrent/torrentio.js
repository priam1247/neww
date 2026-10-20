// src/providers/torrent/torrentio.js — Torrentio Stremio addon (2 mirrors).
import { Provider, register } from '../../core/registry.js';
import { req } from '../../core/http.js';
import { parseRelease } from '../../core/release.js';
import { magnet } from './_trackers.js';

const MIRRORS = [
  'https://torrentio.strem.fun',
  'https://torrentio.strem.fun/lite'
];

class Torrentio extends Provider {
  constructor() { super({ id: 'torrentio', tier: 1, kinds: ['torrent'], trust: 1.4 }); }

  async search(media, opts) {
    if (!media.imdbId) return [];
    const path = media.type === 'movie'
      ? `stream/movie/${media.imdbId}.json`
      : `stream/series/${media.imdbId}:${opts.season}:${opts.episode}.json`;

    let lastErr;
    for (const base of MIRRORS) {
      try {
        const d = await req(`${base}/${path}`);
        return (d.streams || []).map(s => {
          const blob = `${s.name || ''} ${s.title || ''} ${s.behaviorHints?.filename || ''}`;
          const rel = parseRelease(blob);
          const seeds = Number(/👤\s*(\d+)/.exec(blob)?.[1] || 0);
          const sizeMB = (() => {
            const m = /💾\s*([\d.]+)\s*(GB|MB)/i.exec(blob);
            return m ? parseFloat(m[1]) * (/G/i.test(m[2]) ? 1024 : 1) : 0;
          })();
          return {
            provider: this.id, kind: 'torrent',
            title: (s.title || '').split('\n')[0] || s.name || 'torrent',
            hash: s.infoHash || null, fileIdx: s.fileIdx ?? null,
            magnet: s.infoHash ? magnet(s.infoHash, s.title) : null,
            quality: rel.quality, codec: rel.codec, sourceTag: rel.sourceTag,
            network: rel.network, audio: rel.audio, langs: rel.langs,
            isPack: rel.isPack, isEpisode: rel.episode !== null,
            season: rel.season, episode: rel.episode,
            sizeMB, seeds, __name: blob
          };
        }).filter(x => x.magnet);
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('torrentio unreachable');
  }
}

const instance = new Torrentio();
register(instance);
export default instance;
export { Torrentio };
