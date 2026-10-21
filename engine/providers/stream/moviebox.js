// engine/providers/stream/moviebox.js — MovieBox via its own BFF (no scraping).
//
// MovieBox ships a real JSON API behind the mobile app; the browser sites are
// only a shell around it. Talking to the BFF directly means no HTML parsing,
// no Cloudflare, and no ffmpeg — /subject/play answers with direct MP4 links
// (plus HLS/DASH for some titles) that the bot can stream straight to disk.
//
// Protocol (reverse-engineered from the app, see solo12345689/moviebox-internal-api):
//
//   1. GET  {BFF}/home?host=moviebox.ph        → guest JWT in the `x-user`
//                                                response header (no key, no login)
//   2. POST {BFF}/subject/search   {keyword}   → items[].subjectId + detailPath
//   3. GET  {BFF}/media-player/get-domain      → CDN/player origin (rotates)
//   4. GET  {player}/wefeed-h5api-bff/subject/play
//          ?subjectId=…&se=…&ep=…&detailPath=… → streams[] {url, resolutions, size}
//
// The guest token expires; a 401 re-acquires it once and replays the request.
import { Provider, register } from '../../core/registry.js';
import config from '../../config.js';
import { log } from '../../core/log.js';
import { nextUserAgent } from '../../core/http.js';

const mlog = log.child('moviebox');

const BFF = process.env.MOVIEBOX_BFF || 'https://h5-api.aoneroom.com/wefeed-h5api-bff';
const HOME_HOST = 'moviebox.ph';
const TIMEOUT = Number(process.env.MOVIEBOX_TIMEOUT_MS || 12000);
const DOMAIN_TTL = 5 * 60_000;
const TOKEN_TTL = 50 * 60_000;           // the guest JWT lives ~1h; refresh early

const BASE_HEADERS = () => ({
  'user-agent': nextUserAgent(),
  referer: 'https://moviebox.ph/',
  origin: 'https://moviebox.ph',
  accept: 'application/json',
  'content-type': 'application/json',
  'x-client-info': '{"timezone":"Africa/Blantyre"}',
  'x-request-lang': 'en',
});

let token = null;
let tokenAt = 0;
let tokenInflight = null;
let domain = null;
let domainAt = 0;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** `size` is bytes in the API; a few builds send "1.2 GB" instead. */
function toMB(size) {
  if (size === undefined || size === null || size === '') return 0;
  if (typeof size === 'string') {
    const m = /([\d.]+)\s*(GB|MB|KB|B)/i.exec(size);
    if (m) {
      const n = parseFloat(m[1]);
      const unit = m[2].toUpperCase();
      return unit === 'GB' ? n * 1024 : unit === 'MB' ? n : unit === 'KB' ? n / 1024 : n / 1048576;
    }
    const num = Number(size);
    return Number.isFinite(num) ? toMB(num) : 0;
  }
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 100_000 ? n / 1048576 : n;      // big numbers are bytes, small ones MB
}

// ── guest token ────────────────────────────────────────────────────────────
async function fetchToken() {
  const res = await fetch(`${BFF}/home?host=${HOME_HOST}`, {
    headers: BASE_HEADERS(), signal: AbortSignal.timeout(TIMEOUT), redirect: 'follow',
  });
  if (!res.ok) throw new Error(`guest token HTTP ${res.status}`);

  // Preferred: the API returns the session as a JSON blob in `x-user`.
  const xUser = res.headers.get('x-user');
  if (xUser) {
    try {
      const t = JSON.parse(xUser)?.token;
      if (t) return t;
    } catch { /* older builds use the cookie below */ }
  }

  // Fallback: `set-cookie: token=…`
  const cookies = res.headers.getSetCookie?.() || [];
  for (const c of cookies) {
    const m = /(?:^|[;,]\s*)token=([^;]+)/.exec(c);
    if (m) return m[1];
  }
  throw new Error('no guest token in response');
}

async function guestToken(force = false) {
  if (!force && token && Date.now() - tokenAt < TOKEN_TTL) return token;
  if (tokenInflight) return tokenInflight;

  tokenInflight = (async () => {
    const t = await fetchToken();
    token = t;
    tokenAt = Date.now();
    mlog.debug('guest token acquired');
    return t;
  })();

  try { return await tokenInflight; } finally { tokenInflight = null; }
}

// ── BFF request with token refresh + one retry on a rate limit ────────────
async function bff(path, { method = 'GET', body = null, retries = 1 } = {}) {
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const t = await guestToken(attempt > 0 && lastErr?.status === 401);
    const headers = { ...BASE_HEADERS() };
    if (t) headers.authorization = `Bearer ${t}`;

    let res;
    try {
      res = await fetch(`${BFF}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT),
        redirect: 'follow',
      });
    } catch (e) {
      lastErr = Object.assign(new Error(e.message || 'bff unreachable'), { code: 'NETWORK' });
      if (attempt < retries) { await sleep(400); continue; }
      throw lastErr;
    }

    // the API hands out a refreshed token on every response
    const fresh = res.headers.get('x-user');
    if (fresh) {
      try {
        const nt = JSON.parse(fresh)?.token;
        if (nt && nt !== token) { token = nt; tokenAt = Date.now(); }
      } catch { /* ignore */ }
    }

    if (res.status === 401 && attempt < retries) {
      lastErr = Object.assign(new Error('guest token rejected'), { status: 401, code: 'AUTH' });
      token = null;
      continue;
    }
    if (res.status === 429 && attempt < retries) {
      await sleep(800 + Math.random() * 700);
      lastErr = Object.assign(new Error('rate limited'), { status: 429, code: 'RATE_LIMIT' });
      continue;
    }
    if (!res.ok) {
      throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    }

    const json = await res.json().catch(() => null);
    return json;
  }
  throw lastErr || new Error('bff failed');
}

/** Player origin (rotates between CDNs; cached for 5 minutes). */
async function playerDomain(force = false) {
  if (!force && domain && Date.now() - domainAt < DOMAIN_TTL) return domain;
  const j = await bff('/media-player/get-domain');
  const d = typeof j?.data === 'string' ? j.data : null;
  if (!d) throw new Error('no player domain');
  domain = d.replace(/\/+$/, '');
  domainAt = Date.now();
  return domain;
}

const norm = (s) => String(s || '')
  .toLowerCase()
  .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// Re-uploads with tags in the name are where trailers and 2-minute fakes live.
const JUNK_RX = /\[[^\]]*\]|\b(trailer|teaser|full movie|hdcam|cam ?rip|reaction|review|clip)\b/i;

/** Seconds a stream must run to be the real thing (null → no check). */
function minStreamSeconds(media, isSeries) {
  const rt = Number(isSeries ? (media.episodeRuntime || media.runtime) : media.runtime) || 0;
  if (isSeries) return rt ? rt * 60 * 0.5 : 5 * 60;
  return Math.max(40 * 60, rt * 60 * 0.6);
}

/** Best search hit for a title (+ optional year). */
function pickMatch(items, { title, year, type = null }) {
  const want = norm(title);
  const wantedTokens = want.split(' ').filter(Boolean);
  let best = null;
  let bestScore = -Infinity;

  for (const it of items) {
    const sub = it?.subject || it;
    const name = sub?.title || it?.title || '';
    if (!name) continue;

    // subjectType: 1 = movie, 2 = series, anything else (6 = music …) is not a title
    const st = Number(sub?.subjectType);
    if (st !== 1 && st !== 2) continue;
    const kind = st === 2 ? 'series' : 'movie';
    const got = norm(name);
    const gotTokens = got.split(' ').filter(Boolean);
    const rel = String(sub?.releaseDate || it?.releaseDate || '').slice(0, 4);
    if (kind === 'movie' && year && rel && Math.abs(Number(rel) - Number(year)) > 1) continue;
    if (got !== want) {
      const gotSet = new Set(gotTokens);
      if (!wantedTokens.every(token => gotSet.has(token))) continue;
      const extraTokens = gotTokens.filter(token => !wantedSet.has(token)).length;
      if (extraTokens > 2) continue;
    }

    let s = 0;
    if (JUNK_RX.test(name)) s -= 35;
    const dur = Number(sub?.duration || it?.duration) || 0;
    if (kind === 'movie' && dur > 0 && dur < 40 * 60) s -= 60;
    if (type) s += kind === type ? 15 : -25;
    s += got === want ? 120 : 70;

    if (year && rel) {
      const d = Math.abs(Number(rel) - Number(year));
      s += d === 0 ? 25 : 10;
    }
    if (sub?.hasResource) s += 12;

    if (s > bestScore) {
      bestScore = s;
      best = {
        subjectId: String(sub?.subjectId || it?.subjectId || ''),
        detailPath: sub?.detailPath || it?.detailPath || '',
        title: name,
        year: rel || null,
        type: Number(sub?.subjectType) === 2 ? 'series' : 'movie',
        hasResource: Boolean(sub?.hasResource),
      };
    }
  }
  return bestScore >= 20 ? best : null;
}

/** /subject/play → { streams, hls, hasResource, referer } */
async function play({ subjectId, detailPath }, se, ep) {
  const host = await playerDomain();
  const referer = `${host}/spa/videoPlayPage/movies/${detailPath}` +
    `?id=${subjectId}&type=/movie/detail&detailSe=${se}&detailEp=${ep}&lang=en`;
  const url = `${host}/wefeed-h5api-bff/subject/play?subjectId=${encodeURIComponent(subjectId)}` +
    `&se=${se}&ep=${ep}&detailPath=${encodeURIComponent(detailPath)}`;

  const res = await fetch(url, {
    headers: { ...BASE_HEADERS(), accept: 'application/json', referer, 'x-source': '' },
    signal: AbortSignal.timeout(TIMEOUT),
    redirect: 'follow',
  });
  if (!res.ok) {
    // a rotated player domain is the usual cause — refresh it once
    if (res.status === 404 || res.status === 403) domain = null;
    throw Object.assign(new Error(`play HTTP ${res.status}`), { status: res.status });
  }
  const j = await res.json().catch(() => null);
  const data = j?.data || {};
  return {
    referer,
    hasResource: data.hasResource !== false,
    streams: Array.isArray(data.streams) ? data.streams : [],
    hls: Array.isArray(data.hls) ? data.hls : [],
    dash: Array.isArray(data.dash) ? data.dash : [],
  };
}

// A short-lived hit cache: subtitles ask for the same title right after the
// episode was resolved, and a range of episodes must not re-search per file.
const HIT_TTL = 10 * 60 * 1000;
const hits = new Map();

function hitKey(media, season, episode, isSeries) {
  return [
    String(media.title || '').toLowerCase().trim(),
    media.year || '', isSeries ? 'series' : 'movie', season, episode,
  ].join('|');
}

/**
 * Title → the BFF's own match → the play payload.
 * Shared by search() and the subtitle helper so a season pack does not search
 * the same show once per episode more than necessary.
 */
async function locate(media, opts = {}) {
  const isSeries = media.type === 'series';
  const season = Number(opts.season ?? 1);
  const episode = Number(opts.episode ?? 1);

  const key = hitKey(media, season, episode, isSeries);
  const cached = hits.get(key);
  if (cached && cached.until > Date.now()) return cached.hit;
  hits.delete(key);

  const found = await bff('/subject/search', {
    method: 'POST',
    body: { keyword: String(media.title || '').trim(), page: 1, perPage: 20 },
  });
  const inner = found?.data || {};
  const items = inner.items || inner.list || [];
  if (!items.length) return null;

  const match = pickMatch(items, { title: media.title, year: media.year, type: media.type });
  if (!match || !match.detailPath || !match.subjectId) {
    mlog.debug(`${media.title}: no match in ${items.length} result(s)`);
    return null;
  }

  // movies are addressed se=0/ep=0, but a few titles only answer on 1/1
  const attempts = isSeries ? [[season, episode]] : [[0, 0], [1, 1]];
  for (const [se, ep] of attempts) {
    try {
      let r = await play(match, se, ep);
      if (!r.hasResource || (!r.streams.length && !r.hls.length)) {
        // a rotated player origin answers 403/404 once; refresh and retry
        if (!domain) continue;
        domain = null;
        r = await play(match, se, ep);
      }
      if (r.hasResource && (r.streams.length || r.hls.length)) {
        const hit = { match, payload: r, se, ep, isSeries, season, episode };
        if (hits.size > 40) hits.delete(hits.keys().next().value);
        hits.set(key, { hit, until: Date.now() + HIT_TTL });
        return hit;
      }
    } catch (e) {
      mlog.debug(`${match.title} se=${se} ep=${ep} · ${e.message}`);
      if (e.status === 403 || e.status === 404) domain = null;
    }
  }
  mlog.debug(`${match.title}: no playable resource`);
  return null;
}

/**
 * Subtitle tracks for a title (MovieBox serves them next to the stream).
 *
 * `target` is either a media meta object (then the title is located here) or a
 * `locate()` hit — passing the hit back avoids searching/playing twice per
 * delivery.
 * @returns {Promise<Array<{language:string, url:string, format:string}>>}
 */
export async function captions(target, opts = {}) {
  const hit = target && target.payload ? target : await locate(target, opts);
  if (!hit) return [];

  const stream = hit.payload.streams[0] || hit.payload.dash?.[0] || null;
  const format = stream?.format || 'MP4';
  const id = stream?.id;
  if (!id) return [];

  // The BFF has used more than one name for this route; ask each once and take
  // the first answer that actually carries tracks.
  const routes = ['/subject/caption', '/subject/captions', '/subject/subtitle'];
  for (const route of routes) {
    const qs = new URLSearchParams({
      format: String(format),
      id: String(id),
      subjectId: hit.match.subjectId,
      detailPath: hit.match.detailPath,
    });
    let j = null;
    try {
      j = await bff(`${route}?${qs.toString()}`);
    } catch (e) {
      mlog.debug(`captions ${route} · ${e.message}`);
      continue;
    }
    const inner = j?.data ?? {};
    const list = Array.isArray(inner)
      ? inner
      : (inner.captions || inner.list || inner.subtitles || inner.tracks || []);
    const tracks = (Array.isArray(list) ? list : [])
      .map(c => ({
        language: c.language || c.lan || c.lang || c.code || 'und',
        url: c.url || c.src || c.subtitleUrl || null,
        format: String(c.format || c.ext || 'srt').toLowerCase(),
      }))
      .filter(c => c.url && /^https?:/i.test(c.url));
    if (tracks.length) return tracks;
  }
  return [];
}

/** Does this buffer look like a subtitle file rather than an HTML error page? */
function looksLikeSubtitle(buf) {
  const head = buf.slice(0, 4096).toString('utf8').replace(/^\uFEFF/, '').trim();
  if (!head) return false;
  if (/^<(!doctype|html)/i.test(head)) return false;
  return /-->/.test(head) || /^WEBVTT/i.test(head);
}

/**
 * Download one subtitle file.
 * @returns {Promise<{file:string, language:string, url:string, bytes:number}|null>}
 */
export async function fetchSubtitle(target, opts = {}) {
  const prefer = String(opts.lang || 'en').toLowerCase();
  let tracks = [];
  const hit = target && target.payload ? target : null;
  try { tracks = await captions(hit || target, opts); } catch (e) { mlog.debug(`captions · ${e.message}`); return null; }
  if (!tracks.length) return null;

  // best language first, then anything else that is likely to be English-ish
  const ranked = tracks.slice().sort((a, b) => {
    const score = (t) => {
      const l = String(t.language).toLowerCase();
      if (l === prefer) return 0;
      if (l.startsWith(prefer)) return 1;
      if (prefer === 'en' && /english|eng/.test(l)) return 2;
      if (prefer === 'en' && /unknown|und/.test(l)) return 3;
      return 4;
    };
    return score(a) - score(b);
  });

  const dest = opts.dest || null;
  if (!dest) {
    const pick0 = ranked[0];
    return { file: null, language: pick0.language, url: pick0.url };
  }

  const fs = await import('node:fs');
  const path = await import('node:path');
  for (const pick of ranked.slice(0, 3)) {
    try {
      const res = await fetch(pick.url, { signal: AbortSignal.timeout(TIMEOUT), redirect: 'follow' });
      if (!res.ok) throw new Error(`subtitle HTTP ${res.status}`);
      let buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 20) throw new Error('empty subtitle');
      if (!looksLikeSubtitle(buf)) throw new Error('not a subtitle file');

      // keep the real container: WEBVTT must not be shipped as .srt
      const isVtt = /^\uFEFF?\s*WEBVTT/i.test(buf.slice(0, 64).toString('utf8'));
      const finalDest = isVtt && !/\.vtt$/i.test(dest) ? dest.replace(/\.[^.]+$/, '.vtt') : dest;
      fs.mkdirSync(path.dirname(finalDest), { recursive: true });
      fs.writeFileSync(finalDest, buf);
      return { file: finalDest, language: pick.language, url: pick.url, bytes: buf.length };
    } catch (e) {
      mlog.debug(`subtitle ${pick.language} · ${e.message}`);
    }
  }
  return null;
}

class MovieBox extends Provider {
  constructor() {
    // tier 3 (streams), high trust: a real API, not a scraper
    super({ id: 'moviebox', tier: 3, kinds: ['file', 'hls'], trust: 1.15 });
  }

  async search(media, opts) {
    const hit = await locate(media, opts);
    if (!hit) return [];

    const { match, payload, isSeries, season, episode } = hit;
    const out = [];
    const headers = { referer: payload.referer };
    const label = `${match.title}${match.year ? ` ${match.year}` : ''}`;

    const minSec = minStreamSeconds(media, isSeries);
    // direct MP4 per resolution — the best case for this bot (no ffmpeg, no HLS)
    for (const st of payload.streams) {
      const url = st?.url;
      if (!url || !/^https?:/i.test(url)) continue;
      const secs = Number(st.duration) || 0;
      if (secs && secs < minSec) {
        mlog.debug(`${match.title} · ${st.resolutions}p stream is ${secs}s — trailer/fake, skipped`);
        continue;
      }
      const height = Number(st.resolutions) || 0;
      out.push({
        provider: this.id,
        kind: /\.m3u8(\?|$)/i.test(url) ? 'hls' : 'file',
        url,
        title: `${label} ${height}p`,
        quality: height || Number(opts.want) || 1080,
        codec: st.codecName || 'x264',
        sourceTag: 'WEBRIP',
        audio: [], langs: [],
        isPack: false,
        isEpisode: isSeries,
        season: isSeries ? season : null,
        episode: isSeries ? episode : null,
        sizeMB: toMB(st.size),
        seeds: 999,
        __name: `moviebox ${height || '?'}p`,
        headers,
      });
    }

    // HLS fallbacks (the engine downloads these natively, still no ffmpeg)
    for (const h of payload.hls) {
      const url = typeof h === 'string' ? h : h?.url;
      if (!url || !/^https?:/i.test(url)) continue;
      const height = Number(h?.resolutions) || Number(opts.want) || 1080;
      out.push({
        provider: this.id,
        kind: 'hls',
        url,
        title: `${label} ${height}p (hls)`,
        quality: height,
        codec: 'x264',
        sourceTag: 'WEBRIP',
        audio: [], langs: [],
        isPack: false,
        isEpisode: isSeries,
        season: isSeries ? season : null,
        episode: isSeries ? episode : null,
        sizeMB: 0,
        seeds: 999,
        __name: `moviebox ${height}p hls`,
        headers,
      });
    }

    if (out.length) mlog.debug(`${match.title} · ${out.length} stream(s) · best ${out[0].quality}p`);
    return out;
  }

  async resolve(c) { return { url: c.url, sizeMB: c.sizeMB, filename: c.title, headers: c.headers }; }
}

const instance = new MovieBox();
register(instance);
export default instance;
export { MovieBox, pickMatch, toMB, locate, minStreamSeconds };
