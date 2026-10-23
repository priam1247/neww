/**
 * ZaFar Bot — movie/series host adapter
 *
 * The download engine in `engine/` is deliberately generic: it knows how to
 * find and fetch a file, nothing about WhatsApp. This module is the glue that
 * makes it behave like the *rest of this bot* instead of a bolt-on:
 *
 *   • temp files      → the bot's own temp dir (`utils/tempManager`), in a
 *                       `movies/` subfolder it never sweeps
 *   • downloads       → the bot's streamed downloader (`utils/mediaTransfer`)
 *                       with the same size caps / content-type guards as `.dl`
 *   • ffmpeg          → the bot's resolved binary (`utils/ffmpeg`), so the
 *                       engine works wherever `.song`/`.ytv` already work
 *   • sending         → as a DOCUMENT, exactly like `.song`/`.paper` in this bot
 *   • disk            → nothing is cached: the file is deleted after the send
 *
 * Every host module is required lazily and defensively: if one of them is
 * missing or throws, the engine keeps working and only loses that capability.
 * That is what keeps `.movie` from ever being able to break the rest of the bot.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const KB = 1024;
const MB = 1024 * KB;
// ── lazy host modules ──────────────────────────────────────────────────────
const cache = new Map();

function host(id) {
  if (cache.has(id)) return cache.get(id);
  let mod = null;
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    mod = require(id);
  } catch (e) {
    mod = null;
    if (process.env.MOVIE_DEBUG) console.warn(`[movies] host module ${id} unavailable: ${e.message}`);
  }
  cache.set(id, mod);
  return mod;
}

const cfg = () => {
  const config = host('../config');
  return config || {};
};
const moviesCfg = () => cfg().movies || {};
const tempMod = () => host('./tempManager');
const transfer = () => host('./mediaTransfer');
const ffmpegMod = () => host('./ffmpeg');
const nm3u8Mod = () => host('./nm3u8dl');

/** Forget cached host modules (tests / hot reloads). */
function reset() { cache.clear(); }

// ── filesystem ─────────────────────────────────────────────────────────────
/**
 * The bot's temp dir, in a `movies/` subfolder. `utils/cleanup.js` only deletes
 * loose files, so nothing the engine keeps here is ever swept away.
 */
function tempDir() {
  const t = tempMod();
  const base = (t && typeof t.getTempDir === 'function') ? t.getTempDir() : path.join(process.cwd(), 'temp');
  const dir = path.join(base, 'movies');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* read-only fs */ }
  return dir;
}

/** Absolute path inside the movies temp dir. */
const tempFile = (name) => path.join(tempDir(), name);

/**
 * Delete a temp file through the bot's temp manager (best effort).
 *
 * deleteTempFile() refuses anything outside its own temp dir, and it can be
 * initialised against a different root than the one the engine used — so a
 * refusal falls through to a direct unlink. Both paths are inside the bot.
 */
function cleanup(file) {
  if (!file) return;
  const t = tempMod();
  try {
    if (t && typeof t.deleteTempFile === 'function') {
      if (t.deleteTempFile(file) === true) return;
      if (!fs.existsSync(file)) return true;
    }
  } catch { /* fall through */ }
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

const fmtMB = (bytes) => `${(Number(bytes || 0) / MB).toFixed(1)} MB`;

/** Header sniffing from the bot's transfer helpers (falls back to the extension). */
function sniff(file) {
  const m = transfer();
  if (m && typeof m.sniffFile === 'function') {
    try { return m.sniffFile(file); } catch { /* fall through */ }
  }
  const ext = String(path.extname(file || '')).replace('.', '').toLowerCase() || 'mp4';
  return { kind: 'video', ext, mime: 'video/mp4' };
}

/** WhatsApp/fs-safe name, shared with `.song`/`.ytv`. */
function safeName(value, fallback = 'video') {
  const m = transfer();
  if (m && typeof m.safeName === 'function') {
    try { return m.safeName(value, fallback); } catch { /* fall through */ }
  }
  return String(value || fallback).replace(/[^\w\s.-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 90) || fallback;
}

// ── capabilities ───────────────────────────────────────────────────────────
function ffmpeg() {
  const f = ffmpegMod();
  if (!f) return { works: false, version: null, path: null };
  let works = false;
  try { works = typeof f.works === 'function' ? f.works() : false; } catch { works = false; }
  let version = null;
  try { version = works && typeof f.version === 'function' ? f.version() : null; } catch { version = null; }
  let bin = null;
  try { bin = typeof f === 'function' ? f() : null; } catch { bin = null; }
  return { works, version, path: bin };
}

/** Path the engine should use for HLS / remuxing (null = let it probe). */
function ffmpegPath() {
  const f = ffmpeg();
  return f.works ? f.path : null;
}

function defaultQuality() {
  const direct = Number(moviesCfg().defaultQuality) || 0;
  if (direct) return direct;
  try {
    const settings = host('./mediaSettings');
    const q = Number(settings && settings.get && settings.get('videoQuality', 0)) || 0;
    if (q) return q;
  } catch { /* ignore */ }
  return Number(cfg().video && cfg().video.defaultQuality) || 720;
}

function maxDownloadMB() {
  return Number(moviesCfg().maxDownloadMB) || 2000;
}

function nm3u8dl() {
  const n = nm3u8Mod();
  if (!n || typeof n.diagnostics !== 'function') {
    return { available: false, path: null, version: null, threads: 16, retries: 10 };
  }
  try { return n.diagnostics(); } catch {
    return { available: false, path: null, version: null, threads: 16, retries: 10 };
  }
}

function capabilities() {
  const t = transfer();
  return {
    tempDir: tempDir(),
    downloader: Boolean(t && typeof t.downloadToFile === 'function'),
    ffmpeg: ffmpeg(),
    nm3u8dl: nm3u8dl(),
    maxDownloadMB: maxDownloadMB(),
    defaultQuality: defaultQuality(),
    send: 'document (same as .song/.paper)',
  };
}

/**
 * High-speed parallel HLS/DASH download via `N_m3u8DL-RE` + `ffmpeg` muxing.
 * Throws `{ code: 'TOO_BIG' | 'ABORTED' }` on hard stops so the caller does not
 * waste time retrying oversized/cancelled jobs; any other failure allows the
 * engine to fall back seamlessly to `ffmpeg` or `downloadHlsNative`.
 */
async function hlsDownload(url, dest, {
  headers = {},
  maxHeight,
  maxBytes,
  stallMs,
  onProgress,
  onAbort,
  keys,
} = {}) {
  const mode = String(moviesCfg().hlsEngine || 'auto').toLowerCase();
  if (mode === 'ffmpeg' || mode === 'native' || mode === 'off') {
    throw Object.assign(new Error(`hlsEngine=${mode}`), { code: 'NM3U8DL_SKIPPED' });
  }
  const n = nm3u8Mod();
  if (!n || typeof n.downloadHls !== 'function') {
    throw Object.assign(new Error('nm3u8dl helper unavailable'), { code: 'NO_NM3U8DL' });
  }
  const cap = Number(maxBytes) || Math.round(maxDownloadMB() * 1.2 * MB);
  return n.downloadHls(url, dest, {
    headers,
    maxHeight,
    maxBytes: cap,
    stallMs,
    onProgress,
    onAbort,
    keys,
    ffmpegPath: ffmpegPath(),
    threads: moviesCfg().hlsThreads,
    retries: moviesCfg().hlsRetries,
  });
}

// ── download ───────────────────────────────────────────────────────────────
/**
 * Stream `url` to `dest` with the bot's downloader.
 * Progress is reported as (receivedBytes, totalBytes) like the engine expects.
 */
async function download(url, dest, { headers = {}, maxBytes, onProgress } = {}) {
  const m = transfer();
  if (!m || typeof m.downloadToFile !== 'function') {
    throw new Error('download helper unavailable (utils/mediaTransfer.js)');
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const cap = Number(maxBytes) || maxDownloadMB() * MB;

  const res = await m.downloadToFile(url, dest, {
    headers,
    maxBytes: cap,
    onProgress: typeof onProgress === 'function'
      ? (p) => { try { onProgress(p.downloaded || 0, p.total || 0); } catch { /* ignore */ } }
      : undefined,
  });

  if (!fs.existsSync(dest) || fs.statSync(dest).size < 10 * KB) {
    throw new Error('the downloaded file is too small to be media');
  }
  return { file: dest, bytes: res && res.bytes ? res.bytes : fs.statSync(dest).size, sniff: res && res.sniff };
}

// ── sending ────────────────────────────────────────────────────────────────
/**
 * Send a finished download the way this bot sends media: as a DOCUMENT.
 * (`.song` is sent as a document here too — no transcoding, no RAM spike.)
 *
 * @returns {Promise<{as:'document', bytes:number}>}
 */
const MIME_BY_EXT = {
  mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska',
  webm: 'video/webm', avi: 'video/x-msvideo', ts: 'video/mp2t',
};

async function sendMedia(sock, chatId, msg, { file, title = '', caption = '' } = {}) {
  const stat = fs.statSync(file);
  const name = safeName(title || path.basename(file, path.extname(file)), 'video');
  const ext = (path.extname(file) || '.mp4').replace('.', '').toLowerCase();
  const fileName = `${name}.${ext}`;
  const text = caption || `🎬 *${name}*\n📦 ${fmtMB(stat.size)}`;

  const qOpts = host('./selections')?.quoteOpts ? host('./selections').quoteOpts(msg) : (msg?.message ? { quoted: msg } : {});
  await sock.sendMessage(chatId, {
    document: { url: file },
    // an HLS source without ffmpeg lands as .ts — say so instead of lying
    mimetype: MIME_BY_EXT[ext] || 'video/mp4',
    fileName,
    caption: text,
  }, qOpts);
  return { as: 'document', bytes: stat.size };
}

/**
 * Send a subtitle track (.srt) as its own small document.
 * Subtitles are useless as a caption, and WhatsApp shows .srt inline on some
 * clients — a document keeps the exact filename media players expect.
 */
async function sendSubtitle(sock, chatId, msg, { file, name = 'subtitle', language = '' } = {}) {
  if (!file || !fs.existsSync(file)) return null;
  const stat = fs.statSync(file);
  if (!stat.size) return null;
  const ext = (path.extname(file) || '.srt').replace('.', '').toLowerCase();
  const base = safeName(name, 'subtitle');
  const tag = language ? `.${String(language).toLowerCase().replace(/[^a-z-]/g, '')}` : '';
  const qOpts = host('./selections')?.quoteOpts ? host('./selections').quoteOpts(msg) : (msg?.message ? { quoted: msg } : {});
  await sock.sendMessage(chatId, {
    document: { url: file },
    mimetype: ext === 'vtt' ? 'text/vtt' : 'application/x-subrip',
    fileName: `${base}${tag}.${ext}`,
  }, qOpts);
  return { bytes: stat.size, fileName: `${base}${tag}.${ext}` };
}

/**
 * Hand a file over to the chat as a document/video.
 *
 * @returns {Promise<{as:'video'|'document', bytes:number, error?:string}>}
 */
async function deliver(sock, chatId, msg, opts = {}) {
  const release = require('./tempManager').holdTemp(opts.file);
  try { return await deliverFile(sock, chatId, msg, opts); } finally { release(); }
}

async function deliverFile(sock, chatId, msg, { file, title = '', caption = '', onProgress } = {}) {
  const bytes = fs.statSync(file).size;
  if (typeof onProgress === 'function') { try { onProgress(0, bytes); } catch { /* ignore */ } }
  return sendMedia(sock, chatId, msg, { file, title, caption });
}

/**
 * Delete a file the chat has already received.
 *
 * Disk is the scarce resource on a panel, not bandwidth: keeping a 2 GB movie
 * for a repeat request is what pushed a 3 GB disk to full. The cache entry (if
 * any) goes with it, so the next request downloads again instead of handing
 * back a path that no longer exists.
 *
 * @returns {Promise<boolean>} true when something was deleted
 */
async function release(file) {
  if (!file) return false;
  cleanup(file);
  return true;
}

/** One-line capability summary used by `.moviestatus` / `.providers`. */
function statusLine() {
  const caps = capabilities();
  const ff = caps.ffmpeg.works ? `ffmpeg ${caps.ffmpeg.version || 'ok'}` : 'ffmpeg missing';
  const re = caps.nm3u8dl.available ? `N_m3u8DL-RE (${caps.nm3u8dl.threads}t)` : 'HLS fallback';
  const dl = caps.downloader ? 'downloader ✓' : 'downloader ✗';
  return `${dl} · ${re} · ${ff} · no cache (file deleted after send)`;
}

module.exports = {
  // lifecycle
  reset, capabilities, statusLine,
  // paths
  tempDir, tempFile, cleanup, fmtMB,
  // media
  sniff, safeName, ffmpeg, ffmpegPath, nm3u8dl, defaultQuality, maxDownloadMB,
  download, hlsDownload, sendMedia, sendSubtitle, release,
  // delivery
  deliver,
};
