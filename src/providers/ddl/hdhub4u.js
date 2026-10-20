// src/providers/ddl/hdhub4u.js — DDL scraper, ZERO-DEP (regex DOM helpers).
// 2.0 hard-required cheerio for this; 3.0's http.anchors() does the job.
import { Provider, register } from '../../core/registry.js';
import { req, anchors } from '../../core/http.js';
import { parseRelease } from '../../core/release.js';

const HOSTS = ['https://new3.hdhub4u.free', 'https://new4.hdhub4u.cl', 'https://hdhub4u.fans'];
const LOCKER = /hubcloud|gdflix|drive\.google|gdtot|filepress|hubdrive/i;
const sizeOf = (t) => { const m = /([\d.]+)\s*(GB|MB)/i.exec(t); return m ? parseFloat(m[1]) * (/G/i.test(m[2]) ? 1024 : 1) : 0; };

class Hdhub4u extends Provider {
  constructor() { super({ id: 'hdhub4u', tier: 2, kinds: ['direct'], trust: 1.0 }); }

  async search(media, opts) {
    const q = opts.season ? `${media.title} season ${opts.season}` : `${media.title} ${media.year || ''}`;
    let lastErr;

    for (const host of HOSTS) {
      try {
        const res = await req(`${host}/?s=${encodeURIComponent(q.trim())}`, { json: false });
        const html = await res.text();
        const firstWord = media.title.toLowerCase().split(' ')[0];

        const post = anchors(html, host)
          .filter(x => x.href && x.text && x.text.toLowerCase().includes(firstWord))
          .find(x => /\/\d{4}\/|\/movie|\/series|\/episode|\/web-?series/i.test(x.href));
        if (!post) continue;

        const page = await req(post.href, { json: false });
        const out = [];
        for (const a of anchors(await page.text(), post.href)) {
          if (!LOCKER.test(a.href)) continue;
          const rel = parseRelease(a.text);
          if (!rel.quality) continue;
          if (opts.season && rel.season && rel.season !== opts.season) continue;
          if (opts.episode && rel.episode && rel.episode !== opts.episode) continue;

          out.push({
            provider: this.id, kind: 'direct', url: a.href,
            title: a.text, quality: rel.quality, codec: rel.codec,
            sourceTag: rel.sourceTag, network: rel.network,
            audio: rel.audio, langs: rel.langs,
            isPack: rel.isPack, isEpisode: rel.episode !== null,
            season: rel.season, episode: rel.episode,
            sizeMB: sizeOf(a.text),
            seeds: 999, __name: a.text, needsResolve: true
          });
        }
        if (out.length) return out;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('hdhub4u unreachable');
  }
}

const instance = new Hdhub4u();
register(instance);
export default instance;
export { Hdhub4u };
