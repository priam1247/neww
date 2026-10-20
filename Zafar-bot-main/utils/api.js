/**
 * API Integration Utilities
 *
 * Remote downloader fallbacks for .song / .ytv / .fb. These are only used when
 * yt-dlp cannot do the job — every failure reason is collected so the bot can
 * tell the user *why* the backup source failed too.
 */

const axios = require('axios');
const config = require('../config');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const client = axios.create({
  timeout: 30000,
  headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
});

const isHttpUrl = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);

/** Call one Gifted endpoint and normalise its answer. */
async function gifted(endpoint, params, { timeout = 20000 } = {}) {
  const { baseUrl, apiKey } = config.giftedApi || {};
  const res = await client.get(`${baseUrl}/api/download/${endpoint}`, {
    params: { apikey: apiKey, ...params },
    timeout,
    maxContentLength: 1024 * 1024,
  });
  const data = res.data || {};
  const result = data.result || {};
  if (!data.success && !Object.keys(result).length) return null;
  const url = result.download_url || result.download || result.url || null;
  if (!isHttpUrl(url)) return null;
  return { download: url, title: result.title || result.name || '', raw: result };
}

/**
 * Walk an endpoint ladder until one answers, remembering why each one failed.
 * @param {string[]} endpoints
 * @param {(ep:string)=>object} buildParams
 * @param {string} label used in the thrown error message
 * @param {{timeout?:number}} opts
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
      // A bad/blocked key will fail everywhere — stop early.
      if (status === 401 || status === 403) break;
    }
  }
  const err = new Error(`${label}: all endpoints failed`);
  err.code = 'API_FAILED';
  err.attempts = attempts;
  throw err;
}

const APIs = {
  // ─── Audio (.song fallback) ────────────────────────────────────────────────
  getGiftedAudioByUrl: (youtubeUrl, opts = {}) => tryEndpoints(
    ['ytmp3v2', 'ytaudio', 'yta', 'ytmp3', 'savetubemp3', 'savemp3'],
    () => ({ url: youtubeUrl }),
    'Gifted audio',
    opts,
  ),

  // ─── Video (.ytv fallback) ─────────────────────────────────────────────────
  getGiftedVideoByUrl: (youtubeUrl, quality = 720, opts = {}) => tryEndpoints(
    ['ytmp4v2', 'ytmp4', 'ytvideo', 'ytv', 'savetubemp4', 'savemp4'],
    () => ({ url: youtubeUrl, quality }),
    'Gifted video',
    opts,
  ),

  // ─── Facebook (.fb primary helper) ─────────────────────────────────────────
  getGiftedFacebookByUrl: async (fbUrl) => {
    const hit = await gifted('facebook', { url: fbUrl });
    if (!hit || !(hit.raw.hd_video || hit.raw.sd_video)) {
      throw new Error('Gifted: no Facebook video found');
    }
    return hit.raw;
  },

  tryEndpoints,
};

module.exports = APIs;
