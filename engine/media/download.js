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
import { ffmpegPath, downloadFallback, hlsDownload } from '../host.js';
import { downloadHlsNative, parseVariants, chooseVariant } from './hls.js';

export const sanitize = (name, q, s, e) => {
  const base = sanitizeName(name);
  const tag = s != null ? `S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}` : '';
  return [base, tag, `${q}p`, 'x264'].filter(Boolean).join('.') + '.mp4';
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * When falling back to raw `ffmpeg -i <url>`, pick the variant matching
 * `maxHeight` if `url` is a master playlist without separate audio renditions.
 */
async function resolveFfmpegVariantUrl(url, headers, maxHeight) {
  if (!maxHeight) return url;
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': config.userAgent, accept: '*/*', ...headers },
      signal: AbortSignal.timeout(12000),
      redirect: 'follow',
    });
    if (!res.ok) return url;
    const text = await res.text();
    if (!/#EXT-X-STREAM-INF/i.test(text)) return url;
    // Keep master URL if audio is carried in a separate #EXT-X-MEDIA rendition
    if (/#EXT-X-MEDIA:[^\r\n]*TYPE=AUDIO[^\r\n]*URI="/i.test(text)) return url;
    const chosen = chooseVariant(parseVariants(text, url), maxHeight);
    return chosen?.url || url;
  } catch {
    return url;
  }
}

// HLS -> file, straight to disk.
// 3-tier cascade:
//   1. `N_m3u8DL-RE` (16 parallel segment threads + `ffmpeg` MP4 mux, honours `maxHeight`)
//   2. `ffmpeg` HLS remux (honours `maxHeight` on muxed master playlists)
//   3. `downloadHlsNative` (pure Node.js segment concatenation + AES-128 decryption)
export async function hlsToFile(url, dest, onProgress, { headers = {}, maxHeight, onAbort } = {}) {
  ensureDir(path.dirname(dest));
  cache.markActive(dest);
  emit(EVENTS.DOWNLOAD_START, { dest });

  // hard cap so a runaway playlist can never eat the host's disk
  const maxBytes = Math.round(config.maxDownloadMB * 1.2 * 1048576);
  const hlsMode = String(process.env.MOVIE_HLS_ENGINE || 'auto').toLowerCase();

  try {
    // ── Tier 1: N_m3u8DL-RE parallel segment downloader + ffmpeg MP4 muxer ──
    if (hlsMode !== 'ffmpeg' && hlsMode !== 'native' && hlsMode !== 'off') {
      const viaRe = await hlsDownload(url, dest, {
        headers,
        maxHeight,
        maxBytes,
        stallMs: config.downloadStallMs,
        onProgress,
        onAbort,
      });
      if (viaRe && viaRe.bytes > 0) {
        metrics.bump('download.bytes', {}, viaRe.bytes);
        emit(EVENTS.DOWNLOAD_DONE, { dest: viaRe.file, bytes: viaRe.bytes });
        return { bytes: viaRe.bytes, file: viaRe.file, engine: 'nm3u8dl-re' };
      }
    }

    // ── Tier 2: ffmpeg HLS remux ────────────────────────────────────────────
    const ffmpeg = hlsMode === 'native' ? null : ((await ffmpegPath()) || await which('ffmpeg'));
    if (ffmpeg) {
      const targetUrl = await resolveFfmpegVariantUrl(url, headers, maxHeight);
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
            '-i', targetUrl,
            '-c', 'copy', '-bsf:a', 'aac_adtstoasc',
            '-movflags', '+faststart',
            dest
          ], { maxBuffer: 1 << 24 });

          let lastSize = 0, lastChange = Date.now();
          const tick = setInterval(() => {
            if (onAbort?.()) {
              clearInterval(tick);
              try { p.kill('SIGKILL'); } catch {}
              return reject(Object.assign(new Error('download aborted'), { code: 'ABORTED' }));
            }
            try {
              const s = fs.statSync(dest).size;
              if (maxBytes > 0 && s > maxBytes) {
                clearInterval(tick);
                try { p.kill('SIGKILL'); } catch {}
                return reject(Object.assign(new Error('HLS stream larger than the cap'), { code: 'TOO_BIG' }));
              }
              if (s !== lastSize) { lastSize = s; lastChange = Date.now(); onProgress?.(s, 0); }
              else if (Date.now() - lastChange > config.downloadStallMs) {
                clearInterval(tick);
                try { p.kill('SIGKILL'); } catch {}
                return reject(new Error('HLS stream stalled (no data) — link expired?'));
              }
            } catch { /* file not created yet */ }
          }, 4000);

          p.on('error', (e) => { clearInterval(tick); reject(e); });
          p.on('close', (c) => { clearInterval(tick); c === 0 ? resolve() : reject(new Error(`ffmpeg exited ${c}`)); });
        });

        const bytes = fs.statSync(dest).size;
        if (bytes >= 10 * 1024) {
          metrics.bump('download.bytes', {}, bytes);
          emit(EVENTS.DOWNLOAD_DONE, { dest, bytes });
          return { bytes, file: dest, engine: 'ffmpeg' };
        }
      } catch (ffErr) {
        try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
        if (ffErr?.code === 'TOO_BIG' || ffErr?.code === 'ABORTED') throw ffErr;
        // Any other ffmpeg HLS failure falls through to pure-JS segment fetch
      }
    }

    // ── Tier 3: pure Node.js segment concatenation + AES-128 decryption ─────
    let got;
    try {
      const wrappedProgress = typeof onProgress === 'function'
        ? (done, total, bytes) => {
            const estTotal = total > 0 && done > 0 ? Math.round((bytes / done) * total) : 0;
            onProgress(bytes, estTotal);
          }
        : undefined;
      got = await downloadHlsNative(url, dest, { headers, onProgress: wrappedProgress, maxHeight, maxBytes });
    } catch (e) {
      // never leave a half-written stream behind for the next retry to resume
      for (const f of [dest, dest.replace(/\.(mp4|mkv|ts|m4v)$/i, '') + '.ts']) {
        try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
      }
      throw e;
    }
    metrics.bump('download.bytes', {}, got.bytes);
    emit(EVENTS.DOWNLOAD_DONE, { dest: got.file, bytes: got.bytes });
    return { bytes: got.bytes, file: got.file, native: true, engine: 'native' };
  } finally {
    cache.unmarkActive(dest);
  }
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
          // Some hosts reject Node's fetch fingerprint but serve axios.
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
