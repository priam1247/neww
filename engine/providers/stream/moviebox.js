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
  .replace(/\((\d{4})\)/g, '$1')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

/** Best search hit for a title (+ optional year). */
function pickMatch(items, { title, year, type = null }) {
  const want = norm(title);
  let best = null;
  let bestScore = -Infinity;

  for (const it of items) {
    const sub = it?.subject || it;
    const name = sub?.title || it?.title || '';
    if (!name) continue;

    // subjectType: 1 = movie, 2 = series
    const kind = Number(sub?.subjectType) === 2 ? 'series' : 'movie';
    let s = 0;
    if (type) s += kind === type ? 15 : -25;
    const got = norm(name);
    if (got === want) s += 60;
    else if (got.startsWith(want) || want.startsWith(got)) s += 30;
    else if (got.includes(want)) s += 15;
    else s -= 20;

    const rel = String(sub?.releaseDate || it?.releaseDate || '').slice(0, 4);
    if (year && rel) {
      const d = Math.abs(Number(rel) - Number(year));
      s += d === 0 ? 25 : d === 1 ? 10 : -20;
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

class MovieBox extends Provider {
  constructor() {
    // tier 3 (streams), high trust: a real API, not a scraper
    super({ id: 'moviebox', tier: 3, kinds: ['file', 'hls'], trust: 1.15 });
  }

  async search(media, opts) {
    const isSeries = media.type === 'series';
    const season = Number(opts.season ?? 1);
    const episode = Number(opts.episode ?? 1);

    // 1 — find the title
    const found = await bff('/subject/search', {
      method: 'POST',
      body: { keyword: String(media.title || '').trim(), page: 1, perPage: 20 },
    });
    const inner = found?.data || {};
    const items = inner.items || inner.list || [];
    if (!items.length) return [];

    const match = pickMatch(items, { title: media.title, year: media.year, type: media.type });
    if (!match || !match.detailPath || !match.subjectId) {
      mlog.debug(`${media.title}: no match in ${items.length} result(s)`);
      return [];
    }

    // 2 — ask for the stream. Movies are addressed as se=0/ep=0, but a few
    //     titles only answer on 1/1, so try both before giving up.
    const attempts = isSeries ? [[season, episode]] : [[0, 0], [1, 1]];
    let got = null;
    for (const [se, ep] of attempts) {
      try {
        const r = await play(match, se, ep);
        if (r.hasResource && (r.streams.length || r.hls.length)) { got = r; break; }
      } catch (e) {
        mlog.debug(`${match.title} se=${se} ep=${ep} · ${e.message}`);
        if (e.status === 404 || e.status === 403) {
          domain = null;                        // force a fresh player origin
          try {
            const r = await play(match, se, ep);
            if (r.hasResource && (r.streams.length || r.hls.length)) { got = r; break; }
          } catch { /* next attempt */ }
        }
      }
    }
    if (!got) {
      mlog.debug(`${match.title}: no playable resource`);
      return [];
    }

    const out = [];
    const headers = { referer: got.referer };
    const label = `${match.title}${match.year ? ` ${match.year}` : ''}`;

    // direct MP4 per resolution — the best case for this bot (no ffmpeg, no HLS)
    for (const s of got.streams) {
      const url = s?.url;
      if (!url || !/^https?:/i.test(url)) continue;
      const height = Number(s.resolutions) || 0;
      out.push({
        provider: this.id,
        kind: /\.m3u8(\?|$)/i.test(url) ? 'hls' : 'file',
        url,
        title: `${label} ${height}p`,
        quality: height || Number(opts.want) || 1080,
        codec: s.codecName || 'x264',
        sourceTag: 'WEBRIP',
        audio: [], langs: [],
        isPack: false,
        isEpisode: isSeries,
        season: isSeries ? season : null,
        episode: isSeries ? episode : null,
        sizeMB: toMB(s.size),
        seeds: 999,
        __name: `moviebox ${height || '?'}p`,
        headers,
      });
    }

    // HLS fallbacks (the engine downloads these natively, still no ffmpeg)
    for (const h of got.hls) {
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

    if (out.length) {
      mlog.debug(`${match.title} · ${out.length} stream(s) · best ${out[0].quality}p`);
    }
    return out;
  }

  async resolve(c) { return { url: c.url, sizeMB: c.sizeMB, filename: c.title, headers: c.headers }; }
}

const instance = new MovieBox();
register(instance);
export default instance;
export { MovieBox, pickMatch, toMB };
