'use strict';

/**
 * ZaFar Bot — yt1d / flashydl Keyless Remote YouTube Resolver
 *
 * Clean, zero-obfuscation port of levanter's remote YouTube engine
 * (`yt1d.io` + `flashydl.space` WebSocket render/mux pipeline):
 *   • Requires NO API key, NO cookies, and NO new npm dependencies.
 *   • Resolves YouTube streams on remote residential/rotating workers and
 *     returns a direct CDN download URL for MP3 audio or muxed MP4 video
 *     (360p / 480p / 720p / 1080p) — ideal fallback when a hosting IP hits
 *     YouTube's datacenter bot-check wall.
 */

const DEFAULT_BASE_URL = 'https://yt1d.io';
const DEFAULT_BALANCER_URL = 'https://fpa-balancer.flashydl.space/get-server';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

const VIDEO_ID_RE = /(?:[?&]v=|\/embed\/|\/shorts\/|\/live\/|youtu\.be\/|\/v\/)([-_0-9A-Za-z]{11})/;
const QUALITY_LADDER = [1080, 720, 480, 360, 240, 144];

function extractVideoId(input) {
  const s = String(input || '').trim();
  if (/^[-_0-9A-Za-z]{11}$/.test(s)) return s;
  const m = s.match(VIDEO_ID_RE);
  return m ? m[1] : null;
}

function safeDownloadName(title) {
  return String(title || 'video').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 100) || 'video';
}

function getWebSocketImpl() {
  try {
    return require('ws');
  } catch {
    if (typeof WebSocket === 'function') return WebSocket;
    throw new Error('WebSocket implementation unavailable');
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('request timed out')), timeoutMs);
  timer.unref?.();
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLanding(baseUrl, timeoutMs = 15000) {
  const res = await fetchWithTimeout(`${baseUrl}/`, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
  }, timeoutMs);
  if (!res.ok) throw new Error(`yt1d landing HTTP ${res.status}`);
  const html = await res.text();
  const pathname = (() => {
    try { return new URL(res.url || `${baseUrl}/`).pathname || '/'; } catch { return '/'; }
  })();
  const nonce = (html.match(/name="yt1_nonce"\s+value="([^"]+)"/i) || [])[1] || '';
  const mergeNonce = (html.match(/"merge_nonce"\s*:\s*"([^"]+)"/i) || [])[1] || '';
  if (!nonce) throw new Error('yt1d: missing landing nonce');
  return { pathname, nonce, mergeNonce };
}

async function fetchFormats(videoId, { baseUrl, timeoutMs = 20000 }) {
  const { pathname, nonce, mergeNonce } = await fetchLanding(baseUrl, Math.min(timeoutMs, 15000));
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const res = await fetchWithTimeout(`${baseUrl}/results/`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: baseUrl,
      Referer: `${baseUrl}${pathname}`,
    },
    body: new URLSearchParams({
      yt1_nonce: nonce,
      _wp_http_referer: pathname,
      yt_video_url: videoUrl,
    }),
  }, timeoutMs);
  if (!res.ok) throw new Error(`yt1d results HTTP ${res.status}`);

  const html = await res.text();
  const tags = [...html.matchAll(/<[^>]*data-token="[^"]*"[^>]*>/gi)];
  const readAttr = (tag, attr) => {
    const m = tag.match(new RegExp(`data-${attr}="([^"]*)"`, 'i'));
    return m ? m[1] : '';
  };

  return tags
    .map((m) => {
      const raw = m[0];
      return {
        token: readAttr(raw, 'token'),
        quality: readAttr(raw, 'quality'),
        hasAudio: readAttr(raw, 'has-audio') === '1',
        size: parseInt(readAttr(raw, 'filesize'), 10) || 0,
        title: readAttr(raw, 'title') || '',
        mergeId: readAttr(raw, 'merge-id') || videoId,
        mergeNonce: readAttr(raw, 'merge-nonce') || mergeNonce,
      };
    })
    .filter((f) => f.token && f.quality);
}

async function resolveStreams(format, { baseUrl, timeoutMs = 15000 }) {
  const ajaxUrl = `${baseUrl}/wp-admin/admin-ajax.php`;
  const form = new FormData();
  form.append('action', 'yt1_resolve_streams');
  form.append('nonce', format.mergeNonce || '');
  form.append('token', format.token);
  form.append('quality', format.quality);

  const res = await fetchWithTimeout(ajaxUrl, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Referer: `${baseUrl}/results/`,
    },
    body: form,
  }, timeoutMs);

  const json = await res.json().catch(() => ({}));
  if (!json?.success || !json?.data) {
    throw new Error('yt1d: stream resolution failed');
  }
  return {
    videoUrl: String(json.data.video_url || '').trim(),
    audioUrl: String(json.data.audio_url || '').trim(),
  };
}

async function startRemoteMerge(jobPayload, mergeNonce, { baseUrl, timeoutMs = 15000 }) {
  const ajaxUrl = `${baseUrl}/wp-admin/admin-ajax.php`;
  const form = new FormData();
  form.append('action', 'process_video_merge');
  form.append('nonce', mergeNonce || '');
  form.append('request_data', JSON.stringify(jobPayload));

  const res = await fetchWithTimeout(ajaxUrl, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Referer: `${baseUrl}/results/`,
    },
    body: form,
  }, timeoutMs);

  const json = await res.json().catch(() => ({}));
  if (!json?.success) {
    throw new Error(`yt1d: remote merge start failed (${JSON.stringify(json?.data || json).slice(0, 120)})`);
  }
  return json;
}

async function waitForRenderWs(jobId, { balancerUrl, timeoutMs = 45000 }) {
  const res = await fetchWithTimeout(balancerUrl, {
    headers: { 'User-Agent': UA },
  }, Math.min(12000, timeoutMs));
  const rawServer = (await res.text()).trim();
  if (!rawServer) throw new Error('yt1d: empty render balancer host');

  const wsEndpoint = /^wss?:\/\//i.test(rawServer)
    ? `${rawServer.replace(/\/+$/, '')}/pub/render/status_ws/${jobId}`
    : `wss://${rawServer.replace(/\/+$/, '')}/pub/render/status_ws/${jobId}`;

  const WS = getWebSocketImpl();
  return new Promise((resolve, reject) => {
    let settled = false;
    let ws = null;

    const cleanup = () => {
      if (ws) {
        try { ws.close(); } catch { /* ignore */ }
        ws = null;
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('yt1d: remote render timed out'));
    }, timeoutMs);
    timer.unref?.();

    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      fn(val);
    };

    try {
      // `ws` accepts options as 2nd arg; global browser-spec WebSocket ignores/rejects non-protocols
      ws = WS.length >= 2 && WS.WebSocket
        ? new WS(wsEndpoint, { headers: { 'User-Agent': UA } })
        : new WS(wsEndpoint);
    } catch (e) {
      return finish(reject, e);
    }

    const onMessage = (raw) => {
      let msg;
      try {
        const text = typeof raw === 'string'
          ? raw
          : (raw && typeof raw.data === 'string' ? raw.data : Buffer.from(raw).toString('utf8'));
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg?.status === 'done' && msg?.output?.url) {
        finish(resolve, String(msg.output.url).trim());
      } else if (msg?.error) {
        finish(reject, new Error(`yt1d render error: ${typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)}`));
      }
    };

    const onError = (err) => {
      finish(reject, err instanceof Error ? err : new Error('yt1d WebSocket error'));
    };

    if (typeof ws.on === 'function') {
      ws.on('message', onMessage);
      ws.on('error', onError);
    } else {
      ws.onmessage = onMessage;
      ws.onerror = onError;
    }
  });
}

function pickVideoFormat(formats, requestedHeight = 720) {
  const videos = formats.filter((f) => !/^mp3$/i.test(f.quality));
  if (!videos.length) return null;

  const target = Number(requestedHeight) || 720;
  const parseH = (q) => {
    const m = String(q || '').match(/(\d{3,4})p/i);
    return m ? Number(m[1]) : 0;
  };

  const exact = videos.find((f) => parseH(f.quality) === target);
  if (exact) return exact;

  // Prefer closest lower quality first, then closest higher
  const withH = videos.map((f) => ({ f, h: parseH(f.quality) })).filter((x) => x.h > 0);
  const lower = withH.filter((x) => x.h <= target).sort((a, b) => b.h - a.h);
  if (lower.length) return lower[0].f;
  const higher = withH.filter((x) => x.h > target).sort((a, b) => a.h - b.h);
  if (higher.length) return higher[0].f;

  for (const h of QUALITY_LADDER) {
    const hit = videos.find((f) => String(f.quality).includes(String(h)));
    if (hit) return hit;
  }
  return videos[0];
}

/**
 * Resolve a YouTube audio or video URL through yt1d + flashydl.
 *
 * @param {string} url
 * @param {{ kind?: 'audio'|'video', quality?: number, timeoutMs?: number, baseUrl?: string, balancerUrl?: string }} [opts]
 * @returns {Promise<{ provider: string, url: string, ext: string, title: string, headers: object }>}
 */
async function resolveYt1d(url, {
  kind = 'audio',
  quality = 720,
  timeoutMs = 50000,
  baseUrl = process.env.YT1D_BASE_URL || DEFAULT_BASE_URL,
  balancerUrl = process.env.YT1D_BALANCER_URL || DEFAULT_BALANCER_URL,
} = {}) {
  const videoId = extractVideoId(url);
  if (!videoId) {
    throw Object.assign(new Error('yt1d: not a valid YouTube video URL'), { code: 'UNSUPPORTED_URL' });
  }

  const startedAt = Date.now();
  const cleanBase = String(baseUrl).replace(/\/+$/, '');
  const formats = await fetchFormats(videoId, {
    baseUrl: cleanBase,
    timeoutMs: Math.min(20000, timeoutMs),
  });
  if (!formats.length) {
    throw new Error('yt1d: no formats returned');
  }

  const chosen = kind === 'audio'
    ? (formats.find((f) => /^mp3$/i.test(f.quality)) || formats[0])
    : pickVideoFormat(formats, quality);

  if (!chosen) throw new Error(`yt1d: no ${kind} format available`);

  const { videoUrl, audioUrl } = await resolveStreams(chosen, {
    baseUrl: cleanBase,
    timeoutMs: Math.min(15000, Math.max(5000, timeoutMs - (Date.now() - startedAt))),
  });

  // Progressive MP4 stream with embedded audio needs no remote mux
  if (kind === 'video' && chosen.hasAudio && /^https?:\/\//i.test(videoUrl)) {
    return {
      provider: 'yt1d',
      url: videoUrl,
      ext: 'mp4',
      title: chosen.title || '',
      headers: { 'User-Agent': UA },
    };
  }

  const chunkCfg = { size: 0xc800000, concurrency: 3 };
  const jobId = `${chosen.mergeId}_${chosen.quality}`;
  const ttl = 3600000;

  let jobPayload;
  if (kind === 'audio') {
    if (!audioUrl) throw new Error('yt1d: no audio stream URL');
    jobPayload = {
      id: jobId,
      ttl,
      inputs: [{ url: audioUrl, ext: 'm4a' }],
      output: {
        ext: 'mp3',
        downloadName: `${safeDownloadName(chosen.title)}_MP3.mp3`,
        chunkUpload: chunkCfg,
      },
      operation: { type: 'no_process' },
    };
  } else {
    if (!videoUrl || !audioUrl) throw new Error('yt1d: streams unavailable for this quality');
    jobPayload = {
      id: jobId,
      ttl,
      inputs: [
        {
          url: videoUrl,
          ext: 'mp4',
          chunkDownload: { type: 'header', size: 0x3200000, concurrency: 3 },
        },
        { url: audioUrl, ext: 'm4a' },
      ],
      output: {
        ext: 'mp4',
        downloadName: `${safeDownloadName(chosen.title)}_${chosen.quality}.mp4`,
        chunkUpload: chunkCfg,
      },
      operation: { type: 'replace_audio_in_video' },
    };
  }

  try {
    await startRemoteMerge(jobPayload, chosen.mergeNonce, {
      baseUrl: cleanBase,
      timeoutMs: Math.min(15000, Math.max(5000, timeoutMs - (Date.now() - startedAt))),
    });
    const remainingMs = Math.max(8000, timeoutMs - (Date.now() - startedAt));
    const renderedUrl = await waitForRenderWs(jobId, { balancerUrl, timeoutMs: remainingMs });
    return {
      provider: 'yt1d',
      url: renderedUrl,
      ext: kind === 'audio' ? 'mp3' : 'mp4',
      title: chosen.title || '',
      headers: { 'User-Agent': UA },
    };
  } catch (renderErr) {
    // If remote WebSocket packaging fails on audio, fall back to raw audioUrl if non-IP-bound
    if (kind === 'audio' && /^https?:\/\//i.test(audioUrl)) {
      return {
        provider: 'yt1d',
        url: audioUrl,
        ext: 'm4a',
        title: chosen.title || '',
        headers: { 'User-Agent': UA },
      };
    }
    throw renderErr;
  }
}

module.exports = {
  extractVideoId,
  resolveYt1d,
  pickVideoFormat,
  DEFAULT_BASE_URL,
  DEFAULT_BALANCER_URL,
};
