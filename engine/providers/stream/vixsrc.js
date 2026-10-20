// engine/providers/stream/vixsrc.js — vixsrc.to (HLS, no key).
//
// Three steps, all public:
//   1. GET /api/movie/{tmdb}            → { src: "/embed/…" }
//      GET /api/tv/{tmdb}/{s}/{e}
//   2. GET {base}{src}                  → html containing token / expires / url
//   3. GET {url}?token=…&expires=…&h=1  → master playlist (variants per height)
//
// Verified working in Oct 2026 (returns Italian + English audio tracks).
import { Provider, register } from '../../core/registry.js';
import { req } from '../../core/http.js';

const BASE = 'https://vixsrc.to';
const HEADERS = {
  accept: 'application/json, text/javascript, */*; q=0.01',
  'accept-language': 'en-US,en;q=0.9',
  referer: BASE,
  origin: BASE
};

/** Pick the best variant out of a master playlist. */
export function parseVariants(playlist, masterUrl) {
  const out = [];
  const re = /#EXT-X-STREAM-INF:([^\n]*)\n([^\n#]+)/g;
  let m;
  while ((m = re.exec(String(playlist || '')))) {
    const height = Number(/RESOLUTION=\d+x(\d+)/i.exec(m[1])?.[1] || 0);
    const bandwidth = Number(/BANDWIDTH=(\d+)/i.exec(m[1])?.[1] || 0);
    let url = m[2].trim();
    try { url = new URL(url, masterUrl).toString(); } catch { continue; }
    out.push({ height, bandwidth, url });
  }
  return out.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
}

class VixSrc extends Provider {
  constructor() { super({ id: 'vixsrc', tier: 3, kinds: ['hls'], trust: 0.95 }); }

  async search(media, opts) {
    const tmdb = media.tmdbId;
    if (!tmdb) return [];

    const apiUrl = media.type === 'series'
      ? `${BASE}/api/tv/${tmdb}/${opts.season ?? 1}/${opts.episode ?? 1}`
      : `${BASE}/api/movie/${tmdb}`;

    const api = await req(apiUrl, { headers: HEADERS });
    const src = api?.src;
    if (!src) return [];

    const page = await req(`${BASE}${src}`, { headers: { ...HEADERS, accept: 'text/html,application/xhtml+xml' }, json: false });
    const html = await page.text();

    // The embed page carries the same three values in slightly different
    // shapes depending on the build (json object, query string, escaped js),
    // so accept any of them instead of dying on one exact format.
    const token = (
      /token["']?\s*[:=]\s*["']([A-Za-z0-9._~-]{8,})/i.exec(html)?.[1]
      || /[?&]token=([A-Za-z0-9._~-]{8,})/i.exec(html)?.[1]
    );
    const expires = (
      /expires["']?\s*[:=]\s*["']?(\d{9,})/i.exec(html)?.[1]
      || /[?&]expires=(\d{9,})/i.exec(html)?.[1]
    );
    const playlist = (
      /url\s*[:=]\s*["']([^"']+\.m3u8[^"']*)/i.exec(html)?.[1]
      || /https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/i.exec(html)?.[0]
      || /\/playlist\.m3u8[^"'\s\\]*/i.exec(html)?.[0]
    );
    if (!token || !expires || !playlist) return [];

    // a token that is already expired is not worth ranking
    if (Number(expires) * 1000 - 60_000 < Date.now()) return [];

    // some builds already embed the token in the playlist url
    let master = playlist;
    try { master = new URL(playlist, BASE).toString(); } catch { /* relative to BASE below */ }
    if (!/^https?:/i.test(master)) master = `${BASE}${playlist.startsWith('/') ? '' : '/'}${playlist}`;
    if (!/[?&]token=/i.test(master)) {
      master += `${master.includes('?') ? '&' : '?'}token=${token}&expires=${expires}&h=1`;
    }
    const man = await req(master, { headers: { ...HEADERS, referer: apiUrl }, json: false });
    const text = await man.text();
    if (!/#EXTM3U/i.test(text)) return [];

    const variants = parseVariants(text, master);
    if (!variants.length) return [];

    // one candidate per height: the ranker then picks the requested quality
    return variants.slice(0, 4).map((v) => ({
      provider: this.id,
      kind: 'hls',
      url: v.url,
      title: `vixsrc ${v.height}p`,
      quality: v.height || 1080,
      codec: 'x264',
      sourceTag: 'WEBRIP',
      audio: [], langs: [],
      isPack: false,
      isEpisode: media.type === 'series',
      season: opts.season ?? null,
      episode: opts.episode ?? null,
      sizeMB: 0,
      seeds: 999,
      __name: `vixsrc ${v.height}p`,
      headers: { referer: apiUrl, origin: BASE }
    }));
  }

  async resolve(c) { return { url: c.url, sizeMB: c.sizeMB, filename: c.title }; }
}

const instance = new VixSrc();
register(instance);
export default instance;
export { VixSrc };
