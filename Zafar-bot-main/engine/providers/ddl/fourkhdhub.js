// src/providers/ddl/fourkhdhub.js — DDL scraper (3 mirrors, zero-dep parsing).
import { Provider, register } from '../../core/registry.js';
import { req, anchors } from '../../core/http.js';
import { parseRelease } from '../../core/release.js';

const HOSTS = ['https://4khdhub.fans', 'https://4khdhub.icu', 'https://4khdhub.casa'];
const LOCKER = /hubcloud|gdflix|drive\.google|hubdrive|filepress/i;
const sizeOf = (t) => { const m = /([\d.]+)\s*(GB|MB)/i.exec(t); return m ? parseFloat(m[1]) * (/G/i.test(m[2]) ? 1024 : 1) : 0; };

class FourKHDHub extends Provider {
  constructor() { super({ id: '4khdhub', tier: 2, kinds: ['direct'], trust: 1.0 }); }

  async search(media, opts) {
    const q = opts.season ? `${media.title} season ${opts.season}` : `${media.title} ${media.year || ''}`;
    let lastErr;

    for (const host of HOSTS) {
      try {
        const res = await req(`${host}/?s=${encodeURIComponent(q.trim())}`, { json: false });
        const links = anchors(await res.text(), host)
          .filter(x => /\/movies\/|\/series\//.test(x.href));
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
            season: rel.season, episode: rel.episode,
            sizeMB: sizeOf(a.text),
            seeds: 999, __name: a.text, needsResolve: true, headers
          });
        }
        if (out.length) return out;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('4khdhub unreachable');
  }
}

const instance = new FourKHDHub();
register(instance);
export default instance;
export { FourKHDHub };
