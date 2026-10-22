/**
 * API Integration Utilities
 *
 * Remote downloader fallbacks for .song / .ytv. Only used when yt-dlp cannot
 * do the job — every failure reason is collected, and an invalid/revoked
 * Gifted API key logs a clear warning (never printing the secret itself).
 */

const axios = require('axios');
const config = require('../config');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const client = axios.create({
  timeout: 30000,
  headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
});

const isHttpUrl = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);

const KEY_WARN_COOLDOWN_MS = 10 * 60 * 1000;
let _lastKeyWarnAt = 0;

function warnBadGiftedKey(reason) {
  const now = Date.now();
  if (now - _lastKeyWarnAt < KEY_WARN_COOLDOWN_MS) return;
  _lastKeyWarnAt = now;
  console.warn(
    `[gifted-api] ⚠️ Gifted API fallback failed (${reason}) — GIFTED_API_KEY appears missing, expired, or revoked. ` +
    `Update GIFTED_API_KEY in .env (never logged).`,
  );
}

const AUTH_ERROR_RE = /\b(invalid|revoked|expired|unauthorized|forbidden|apikey|api\s*key|limit\s*exceeded|disabled)\b/i;

/** Call one Gifted endpoint and normalise its answer. */
async function gifted(endpoint, params, { timeout = 20000 } = {}) {
  const { baseUrl, apiKey } = config.giftedApi || {};
  const trimmedKey = String(apiKey || '').trim();
  if (!trimmedKey) {
    warnBadGiftedKey('GIFTED_API_KEY not configured');
    const err = new Error('Gifted API key not configured');
    err.code = 'GIFTED_KEY_INVALID';
    throw err;
  }

  let res;
  try {
    res = await client.get(`${baseUrl}/api/download/${endpoint}`, {
      params: { apikey: trimmedKey, ...params },
      timeout,
      maxContentLength: 1024 * 1024,
    });
  } catch (e) {
    const status = e.response?.status;
    const bodyMsg = String(e.response?.data?.message || e.response?.data?.error || '');
    if (status === 401 || status === 403 || AUTH_ERROR_RE.test(bodyMsg)) {
      warnBadGiftedKey(status ? `HTTP ${status}` : 'rejected key');
      e.code = 'GIFTED_KEY_INVALID';
    }
    throw e;
  }

  const data = res.data || {};
  const msg = String(data.message || data.error || '');
  if (data.success === false && AUTH_ERROR_RE.test(msg)) {
    warnBadGiftedKey('API rejected key');
    const err = new Error('Gifted API key rejected');
    err.code = 'GIFTED_KEY_INVALID';
    throw err;
  }

  const result = data.result || {};
  if (!data.success && !Object.keys(result).length) return null;
  const url = result.download_url || result.download || result.url || null;
  if (!isHttpUrl(url)) return null;
  return { download: url, title: result.title || result.name || '', raw: result };
}

/**
 * Walk an endpoint ladder until one answers, remembering why each one failed.
 */
async function tryEndpoints(endpoints, buildParams, label, { timeout = 20000 } = {}) {
  const attempts = [];
  for (const ep of endpoints) {
    try {
      const hit = await gifted(ep, buildParams(ep), { timeout });
      if (hit) return hit;
      attempts.push(`${ep}: empty response`);
    } catch (e) {
      const status = e.response?.status;
      attempts.push(`${ep}: ${status ? `HTTP ${status}` : e.message}`);
      // A bad/revoked key will fail everywhere — stop immediately.
      if (status === 401 || status === 403 || e.code === 'GIFTED_KEY_INVALID') break;
    }
  }
  const err = new Error(`${label}: all endpoints failed`);
  err.code = 'API_FAILED';
  err.attempts = attempts;
  throw err;
}

const APIs = {
  getGiftedAudioByUrl: (youtubeUrl, opts = {}) => tryEndpoints(
    ['ytmp3v2', 'ytaudio', 'yta', 'ytmp3', 'savetubemp3', 'savemp3'],
    () => ({ url: youtubeUrl }),
    'Gifted audio',
    opts,
  ),

  getGiftedVideoByUrl: (youtubeUrl, quality = 720, opts = {}) => tryEndpoints(
    ['ytmp4v2', 'ytmp4', 'ytvideo', 'ytv', 'savetubemp4', 'savemp4'],
    () => ({ url: youtubeUrl, quality }),
    'Gifted video',
    opts,
  ),

  tryEndpoints,
  _resetKeyWarnForTests: () => { _lastKeyWarnAt = 0; },
};

module.exports = APIs;
