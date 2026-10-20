// src/media/transfer.js — merged from Zafar-bot-main: media transfer helpers.
//   • stream a URL to disk with a hard size cap (RAM stays flat)
//   • sniff the real container from magic bytes (never trust URL/extension)
//   • convert audio → mp3 / remux or transcode video → WhatsApp-playable mp4
//   • filesystem-safe names
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ffmpeg from '../utils/ffmpeg.js';
import { ensureDir } from '../utils/disk.js';
import config from '../config.js';

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const fmtMB = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export const jobDir = () => { ensureDir(config.jobDir); return config.jobDir; };

export const tempPath = (prefix, ext = '') => path.join(
  jobDir(),
  `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}${ext ? '.' + ext : ''}`
);

/** Delete a file we created inside the job dir (never escapes jobDir). */
export function removeTemp(file) {
  try {
    if (!file) return false;
    const rel = path.relative(path.resolve(jobDir()), path.resolve(file));
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      fs.unlinkSync(file);
      return true;
    }
  } catch { /* already gone */ }
  return false;
}

/** Sweep stale job files (ENOSPC protection). */
export function sweepJobs({ maxAgeMs = 2 * 3600_000 } = {}) {
  let freed = 0;
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(jobDir())) {
      const p = path.join(jobDir(), f);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && now - st.mtimeMs > maxAgeMs) { freed += st.size; fs.unlinkSync(p); }
      } catch { /* busy */ }
    }
  } catch { /* no dir yet */ }
  return freed;
}

/** Read up to n bytes from the start of a file (cheap header sniffing). */
export function headOf(file, n = 4096) {
  try {
    const len = Math.min(n, fs.statSync(file).size);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, 0);
    fs.closeSync(fd);
    return buf;
  } catch { return Buffer.alloc(0); }
}

/** Identify the real container from magic bytes (never trust the URL). */
export function sniff(b) {
  b = b || Buffer.alloc(0);
  if (b.length > 12 && b.toString('ascii', 4, 8) === 'ftyp') {
    const brand = b.toString('ascii', 8, 12);
    if (['avif', 'heic', 'heix', 'mif1'].includes(brand)) return { kind: 'image', ext: brand === 'avif' ? 'avif' : 'heic', mime: 'image/heic' };
    const hasVideoCodec = /avc1|avc3|hev1|hvc1|av01|vp09|vp08/.test(b.toString('latin1'));
    if (!hasVideoCodec) return { kind: 'audio', ext: 'm4a', mime: 'audio/mp4' };
    return { kind: 'video', ext: 'mp4', mime: 'video/mp4' };
  }
  if (b.toString('ascii', 0, 3) === 'ID3' || (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0)) return { kind: 'audio', ext: 'mp3', mime: 'audio/mpeg' };
  if (b.toString('ascii', 0, 4) === 'OggS') return { kind: 'audio', ext: 'ogg', mime: 'audio/ogg' };
  if (b.toString('ascii', 0, 4) === 'RIFF') {
    const sub = b.toString('ascii', 8, 12);
    if (sub === 'WEBP') return { kind: 'image', ext: 'webp', mime: 'image/webp' };
    if (sub === 'WAVE') return { kind: 'audio', ext: 'wav', mime: 'audio/wav' };
    return { kind: 'video', ext: 'avi', mime: 'video/avi' };
  }
  if (b.toString('ascii', 0, 4) === 'fLaC') return { kind: 'audio', ext: 'flac', mime: 'audio/flac' };
  if (b.toString('hex', 0, 4) === '1a45dfa3') {
    const ascii = b.toString('latin1');
    const audioOnly = /A_OPUS|A_VORBIS|A_AAC/.test(ascii) && !/V_VP8|V_VP9|V_AV1|V_MPEG/.test(ascii);
    return audioOnly
      ? { kind: 'audio', ext: 'webm', mime: 'audio/webm' }
      : { kind: 'video', ext: 'webm', mime: 'video/webm' };
  }
  if (b[0] === 0xFF && b[1] === 0xD8) return { kind: 'image', ext: 'jpg', mime: 'image/jpeg' };
  if (b.toString('ascii', 1, 4) === 'PNG') return { kind: 'image', ext: 'png', mime: 'image/png' };
  if (b.toString('ascii', 0, 3) === 'GIF') return { kind: 'image', ext: 'gif', mime: 'image/gif' };
  return { kind: 'unknown', ext: 'bin', mime: 'application/octet-stream' };
}

export const sniffFile = (file) => sniff(headOf(file));

/**
 * Stream a URL to `dest` without buffering it in RAM.
 * @returns {Promise<{file:string,bytes:number,contentType:string,sniff:object}>}
 */
export async function downloadToFile(url, dest, {
  maxBytes = 300 * 1024 * 1024,
  timeout = 180_000,
  headers = {},
  onProgress,
} = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: '*/*', 'accept-encoding': 'identity', ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw Object.assign(new Error(`media source answered HTTP ${res.status}`), { code: 'HTTP_ERROR' });

  const contentType = String(res.headers.get('content-type') || '');
  if (contentType.includes('text/') || contentType.includes('json')) {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    throw Object.assign(new Error('media source returned a web page instead of a file'), { code: 'BAD_SOURCE' });
  }

  const expected = Number(res.headers.get('content-length')) || 0;
  if (expected && expected > maxBytes) {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    throw Object.assign(new Error('file is larger than the size limit'), { code: 'TOO_BIG' });
  }

  let bytes = 0;
  const source = Readable.fromWeb(res.body).on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > maxBytes) source.destroy(Object.assign(new Error('file is larger than the size limit'), { code: 'TOO_BIG' }));
    if (onProgress && expected) {
      try { onProgress({ percent: Math.min(99, Math.round((bytes / expected) * 100)), downloaded: bytes, total: expected }); } catch { /* ignore */ }
    }
  });

  try { await pipeline(source, fs.createWriteStream(dest)); }
  catch (e) { removeTemp(dest); throw e; }

  if (bytes < 10 * 1024) {
    removeTemp(dest);
    throw Object.assign(new Error('the downloaded file is too small to be media'), { code: 'BAD_SOURCE' });
  }
  return { file: dest, bytes, contentType, sniff: sniff(headOf(dest)) };
}

/** Convert any audio file to mp3 (null when ffmpeg is missing or fails). */
export async function audioToMp3(input, output = tempPath('mp3', 'mp3')) {
  if (!ffmpeg.works()) return null;
  try {
    await ffmpeg.execFile(ffmpeg.resolve(), [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', input, '-vn', '-ac', '2', '-b:a', '128k', '-ar', '44100', '-f', 'mp3', output,
    ], { timeout: 10 * 60_000 });
    if (fs.existsSync(output) && fs.statSync(output).size > 1024) return output;
    removeTemp(output);
    return null;
  } catch {
    removeTemp(output);
    return null;
  }
}

/**
 * Make a video file playable in WhatsApp (H.264 + AAC inside mp4).
 * Remuxes when already compatible; transcodes AV1/VP9/HEVC when not.
 */
export async function ensureWhatsAppMp4(input, output = tempPath('wa', 'mp4'), { timeoutMs = 20 * 60_000 } = {}) {
  if (!ffmpeg.works()) return input;
  const { isH264, stderr } = await probeCodecsSafe(input);
  const isMp4 = sniffFile(input).ext === 'mp4';

  if (isH264 && isMp4) {
    try {
      await ffmpeg.execFile(ffmpeg.resolve(), ['-y', '-i', input, '-c', 'copy', '-movflags', '+faststart', output], { timeout: 180_000 });
      if (fs.existsSync(output) && fs.statSync(output).size > 1024) return output;
    } catch { /* fall through */ }
    removeTemp(output);
    return input;
  }
  if (!stderr) return input;   // ffmpeg could not probe it — send whatever we got

  await ffmpeg.execFile(ffmpeg.resolve(), [
    '-y', '-i', input, '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264', '-profile:v', 'main', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', output,
  ], { timeout: timeoutMs });
  return output;
}

async function probeCodecsSafe(file) {
  try { return await ffmpeg.probeCodecs(file); }
  catch (e) { return { hasAudio: false, isH264: false, stderr: String(e.stderr || e.message || '') }; }
}

/** Filesystem-safe file name. */
export const safeName = (s, fallback = 'media') => {
  const clean = String(s || '')
    .replace(/[^\w\s\-.()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
  return clean || fallback;
};

/** progress bar helper for status cards */
export const bar = (percent) => {
  const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
};
