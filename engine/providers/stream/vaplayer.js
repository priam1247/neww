// engine/providers/stream/vaplayer.js — VaPlayer JSON API (HLS, no key).
//
//   GET https://streamdata.vaplayer.ru/api.php?imdb=tt…&type=movie
//       …&season=1&episode=1 for series
//   → { status_code: "200", data: { stream_urls: [master.m3u8, …] } }
//
// Needs the IMDb id (which Cinemeta/IMDb/TMDB all give us) and returns several
// master playlists — we hand each one to the resolver as an HLS candidate.
import { Provider, register } from '../../core/registry.js';
import { req } from '../../core/http.js';

const API = 'https://streamdata.vaplayer.ru/api.php';
const PLAYER = 'https://nextgencloudfabric.com';

class VaPlayer extends Provider {
  constructor() { super({ id: 'vaplayer', tier: 3, kinds: ['hls'], trust: 0.9 }); }

  async search(media, opts) {
    const imdb = media.imdbId;
    if (!imdb || !/^tt\d+/.test(imdb)) return [];

    const isSeries = media.type === 'series';
    const params = new URLSearchParams({ imdb, type: isSeries ? 'tv' : 'movie' });
    if (isSeries) {
      params.set('season', String(opts.season ?? 1));
      params.set('episode', String(opts.episode ?? 1));
    }

    const referer = isSeries
      ? `${PLAYER}/embed/tv/${imdb}/${opts.season ?? 1}/${opts.episode ?? 1}`
      : `${PLAYER}/embed/movie/${imdb}`;

    const data = await req(`${API}?${params.toString()}`, {
      headers: { referer, origin: PLAYER, accept: 'application/json, */*' }
    });

    const status = String(data?.status_code ?? '');
    if (status !== '200') return [];

    const urls = (data?.data?.stream_urls || []).filter((u) => typeof u === 'string' && /^https?:/i.test(u));
    return urls.map((url, i) => ({
      provider: this.id,
      kind: 'hls',
      url,
      title: `vaplayer ${i + 1}`,
      quality: Number(opts.want) || 1080,     // master playlist: real height is picked at download
      codec: 'x264',
      sourceTag: 'WEBRIP',
      audio: [], langs: [],
      isPack: false,
      isEpisode: isSeries,
      season: opts.season ?? null,
      episode: opts.episode ?? null,
      sizeMB: 0,
      seeds: 999,
      __name: `vaplayer ${i + 1}`,
      headers: { referer, origin: PLAYER }
    }));
  }

  async resolve(c) { return { url: c.url, sizeMB: c.sizeMB, filename: c.title }; }
}

const instance = new VaPlayer();
register(instance);
export default instance;
export { VaPlayer };
