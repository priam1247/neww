// engine/media/download.js — streamed downloads: never buffer a movie in RAM.
//
// Fixed in the ZaFar Bot integration:
//   • `AbortSignal.timeout(60000)` used to abort the WHOLE transfer after 60
//     seconds — a 2 GB movie over a slow link could never finish. The socket is
//     now guarded by a STALL watchdog (no bytes for `downloadStallMs`), which is
//     what actually needs catching;
//   • downloads are registered with the cache so the disk sweeper can never
//     unlink a file mid-transfer;
//   • optional request headers (Referer/Cookie) for DDL hosts, and automatic
//     retry/resume on a dropped connection;
//   • HLS goes through ffmpeg with the same headers and a stall guard.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import config from '../config.js';
import cache from '../core/cache.js';
import { formatBytes } from '../utils/format.js';
import { freeBytes, ensureDir, which, sanitize as sanitizeName } from '../utils/disk.js';
import { emit, EVENTS } from '../core/events.js';
import { metrics } from '../core/metrics.js';
import { ffmpegPath, downloadFallback } from '../host.js';
import { downloadHlsNative } from './hls.js';

export const sanitize = (name, q, s, e) => {
  const base = sanitizeName(name);
  const tag = s != null ? `S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}` : '';
  return [base, tag, `${q}p`, 'x264'].filter(Boolean).join('.') + '.mp4';
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// HLS -> file, straight to disk.
// ffmpeg is used when the host has it (it is faster and remuxes cleanly), but
// it is NOT required any more: the native downloader below concatenates the
// playlist's segments itself, so stream sources work on a bare Node host.
export async function hlsToFile(url, dest, onProgress, { headers = {}, maxHeight } = {}) {
  // Prefer the binary the bot itself verified (system → user install →
  // packaged fallback); fall back to a PATH lookup so the engine still works alone.
  const ffmpeg = (await ffmpegPath()) || await which('ffmpeg');
  if (!ffmpeg) {
    // hard cap so a runaway playlist can never eat the host's disk
    const maxBytes = Math.round(config.maxDownloadMB * 1.2 * 1048576);
    let got;
    try {
      got = await downloadHlsNative(url, dest, { headers, onProgress, maxHeight, maxBytes });
    } catch (e) {
      // never leave a half-written stream behind for the next retry to resume
      for (const f of [dest, dest.replace(/\.(mp4|mkv|ts|m4v)$/i, '') + '.ts']) {
        try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
      }
      throw e;
    }
    metrics.bump('download.bytes', {}, got.bytes);
    emit(EVENTS.DOWNLOAD_DONE, { dest: got.file, bytes: got.bytes });
    return { bytes: got.bytes, file: got.file, native: true };
  }
  ensureDir(path.dirname(dest));
  cache.markActive(dest);

  const headerLines = Object.entries({ 'User-Agent': config.userAgent, ...headers })
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n');

  try {
    await new Promise((resolve, reject) => {
      const p = execFile(ffmpeg, [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-headers', `${headerLines}\r\n`,
        '-user_agent', config.userAgent,
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10',
        '-i', url,
        '-c', 'copy', '-bsf:a', 'aac_adtstoasc',
        '-movflags', '+faststart',
        dest
      ], { maxBuffer: 1 << 24 });

      let lastSize = 0, lastChange = Date.now();
      const tick = setInterval(() => {
        try {
          const s = fs.statSync(dest).size;
          if (s !== lastSize) { lastSize = s; lastChange = Date.now(); onProgress?.(s, 0); }
          else if (Date.now() - lastChange > config.downloadStallMs) {
            try { p.kill('SIGKILL'); } catch {}
            reject(new Error('HLS stream stalled (no data) — link expired?'));
          }
        } catch { /* file not created yet */ }
      }, 4000);

      p.on('error', (e) => { clearInterval(tick); reject(e); });
      p.on('close', (c) => { clearInterval(tick); c === 0 ? resolve() : reject(new Error(`ffmpeg exited ${c}`)); });
    });
  } finally {
    cache.unmarkActive(dest);
  }

  const bytes = fs.statSync(dest).size;
  metrics.bump('download.bytes', {}, bytes);
  return { bytes, file: dest };
}

// One HTTP attempt. Resumes from whatever is already on disk.
async function httpAttempt(url, dest, { onProgress, onAbort, headers, signal }) {
  let start = 0;
  try { if (fs.existsSync(dest)) start = fs.statSync(dest).size; } catch { /* ignore */ }

  const res = await fetch(url, {
    headers: {
      'user-agent': config.userAgent,
      ...headers,
      ...(start ? { range: `bytes=${start}-` } : {})
    },
    signal,
    redirect: 'follow'
  });

  // 416: we already have the whole file
  if (res.status === 416 && start) return { bytes: start, complete: true };
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);

  // server ignored the range header? restart cleanly
  if (start && res.status !== 206) start = 0;

  const total = Number(res.headers.get('content-length') || 0) + start;

  const free = await freeBytes(path.dirname(dest));
  if (free !== null && total && free < total + 300 * 1048576) {
    throw new Error(`low disk: need ${formatBytes(total)}, have ${formatBytes(free)}`);
  }

  const out = fs.createWriteStream(dest, { flags: start ? 'a' : 'w' });
  let got = start, last = 0;

  try {
    for await (const chunk of res.body) {
      if (onAbort?.()) { out.destroy(); throw new Error('download aborted'); }
      got += chunk.length;
      if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
      const now = Date.now();
      if (now - last > 4000) {
        last = now;
        onProgress?.(got, total);
        emit(EVENTS.DOWNLOAD_PROGRESS, { dest, got, total });
      }
    }
    out.end();
    await new Promise(r => out.once('close', r));
  } finally {
    if (!out.closed && !out.destroyed) { try { out.destroy(); } catch {} }
  }

  if (total && got < total) throw new Error(`incomplete download (${got}/${total} bytes)`);
  return { bytes: got, complete: true };
}

// streamed HTTPS download with stall guard, resume and retries
export async function httpToFile(url, dest, { onProgress, onAbort, headers = {} } = {}) {
  ensureDir(path.dirname(dest));
  cache.markActive(dest);                 // a partial file must survive the sweeper
  emit(EVENTS.DOWNLOAD_START, { dest });

  try {
    let lastErr;
    for (let attempt = 0; attempt <= config.downloadRetries; attempt++) {
      // a FRESH controller per attempt: a stalled attempt must not poison the retry
      const controller = new AbortController();
      let lastData = Date.now();
      const guard = setInterval(() => {
        if (Date.now() - lastData > config.downloadStallMs) controller.abort();
      }, 5000);
      guard.unref?.();

      try {
        const out = await httpAttempt(url, dest, {
          onProgress: (got, total) => { lastData = Date.now(); onProgress?.(got, total); },
          onAbort, headers, signal: controller.signal,
        });
        metrics.bump('download.bytes', {}, out.bytes);
        emit(EVENTS.DOWNLOAD_DONE, { dest, bytes: out.bytes });
        return out;
      } catch (e) {
        lastErr = e;
        const stalled = e.name === 'AbortError' || /aborted|stalled/i.test(e.message || '');
        if (attempt >= config.downloadRetries) {
          // Last resort: the bot's own downloader (different TLS/agent stack).
          // Some DDL mirrors reject Node's fetch fingerprint but serve axios.
          try {
            fs.rmSync(dest, { force: true });     // restart clean: host has no resume
          } catch { /* ignore */ }
          const viaHost = await downloadFallback(url, dest, { headers, onProgress });
          if (viaHost && viaHost.bytes > 0) {
            metrics.bump('download.bytes', {}, viaHost.bytes);
            emit(EVENTS.DOWNLOAD_DONE, { dest, bytes: viaHost.bytes });
            return { bytes: viaHost.bytes, viaHost: true };
          }
          if (stalled) throw new Error('download stalled — the source stopped sending data');
          throw e;
        }
        await sleep(1500 * (attempt + 1));
      } finally {
        clearInterval(guard);
      }
    }
    throw lastErr;
  } finally {
    cache.unmarkActive(dest);
  }
}
