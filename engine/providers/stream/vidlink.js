// engine/providers/stream/vidlink.js — VidLink (direct MP4, no ffmpeg needed).
//
// This is the workhorse: it answers with real mp4 files per quality (360/480/
// 720/1080) that the bot can stream straight to disk. Two steps:
//
//   1. the tmdb id is NOT sent in clear — VidLink expects an obfuscated token.
//      The public encoder at enc-dec.app produces it (no key, no account).
//   2. GET /api/b/movie/{token} (or /tv/{token}/{s}/{e}) → qualities[].url
//
// Verified working in Oct 2026: the response contains h264/h265 mp4 links with
// byte sizes, so the ranker can pick a quality that actually fits.
import { Provider, register } from '../../core/registry.js';
import { req } from '../../core/http.js';

const HEADERS = {
  referer: 'https://vidlink.pro/',
  origin: 'https://vidlink.pro',
  accept: 'application/json, text/plain, */*'
};

const toMB = (size) => (size ? Number(size) / 1048576 : 0);

// tmdb id → obfuscated token. Tiny bounded cache: a season pack asks the same
// id once per episode and enc-dec.app must not be hit 10 times for it.
const TOKENS = new Map();
const TOKEN_TTL = 30 * 60_000;

async function tokenFor(tmdb) {
  const key = String(tmdb);
  const hit = TOKENS.get(key);
  if (hit && Date.now() - hit.at < TOKEN_TTL) return hit.token;
  try {
    const enc = await req(`https://enc-dec.app/api/enc-vidlink?text=${encodeURIComponent(key)}`, {
      timeout: 8000, retries: 1
    });
    if (enc?.result) {
      if (TOKENS.size > 500) TOKENS.clear();
      TOKENS.set(key, { token: enc.result, at: Date.now() });
      return enc.result;
    }
  } catch { /* fall through to the plain id */ }
  return key;
}

class VidLink extends Provider {
  constructor() { super({ id: 'vidlink', tier: 3, kinds: ['file', 'hls'], trust: 1.0 }); }

  async search(media, opts) {
    const tmdb = media.tmdbId;
    if (!tmdb) return [];

    // 1 — obfuscate the id (cached; falls back to the raw id)
    const token = await tokenFor(tmdb);

    // 2 — ask for the streams
    const path = media.type === 'series'
      ? `tv/${token}/${opts.season ?? 1}/${opts.episode ?? 1}`
      : `movie/${token}`;

    const data = await req(`https://vidlink.pro/api/b/${path}?multiLang=0`, { headers: HEADERS });
    const qualities = data?.stream?.qualities || {};
    const out = [];

    for (const [label, q] of Object.entries(qualities)) {
      if (!q || !q.url) continue;
      const height = Number(label) === 0 ? 1080 : Number(label);
      out.push({
        provider: this.id,
        kind: /\.m3u8(\?|$)/i.test(q.url) ? 'hls' : 'file',
        url: q.url,
        title: `vidlink ${label}p`,
        quality: Number.isFinite(height) ? height : 1080,
        codec: q.codecName || 'x264',
        sourceTag: 'WEBRIP',
        audio: [], langs: [],
        isPack: false,
        isEpisode: media.type === 'series',
        season: opts.season ?? null,
        episode: opts.episode ?? null,
        sizeMB: toMB(q.size),
        seeds: 999,
        __name: `vidlink ${label}p`,
        headers: { referer: 'https://vidlink.pro/' }
      });
    }

    // master playlist as a last resort (ffmpeg / native HLS picks the variant)
    const playlist = data?.stream?.playlist;
    if (!out.length && typeof playlist === 'string' && /^https?:/.test(playlist)) {
      out.push({
        provider: this.id, kind: 'hls', url: playlist, title: 'vidlink master',
        quality: 1080, codec: 'x264', sourceTag: 'WEBRIP', audio: [], langs: [],
        isPack: false, isEpisode: media.type === 'series',
        season: opts.season ?? null, episode: opts.episode ?? null,
        sizeMB: 0, seeds: 999, __name: 'vidlink master',
        headers: { referer: 'https://vidlink.pro/' }
      });
    }

    return out;
  }

  async resolve(c) { return { url: c.url, sizeMB: c.sizeMB, filename: c.title }; }
}

const instance = new VidLink();
register(instance);
export default instance;
export { VidLink };
