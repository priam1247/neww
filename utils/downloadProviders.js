/**
 * ZaFar Bot — remote downloader providers
 *
 * Everything here is a *fallback*: yt-dlp is always tried first (best quality,
 * nothing depends on a third party). These providers exist for the one case a
 * local engine cannot fix — a hosting IP that YouTube refuses to serve at all
 * and where the owner has no cookies or proxy yet.
 *
 * Contract: a provider only *resolves* a direct media URL (cheap metadata
 * call). Downloading is done by the command that called us, once, with the
 * normal size cap — so listing several providers costs seconds, not megabytes.
 *
 *   resolveMedia(url, { kind: 'audio'|'video', quality, timeoutMs })
 *     → { provider, url, ext, title, headers }
 */

const axios = require('axios');
const APIs = require('./api');
const config = require('../config');
const settings = require('./mediaSettings');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT = 20000;

const isHttp = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);

// ─── COBALT ───────────────────────────────────────────────────────────────────
// Open-source downloader API (github.com/imputnet/cobalt). Instances are
// community-run and come and go — override them with COBALT_INSTANCES
// (comma-separated) or `settings.cobaltInstances` without touching this file.
const DEFAULT_COBALT_INSTANCES = [
  'https://cobalt-api.kwiatekmiki.com',
  'https://co.eepy.today',
  'https://api.cobalt.tools',
];

function cobaltInstances() {
  const fromEnv = String(process.env.COBALT_INSTANCES || '').split(',').map(s => s.trim()).filter(Boolean);
  const fromConfig = Array.isArray(config.cobalt?.instances) ? config.cobalt.instances.filter(Boolean) : [];
  const fromSettings = Array.isArray(settings.get('cobaltInstances', [])) ? settings.get('cobaltInstances', []) : [];
  const all = [...fromEnv, ...fromConfig, ...fromSettings];
  if (all.length) return all;
  return config.cobalt?.useDefaultInstances === false ? [] : DEFAULT_COBALT_INSTANCES;
}

function pickCobaltUrl(json) {
  if (!json || typeof json !== 'object') return null;
  const status = String(json.status || '').toLowerCase();

  if (status === 'error') return null;
  if (isHttp(json.url)) return json.url;                    // tunnel / redirect / stream
  if (Array.isArray(json.picker) && json.picker.length) {    // multiple media (playlist/album)
    const video = json.picker.find(p => p && p.type === 'video') || json.picker[0];
    if (video && isHttp(video.url)) return video.url;
  }
  if (json.audio && isHttp(json.audio)) return json.audio;
  return null;
}

async function cobaltResolve(baseUrl, { url, kind, quality, timeoutMs }) {
  const endpoint = String(baseUrl).replace(/\/+$/, '') + '/';
  const body = {
    url,
    downloadMode: 'auto',
    videoQuality: String(quality || 720),
    audioFormat: 'mp3',
    filenameStyle: 'basic',
  };
  const res = await axios.post(endpoint, body, {
    timeout: timeoutMs,
    maxRedirects: 3,
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    validateStatus: null,
  });

  if (res.status >= 400) {
    const code = res.data?.error?.code || `HTTP ${res.status}`;
    throw new Error(`cobalt ${code}`);
  }
  const direct = pickCobaltUrl(res.data);
  if (!direct) throw new Error(`cobalt: ${res.data?.error?.code || 'no media in response'}`);

  const ext = String(res.data.filename || '').match(/\.([a-z0-9]{2,4})(?:\?|$)/i);
  return {
    provider: `cobalt (${new URL(endpoint).host})`,
    url: direct,
    ext: ext ? ext[1].toLowerCase() : (kind === 'audio' ? 'mp3' : 'mp4'),
    title: res.data.filename || '',
    headers: {},
  };
}

// ─── PROVIDER REGISTRY ────────────────────────────────────────────────────────

const PROVIDERS = [
  {
    name: 'gifted',
    kinds: ['audio', 'video'],
    enabled: () => Boolean(String(config.giftedApi?.apiKey || '').trim()),
    resolve: async ({ url, kind, quality, timeoutMs }) => {
      const hit = kind === 'audio'
        ? await APIs.getGiftedAudioByUrl(url, { timeout: timeoutMs })
        : await APIs.getGiftedVideoByUrl(url, quality, { timeout: timeoutMs });
      if (!hit || !isHttp(hit.download)) throw new Error('gifted: no download URL');
      return {
        provider: 'gifted',
        url: hit.download,
        ext: kind === 'audio' ? 'mp3' : 'mp4',
        title: hit.title || '',
        headers: {},
      };
    },
  },
  {
    name: 'cobalt',
    kinds: ['audio', 'video'],
    enabled: () => cobaltInstances().length > 0,
    resolve: async (opts) => {
      const instances = cobaltInstances();
      const errors = [];
      // Instances are redundant mirrors: race them, first answer wins.
      const attempt = (base) => cobaltResolve(base, opts).catch((e) => { errors.push(e.message); throw e; });
      try {
        return await Promise.any(instances.map(attempt));
      } catch {
        throw new Error(`cobalt: all instances failed (${errors.slice(0, 3).join('; ') || 'no response'})`);
      }
    },
  },
].filter(Boolean);

const listProviders = () => PROVIDERS.map(p => ({ name: p.name, kinds: p.kinds, enabled: Boolean(p.enabled()) }));

/**
 * Ask every enabled provider at once and take the first usable answer.
 * @returns {Promise<{provider:string,url:string,ext:string,title:string,headers:object}>}
 */
async function resolveMedia(url, { kind = 'audio', quality = 720, timeoutMs = DEFAULT_TIMEOUT, onAttempt } = {}) {
  if (settings.get('remoteFallback', true) === false) {
    const err = new Error('remote fallbacks are disabled');
    err.code = 'FALLBACK_DISABLED';
    throw err;
  }

  const usable = PROVIDERS.filter(p => p.enabled() && p.kinds.includes(kind));
  if (!usable.length) {
    const err = new Error('no remote provider is configured');
    err.code = 'NO_PROVIDERS';
    throw err;
  }

  const errors = [];
  const run = (p) => p.resolve({ url, kind, quality, timeoutMs })
    .then((r) => {
      if (onAttempt) onAttempt(p.name, null, { code: 'OK' });
      return { ...r, provider: r.provider || p.name };
    })
    .catch((e) => {
      errors.push(`${p.name}: ${e.message}`);
      if (onAttempt) onAttempt(p.name, e, { code: e.code || 'FAILED' });
      throw e;
    });

  try {
    return await Promise.any(usable.map(run));
  } catch {
    const err = new Error(`all remote providers failed — ${errors.join(' | ')}`);
    err.code = 'NO_PROVIDERS';
    err.attempts = errors;
    throw err;
  }
}

module.exports = { resolveMedia, listProviders, cobaltInstances, DEFAULT_TIMEOUT };
