// src/providers/ddl/moviesdrive.js — DDL scraper (3 mirrors, zero-dep parsing).
import { Provider, register } from '../../core/registry.js';
import { req, anchors } from '../../core/http.js';
import { parseRelease } from '../../core/release.js';

const HOSTS = ['https://moviesdrive.vin', 'https://moviesdrive.download', 'https://moviesdrive.cyou'];
const LOCKER = /hubcloud|gdflix|drive\.google|gdtot|filepress|instantlinks|linksgo/i;

class MoviesDrive extends Provider {
  constructor() { super({ id: 'moviesdrive', tier: 2, kinds: ['direct'], trust: 0.9 }); }

  async search(media, opts) {
    const q = opts.season ? `${media.title} season ${opts.season}` : media.title;
    let lastErr;

    for (const host of HOSTS) {
      try {
        const res = await req(`${host}/?s=${encodeURIComponent(q.trim())}`, { json: false });
        const links = anchors(await res.text(), host).filter(x => x.href && x.text);
        if (!links.length) continue;

        const page = await req(links[0].href, { json: false });
        const out = [];
        for (const a of anchors(await page.text(), links[0].href)) {
          // the locker expects the DDL page as Referer
          const headers = { referer: links[0].href };
          if (!LOCKER.test(a.href)) continue;
          const rel = parseRelease(a.text);
          if (!rel.quality) continue;
          if (opts.episode && rel.episode && rel.episode !== opts.episode) continue;

          out.push({
            provider: this.id, kind: 'direct', url: a.href, title: a.text,
            quality: rel.quality, codec: rel.codec, sourceTag: rel.sourceTag || 'WEBDL',
            network: rel.network, audio: rel.audio, langs: rel.langs,
            isPack: rel.isPack, isEpisode: rel.episode !== null,
            season: rel.season, episode: rel.episode, sizeMB: 0,
            seeds: 999, __name: a.text, needsResolve: true, headers
          });
        }
        if (out.length) return out;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('moviesdrive unreachable');
  }
}

const instance = new MoviesDrive();
register(instance);
export default instance;
export { MoviesDrive };
