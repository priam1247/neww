// src/providers/local/remote.js — merged from Zafar-bot-main: remote downloader
// fallbacks (cobalt instances + optional Gifted API). Only consulted when the
// local yt-dlp engine cannot do the job (hosting IP bot-walled with no cookies
// or proxy). Contract: a provider only RESOLVES a direct media URL — download
// happens once, with the normal size cap, by the calling command.
import config from '../../config.js';
import { log } from '../../core/log.js';
import { store } from '../../core/store.js';
import { req } from '../../core/http.js';

const rlog = log.child('remote');
const isHttp = (u) => typeof u === 'string' && /^https:\/\//i.test(u);

// ─── COBALT ──────────────────────────────────────────────────────────────────
const DEFAULT_COBALT_INSTANCES = [
  'https://cobalt-api.kwiatekmiki.com',
  'https://co.eepy.today',
];

export function cobaltInstances() {
  const all = [
    ...config.cobaltInstances,
    ...(Array.isArray(store.get('settings', 'cobaltInstances', [])) ? store.get('settings', 'cobaltInstances', []) : []),
  ];
  if (all.length) return all;
  return config.cobaltUseDefaults ? DEFAULT_COBALT_INSTANCES : [];
}

/** Extract the first usable media URL from a cobalt response. */
export function pickCobaltUrl(json) {
  if (!json || typeof json !== 'object') return null;
  const status = String(json.status || '').toLowerCase();
  if (status === 'error') return null;
  if (isHttp(json.url)) return json.url;                   // tunnel / redirect / stream
  if (Array.isArray(json.picker) && json.picker.length) {  // playlist/album
    const video = json.picker.find(p => p && p.type === 'video') || json.picker[0];
    if (video && isHttp(video.url)) return video.url;
  }
  if (json.audio && isHttp(json.audio)) return json.audio;
  return null;
}

export async function cobaltResolve(baseUrl, { url, kind, quality, timeoutMs }) {
  const endpoint = String(baseUrl).replace(/\/+$/, '') + '/';
  const body = {
    url,
    downloadMode: 'auto',
    videoQuality: String(quality || 720),
    audioFormat: 'mp3',
    filenameStyle: 'basic',
  };
  const data = await req(endpoint, {
    method: 'POST', retries: 0, timeout: timeoutMs,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(e => { throw new Error(`cobalt: ${e.message}`); });

  const direct = pickCobaltUrl(data);
  if (!direct) throw new Error(`cobalt: ${data?.error?.code || 'no media in response'}`);
  const ext = String(data.filename || '').match(/\.([a-z0-9]{2,4})(?:\?|$)/i);
  return {
    provider: `cobalt (${new URL(endpoint).host})`,
    url: direct,
    ext: ext ? ext[1].toLowerCase() : (kind === 'audio' ? 'mp3' : 'mp4'),
    title: data.filename || '',
    headers: {},
  };
}

// ─── GIFTED (optional API key) ───────────────────────────────────────────────
async function gifted(endpoint, params, { timeout = 20_000 } = {}) {
  if (!config.giftedApiKey) return null;
  const qs = new URLSearchParams({ apikey: config.giftedApiKey, ...params });
  const data = await req(`${config.giftedApiUrl}/api/download/${endpoint}?${qs}`, {
    retries: 0, timeout,
  }).catch(() => null);
  const result = data?.result || {};
  if (!data?.success && !Object.keys(result).length) return null;
  const url = result.download_url || result.download || result.url || null;
  if (!isHttp(url) && !/^http:\/\//.test(String(url))) return null;
  return { download: url, title: result.title || result.name || '', raw: result };
}

/** Walk a Gifted endpoint ladder until one answers. */
async function giftedLadder(endpoints, buildParams, label, { timeout = 20_000 } = {}) {
  const attempts = [];
  for (const ep of endpoints) {
    try {
      const hit = await gifted(ep, buildParams(ep), { timeout });
      if (hit) return hit;
      attempts.push(`${ep}: empty response`);
    } catch (e) {
      attempts.push(`${ep}: ${e.message}`);
      if (/401|403/.test(e.message)) break;   // bad key fails everywhere
    }
  }
  throw Object.assign(new Error(`${label}: all endpoints failed`), { code: 'API_FAILED', attempts });
}

// ─── PROVIDER REGISTRY ───────────────────────────────────────────────────────
const PROVIDERS = [
  {
    name: 'gifted',
    kinds: ['audio', 'video'],
    enabled: () => Boolean(config.giftedApiKey),
    resolve: async ({ url, kind, quality, timeoutMs }) => {
      const hit = kind === 'audio'
        ? await giftedLadder(['ytmp3v2', 'ytaudio', 'yta', 'ytmp3', 'savetubemp3', 'savemp3'], () => ({ url }), 'Gifted audio', { timeout: timeoutMs })
        : await giftedLadder(['ytmp4v2', 'ytmp4', 'ytvideo', 'ytv', 'savetubemp4', 'savemp4'], () => ({ url, quality }), 'Gifted video', { timeout: timeoutMs });
      if (!hit || !isHttp(hit.download)) throw new Error('gifted: no download URL');
      return { provider: 'gifted', url: hit.download, ext: kind === 'audio' ? 'mp3' : 'mp4', title: hit.title || '', headers: {} };
    },
  },
  {
    name: 'cobalt',
    kinds: ['audio', 'video'],
    enabled: () => cobaltInstances().length > 0,
    resolve: async (opts) => {
      const instances = cobaltInstances();
      const errors = [];
      const attempt = (base) => cobaltResolve(base, opts).catch((e) => { errors.push(e.message); throw e; });
      try { return await Promise.any(instances.map(attempt)); }
      catch { throw new Error(`cobalt: all instances failed (${errors.slice(0, 3).join('; ') || 'no response'})`); }
    },
  },
];

export const listProviders = () => PROVIDERS.map(p => ({ name: p.name, kinds: p.kinds, enabled: Boolean(p.enabled()) }));

/**
 * Ask every enabled provider at once and take the first usable answer.
 * @returns {Promise<{provider:string,url:string,ext:string,title:string,headers:object}>}
 */
export async function resolveMedia(url, { kind = 'audio', quality = 720, timeoutMs = 20_000, onAttempt } = {}) {
  if (store.get('settings', 'remoteFallback', true) === false) {
    throw Object.assign(new Error('remote fallbacks are disabled'), { code: 'FALLBACK_DISABLED' });
  }
  const usable = PROVIDERS.filter(p => p.enabled() && p.kinds.includes(kind));
  if (!usable.length) throw Object.assign(new Error('no remote provider is configured'), { code: 'NO_PROVIDERS' });

  const errors = [];
  const run = (p) => p.resolve({ url, kind, quality, timeoutMs })
    .then((r) => { if (onAttempt) onAttempt(p.name, null, { code: 'OK' }); return { ...r, provider: r.provider || p.name }; })
    .catch((e) => {
      errors.push(`${p.name}: ${e.message}`);
      if (onAttempt) onAttempt(p.name, e, { code: e.code || 'FAILED' });
      throw e;
    });
  try {
    return await Promise.any(usable.map(run));
  } catch {
    throw Object.assign(new Error(`all remote providers failed — ${errors.join(' | ')}`), { code: 'NO_PROVIDERS', attempts: errors });
  }
}

export const remoteWorthTrying = (code) => [
  'BOT_CHECK', 'NO_YTDLP', 'NO_FORMATS', 'FFMPEG_MISSING', 'UNKNOWN',
  'NETWORK', 'RATE_LIMIT', 'PO_TOKEN', 'AGE_RESTRICTED', 'GEO_BLOCK', 'BAD_ARGS',
].includes(code);
