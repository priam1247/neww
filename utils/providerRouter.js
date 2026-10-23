/**
 * ZaFar Bot — URL router for background download jobs
 *
 * `route(url)` maps a link to a provider descriptor and `run(provider, req)`
 * executes it. Only sources that can be fetched as ordinary files are routed:
 * DRM-protected subscription services (Netflix, Disney+, Apple TV+, Apple
 * Music, Deezer, Prime Video, Hulu) are refused up front with a clear reason,
 * because their streams are encrypted and the bot does not decrypt them.
 *
 * Supported provider
 *   generic — anything yt-dlp handles, via utils/youtubedl.js (the same engine
 *             `.dl` / `.ytv` use, with cookies, proxy and format fallbacks)
 *
 * Result shape (shared with utils/persistentJobs.js)
 *   { provider, title, quality, path, size, subs[], log }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const log = require('./logger')('router');

const BOT_ROOT = path.resolve(__dirname, '..');

// Hosts whose media is DRM-encrypted and therefore out of scope.
const BLOCKED_HOSTS = new Map([
  ['netflix.com', 'Netflix'],
  ['disneyplus.com', 'Disney+'],
  ['tv.apple.com', 'Apple TV+'],
  ['music.apple.com', 'Apple Music'],
  ['deezer.com', 'Deezer'],
  ['deezer.page.link', 'Deezer'],
  ['primevideo.com', 'Prime Video'],
  ['hulu.com', 'Hulu'],
]);

let engine = null;                       // utils/youtubedl.js, injectable in tests
const getEngine = () => engine || require('./youtubedl');

const mediaDir = () => path.resolve(process.env.MEDIA_DIR || path.join(BOT_ROOT, 'temp'));

function hostOf(url) {
  let parsed;
  try { parsed = new URL(String(url)); } catch { throw Object.assign(new Error('not a URL'), { code: 'BAD_URL' }); }
  if (!/^https?:$/.test(parsed.protocol)) throw Object.assign(new Error(`unsupported protocol: ${parsed.protocol}`), { code: 'BAD_URL' });
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (!host || !host.includes('.')) throw Object.assign(new Error('not a public URL'), { code: 'BAD_URL' });
  return host;
}

function blockedService(host) {
  for (const [domain, label] of BLOCKED_HOSTS) {
    if (host === domain || host.endsWith(`.${domain}`)) return label;
  }
  return null;
}

/**
 * Resolve a link to a provider descriptor. Throws BAD_URL for malformed input;
 * DRM services come back flagged so the caller can explain instead of queueing.
 *
 * @param {string} url
 * @returns {{provider: string, host: string, blocked: boolean, reason?: string, run: (req: object) => Promise<object>}}
 */
function route(url) {
  const host = hostOf(url);
  const service = blockedService(host);

  if (service) {
    const reason = `${service} links are DRM-protected and not supported`;
    return {
      provider: 'unsupported',
      host,
      blocked: true,
      reason,
      run: async () => { throw Object.assign(new Error(reason), { code: 'DRM_UNSUPPORTED', service }); },
    };
  }

  return {
    provider: 'generic',
    host,
    blocked: false,
    run: (req = {}) => run('generic', { url, ...req }),
  };
}

/** Best-effort metadata; a failure here must never fail the download. */
async function titleOf(url) {
  try {
    const info = await getEngine().getInfo(url);
    return String(info?.title || info?.fulltitle || '').trim();
  } catch (e) {
    log.warn(`metadata lookup failed for ${url}: ${e.message}`);
    return '';
  }
}

/** Sidecar subtitles (best effort — a failed fetch leaves `subs` empty). */
async function fetchSubs(url, outBase, langs) {
  const list = (Array.isArray(langs) ? langs : String(langs || '').split(','))
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  if (!list.length) return [];

  try {
    await getEngine().run([
      '--skip-download',
      '--write-subs', '--write-auto-subs',
      '--sub-langs', list.join(','),
      '--convert-subs', 'vtt',
      '-o', `${outBase}.%(ext)s`,
      url,
    ], { timeout: 120000 });
  } catch (e) {
    log.warn(`subtitle fetch failed for ${url}: ${e.message}`);
    return [];
  }

  const base = path.basename(outBase);
  const dir = path.dirname(outBase);
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.startsWith(`${base}.`) && name.endsWith('.vtt'))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/**
 * Generic yt-dlp download. Returns a path on disk; the caller owns cleanup.
 *
 * @param {{url: string, height?: number, maxMB?: number, subs?: string[]}} req
 */
async function runGeneric(req = {}) {
  const url = String(req.url || '');
  const host = hostOf(url);
  const service = blockedService(host);
  if (service) {
    throw Object.assign(
      new Error(`${service} links are DRM-protected and not supported`),
      { code: 'DRM_UNSUPPORTED', service },
    );
  }

  const height = Number(req.height) || 720;
  const maxMB = Number(req.maxMB) || Number(process.env.MEDIA_MAX_MB) || 2000;
  const dir = mediaDir();
  fs.mkdirSync(dir, { recursive: true });

  const outBase = path.join(dir, `url_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const startedAt = Date.now();
  const lines = [];
  const note = (text) => { lines.push(`[${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${text}`); };

  note(`start ${host} <=${height}p, cap ${maxMB} MB`);

  const title = await titleOf(url);

  const ytdl = getEngine();
  const result = await ytdl.downloadVideo(url, {
    height,
    outBase,
    maxMB,
    onAttempt: (attempt) => {
      const label = typeof attempt === 'string' ? attempt : attempt?.profile || attempt?.name;
      if (label) note(`attempt ${label}`);
    },
  });

  const file = result?.file;
  if (!file || !fs.existsSync(file)) {
    throw Object.assign(new Error('yt-dlp produced no file'), { code: 'NO_OUTPUT' });
  }

  const size = fs.statSync(file).size;
  const subs = await fetchSubs(url, outBase, req.subs || []);
  note(`done ${path.basename(file)} (${(size / 1024 / 1024).toFixed(1)} MB, ${subs.length} subtitle file(s))`);

  return {
    provider: 'generic',
    title: title || path.basename(file),
    quality: `${height}p`,
    path: file,
    size,
    subs,
    log: lines.join('\n'),
  };
}

/**
 * Execute a provider. Unknown providers are rejected (never guessed), so the
 * queue cannot be pointed at a module that does not exist.
 */
async function run(provider, req = {}) {
  switch (String(provider || '')) {
    case 'generic':
      return runGeneric(req);
    default:
      throw Object.assign(new Error(`no adapter installed for provider "${provider}"`), { code: 'UNKNOWN_PROVIDER' });
  }
}

module.exports = {
  route,
  run,
  runGeneric,
  hostOf,
  mediaDir,
  BLOCKED_HOSTS,
  _setEngineForTests: (impl) => { engine = impl || null; },
};
