/**
 * ZaFar Bot — media transfer helpers
 *
 * Shared by .song / .ytv (and usable by any other downloader):
 *   • stream a URL to disk with a hard size cap (RAM stays flat),
 *   • sniff the real container from the file header so we never label an m4a
 *     as an mp3 or send a webm as mp4,
 *   • convert audio to mp3 / remux+transcode video to a WhatsApp-playable mp4.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { pipeline } = require('stream/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');
const getFfmpeg = require('./ffmpeg');
const { getTempDir, deleteTempFile } = require('./tempManager');

const execFileAsync = promisify(execFile);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const fmtMB = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Read up to `n` bytes from the start of a file (cheap header sniffing). */
function headOf(file, n = 4096) {
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(n, size);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, 0);
    fs.closeSync(fd);
    return buf;
  } catch {
    return Buffer.alloc(0);
  }
}

/** Identify the real container from magic bytes (never trust the URL). */
function sniff(head) {
  const b = head || Buffer.alloc(0);
  if (b.length > 12 && b.toString('ascii', 4, 8) === 'ftyp') {
    const brand = b.toString('ascii', 8, 12);
    if (['avif', 'heic', 'heix', 'mif1'].includes(brand)) return { kind: 'image', ext: brand === 'avif' ? 'avif' : 'heic', mime: 'image/heic' };
    // An mp4 with no video track is an .m4a — label it correctly instead of
    // sending audio to WhatsApp as a video ("cannot play this media").
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
    // EBML; audio-only webm (Opus/Vorbis) is common for yt-dlp audio streams.
    const ascii = b.toString('latin1');
    const audioOnly = /A_OPUS|A_VORBIS|A_AAC/.test(ascii) && !/V_VP8|V_VP9|V_AV1|V_MPEG/.test(ascii);
    return audioOnly
      ? { kind: 'audio', ext: 'webm', mime: 'audio/webm' }
      : { kind: 'video', ext: 'webm', mime: 'video/webm' };
  }
  if (b[0] === 0xFF && b[1] === 0xD8) return { kind: 'image', ext: 'jpg', mime: 'image/jpeg' };
  if (b.toString('ascii', 1, 4) === 'PNG') return { kind: 'image', ext: 'png', mime: 'image/png' };
  if (b.toString('ascii', 0, 3) === 'GIF') return { kind: 'image', ext: 'gif', mime: 'image/gif' };
  if (b.toString('ascii', 0, 4) === 'fMP4') return { kind: 'audio', ext: 'm4a', mime: 'audio/mp4' };
  // MPEG-TS: 188-byte packets, sync byte 0x47 at 0 and 188. This is what an
  // HLS download looks like when the host has no ffmpeg to remux it.
  if (b.length > 189 && b[0] === 0x47 && b[188] === 0x47) return { kind: 'video', ext: 'ts', mime: 'video/mp2t' };
  return { kind: 'unknown', ext: 'bin', mime: 'application/octet-stream' };
}

const sniffFile = (file) => sniff(headOf(file));

/**
 * Stream a URL to `dest` without buffering it in RAM.
 * @returns {Promise<{file:string,bytes:number,contentType:string,sniff:object}>}
 */
async function downloadToFile(url, dest, {
  maxBytes = 300 * 1024 * 1024,
  timeout = 180000,
  headers = {},
  onProgress,
} = {}) {
  const res = await axios.get(url, {
    responseType: 'stream',
    timeout,
    maxRedirects: 5,
    maxContentLength: maxBytes,
    maxBodyLength: Infinity,
    headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Encoding': 'identity', ...headers },
    validateStatus: () => true, // handled below so the message stays readable
  });

  if (res.status >= 400) {
    try { res.data.destroy(); } catch { /* ignore */ }
    const err = new Error(`media source answered HTTP ${res.status}`);
    err.code = 'HTTP_ERROR';
    throw err;
  }

  const contentType = String(res.headers['content-type'] || '');
  if (contentType.includes('text/') || contentType.includes('json')) {
    res.data.destroy();
    const err = new Error('media source returned a web page instead of a file');
    err.code = 'BAD_SOURCE';
    throw err;
  }

  let bytes = 0;
  const expected = Number(res.headers['content-length']) || 0;
  if (expected && expected > maxBytes) {
    res.data.destroy();
    const err = new Error('file is larger than the size limit');
    err.code = 'TOO_BIG';
    throw err;
  }

  res.data.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      res.data.destroy(Object.assign(new Error('file is larger than the size limit'), { code: 'TOO_BIG' }));
      return;
    }
    if (onProgress && expected) {
      try { onProgress({ percent: Math.min(99, Math.round((bytes / expected) * 100)), downloaded: bytes, total: expected }); } catch { /* ignore */ }
    }
  });

  await pipeline(res.data, fs.createWriteStream(dest));

  if (bytes < 10 * 1024) {
    deleteTempFile(dest);
    const err = new Error('the downloaded file is too small to be media');
    err.code = 'BAD_SOURCE';
    throw err;
  }

  return { file: dest, bytes, contentType, sniff: sniff(headOf(dest)) };
}

/** Convert any audio file to mp3 (returns null when ffmpeg cannot do it). */
async function audioToMp3(input, output = path.join(getTempDir(), `mp3_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.mp3`)) {
  if (!getFfmpeg.works()) return null;
  try {
    // Highest MP3 quality LAME can produce: VBR V0 (~245–320 kbps), keeping
    // the source sample rate instead of resampling down to 44.1 kHz.
    await execFileAsync(getFfmpeg(), [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', input, '-vn', '-ac', '2',
      '-codec:a', 'libmp3lame', '-q:a', '0', '-compression_level', '0',
      '-f', 'mp3', output,
    ], { timeout: 20 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });

    if (fs.existsSync(output) && fs.statSync(output).size > 1024) return output;
    deleteTempFile(output);
    return null;
  } catch (e) {
    console.warn('[media] mp3 conversion failed:', String(e.stderr || e.message).trim().split('\n').pop());
    deleteTempFile(output);
    return null;
  }
}

/**
 * Make a video file playable in WhatsApp (H.264 + AAC inside mp4).
 * Remuxes when already compatible; transcodes AV1/VP9/HEVC when not.
 * @returns {Promise<string>} path to a playable file (input when nothing to do)
 */
async function ensureWhatsAppMp4(input, output, { timeoutMs = 20 * 60 * 1000 } = {}) {
  const ff = getFfmpeg();
  if (!getFfmpeg.works()) return input;

  let stderr = '';
  try { await execFileAsync(ff, ['-hide_banner', '-i', input], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 }); }
  catch (e) { stderr = String(e.stderr || ''); }

  const isH264 = /Video:\s*h264\b/i.test(stderr);
  const isMp4 = sniffFile(input).ext === 'mp4';

  if (isH264 && isMp4) {
    // Already fine — remux for a fast start, but never fail the send over it.
    try {
      await execFileAsync(ff, ['-y', '-i', input, '-c', 'copy', '-movflags', '+faststart', output], { timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
      if (fs.existsSync(output) && fs.statSync(output).size > 1024) return output;
    } catch { /* fall through */ }
    deleteTempFile(output);
    return input;
  }
  if (!stderr) return input; // ffmpeg could not probe it — send whatever we got

  try {
    await execFileAsync(ff, [
      '-y', '-i', input, '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'libx264', '-profile:v', 'main', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', output,
    ], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    if (fs.existsSync(output) && fs.statSync(output).size > 1024) return output;
  } catch { /* conversion failed — send the original rather than nothing */ }
  deleteTempFile(output);
  return input;
}

/** Filesystem-safe file name. */
const safeName = (s, fallback = 'media') => {
  const clean = String(s || '')
    .replace(/[^\w\s\-.()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
  return clean || fallback;
};

module.exports = { downloadToFile, sniff, sniffFile, headOf, audioToMp3, ensureWhatsAppMp4, safeName, fmtMB, UA };
