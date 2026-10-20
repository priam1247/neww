// src/providers/torrent/nyaa.js — Nyaa anime indexer via RSS (infoHash included).
import { Provider, register } from '../../core/registry.js';
import { req } from '../../core/http.js';
import { parseRelease } from '../../core/release.js';
import { magnet } from './_trackers.js';

class Nyaa extends Provider {
  constructor() { super({ id: 'nyaa', tier: 1, kinds: ['torrent'], trust: 1.1 }); }

  async search(media, opts) {
    const q = opts.anime
      ? opts.query
      : `${media.title} ${opts.season ? `S${String(opts.season).padStart(2, '0')}E${String(opts.episode).padStart(2, '0')}` : media.year || ''}`;
    const url = `https://nyaa.si/?page=rss&q=${encodeURIComponent(q.trim())}&c=1_2&f=0`;
    const res = await req(url, { json: false });
    const xml = await res.text();

    const items = xml.split('<item>').slice(1);
    return items.map(chunk => {
      const pick = (tag) => (new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(chunk) || [])[1] || '';
      const title = pick('title').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
      const hash = pick('nyaa:infoHash') || pick('infoHash');
      const seeds = Number(pick('nyaa:seeders') || 0);
      const sizeStr = pick('nyaa:size') || '';
      const m = /([\d.]+)\s*(GiB|MiB|GB|MB)/i.exec(sizeStr);
      const sizeMB = m ? parseFloat(m[1]) * (/G/i.test(m[2]) ? 1024 : 1) : 0;
      const rel = parseRelease(title);
      return {
        provider: this.id, kind: 'torrent', title, hash: hash || null,
        magnet: hash ? magnet(hash, title) : null,
        quality: rel.quality, codec: rel.codec, sourceTag: rel.sourceTag,
        network: rel.network, audio: rel.audio, langs: rel.langs,
        isPack: rel.isPack, isEpisode: rel.episode !== null,
        season: rel.season, episode: rel.episode,
        sizeMB, seeds, anime: true, __name: title
      };
    }).filter(x => x.magnet);
  }
}

const instance = new Nyaa();
register(instance);
export default instance;
export { Nyaa };
