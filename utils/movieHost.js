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
 *   • very big files  → uploaded to the bot's Drime Cloud account (the same
 *                       account `.paper` uses) and delivered as a link
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
/** Same threshold `.dl` / `.song` use to pick video vs document. */
/** Drime multipart chunk size (documented minimum). */
const PART_SIZE = 5 * MB;

// ── lazy host modules ──────────────────────────────────────────────────────
const cache = new Map();
/** Injection point for tests: replaces axios for Drime calls. */
let injectedHttp = null;
function setHttp(client) { injectedHttp = client; }

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

/** Forget cached host modules (tests / hot reloads). */
function reset() { cache.clear(); injectedHttp = null; }

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

/** Delete a temp file through the bot's temp manager (best effort). */
function cleanup(file) {
  if (!file) return;
  const t = tempMod();
  try {
    if (t && typeof t.deleteTempFile === 'function') return t.deleteTempFile(file);
  } catch { /* fall through */ }
  try { fs.unlinkSync(file); } catch { /* already gone */ }
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
  return Number(moviesCfg().maxDownloadMB) || 4096;
}

function capabilities() {
  const t = transfer();
  const drimeCfg = cfg().drime || {};
  return {
    tempDir: tempDir(),
    downloader: Boolean(t && typeof t.downloadToFile === 'function'),
    ffmpeg: ffmpeg(),
    drime: {
      configured: Boolean(drimeCfg.apiToken),
      mode: drimeMode(),
      thresholdMB: drimeThresholdMB(),
    },
    maxDownloadMB: maxDownloadMB(),
    defaultQuality: defaultQuality(),
    send: 'document (same as .song/.paper)',
  };
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
async function sendMedia(sock, chatId, msg, { file, title = '', caption = '' } = {}) {
  const stat = fs.statSync(file);
  const name = safeName(title || path.basename(file, path.extname(file)), 'video');
  const fileName = `${name}${path.extname(file) || '.mp4'}`;
  const text = caption || `🎬 *${name}*\n📦 ${fmtMB(stat.size)}`;

  await sock.sendMessage(chatId, {
    document: { url: file },
    mimetype: 'video/mp4',
    fileName,
    caption: text,
  }, { quoted: msg });
  return { as: 'document', bytes: stat.size };
}

// ── Drime Cloud (same account as .paper) ───────────────────────────────────
/** off | big (only files above the threshold) | always */
function drimeMode() {
  const mode = String(moviesCfg().drimeUpload || 'big').toLowerCase();
  return ['off', 'big', 'always'].includes(mode) ? mode : 'big';
}

function drimeThresholdMB() {
  const configured = Number(moviesCfg().drimeThresholdMB);
  if (configured) return configured;
  const videoMax = Number(cfg().video && cfg().video.maxMB);
  return videoMax || 300;
}

/** Does this file need Drime (because WhatsApp would refuse it)? */
function shouldUploadDrime(bytes) {
  const mode = drimeMode();
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  return Number(bytes) > drimeThresholdMB() * MB;
}

function drimeReady() {
  const d = cfg().drime || {};
  return Boolean(d.apiToken && d.baseUrl);
}

/**
 * Upload via Drime's documented S3 multipart flow:
 *   create → sign part URLs → PUT parts → complete → /s3/entries → link
 *
 * @returns {Promise<{id:number,hash:string,name:string,size:number,link:string}>}
 */
async function drimeUpload(file, name, { onProgress } = {}) {
  if (!drimeReady()) throw new Error('Drime is not configured (set DRIME_API_TOKEN)');

  let axios = injectedHttp;
  if (!axios) {
    try { axios = require('axios'); } catch { axios = null; }
  }
  if (!axios) throw new Error('axios is required for Drime uploads (npm install)');

  const d = cfg().drime || {};
  const size = fs.statSync(file).size;
  const display = safeName(name || path.basename(file), 'movie');
  const ext = String(path.extname(file) || '.mp4').replace('.', '').toLowerCase() || 'mp4';
  const mime = ext === 'mp4' ? 'video/mp4' : 'application/octet-stream';
  const workspaceId = Number(d.workspaceId) || 0;
  const parentId = Number(moviesCfg().drimeFolderId || d.moviesFolderId) || null;

  const client = axios.create({
    baseURL: d.baseUrl || 'https://app.drime.cloud/api/v1',
    timeout: 2 * 60 * 1000,
    headers: { Authorization: `Bearer ${d.apiToken}` },
  });

  // 1 — create the multipart upload
  const created = await client.post('/s3/multipart/create', {
    filename: `${display}.${ext}`,
    mime,
    size,
    extension: ext,
    workspaceId,
    ...(parentId ? { parentId } : {}),
  });
  const { key, uploadId } = created.data || {};
  if (!key || !uploadId) throw new Error('Drime did not return an upload session');

  const totalParts = Math.max(1, Math.ceil(size / PART_SIZE));

  try {
    // 2 — sign every part in one request
    const signed = await client.post('/s3/multipart/batch-sign-part-urls', {
      key, uploadId,
      partNumbers: Array.from({ length: totalParts }, (_, i) => i + 1),
    });
    const urls = (signed.data && signed.data.urls) || [];
    if (urls.length !== totalParts) throw new Error('Drime signed an unexpected number of parts');

    // 3 — PUT each chunk (sequential: one movie at a time on a small host)
    const fd = fs.openSync(file, 'r');
    const parts = [];
    let sent = 0;
    try {
      for (const { partNumber, url } of urls.sort((a, b) => a.partNumber - b.partNumber)) {
        const start = (partNumber - 1) * PART_SIZE;
        const length = Math.min(PART_SIZE, size - start);
        const buffer = Buffer.allocUnsafe(length);
        fs.readSync(fd, buffer, 0, length, start);

        const put = await axios.put(url, buffer, {
          headers: { 'Content-Type': 'application/octet-stream' },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          timeout: 10 * 60 * 1000,
        });
        const etag = put.headers && (put.headers.etag || put.headers.ETag);
        if (!etag) throw new Error(`Drime part ${partNumber} uploaded without an ETag`);
        parts.push({ PartNumber: partNumber, ETag: etag });

        sent += length;
        if (typeof onProgress === 'function') {
          try { onProgress(sent, size); } catch { /* ignore */ }
        }
      }
    } finally {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }

    // 4 — assemble
    await client.post('/s3/multipart/complete', { key, uploadId, parts });

    // 5 — register the entry so it shows up in the Drime dashboard
    const entryRes = await client.post('/s3/entries', {
      filename: String(key).split('/').pop(),
      size,
      clientName: `${display}.${ext}`,
      clientMime: mime,
      clientExtension: ext,
      workspaceId,
      ...(parentId ? { parentId } : {}),
    });
    const entry = (entryRes.data && entryRes.data.fileEntry) || {};

    // 6 — shareable link (best effort; the API download URL always works)
    let link = '';
    if (entry.id) {
      try {
        const shared = await client.get(`/file-entries/${entry.id}/shareable-link`);
        const data = shared.data || {};
        link = (data.link && (data.link.url || data.link.hash)) || data.url || '';
      } catch { link = ''; }
    }
    if (!link && entry.hash) {
      link = `${String(d.baseUrl || 'https://app.drime.cloud/api/v1').replace(/\/$/, '')}/file-entries/download/${entry.hash}`;
    }

    return {
      id: Number(entry.id) || null,
      hash: entry.hash || null,
      name: entry.name || `${display}.${ext}`,
      size,
      link,
    };
  } catch (e) {
    // never leave a half-open multipart upload behind
    try { await client.post('/s3/multipart/abort', { key, uploadId }); } catch { /* ignore */ }
    throw e;
  }
}

/**
 * Hand a file over to the chat, using Drime when it is too big for WhatsApp.
 *
 * @returns {Promise<{as:'video'|'document'|'link', bytes:number, link?:string, error?:string}>}
 */
async function deliver(sock, chatId, msg, { file, title = '', caption = '', onProgress } = {}) {
  const bytes = fs.statSync(file).size;

  if (shouldUploadDrime(bytes) && drimeReady()) {
    try {
      const up = await drimeUpload(file, title || path.basename(file), { onProgress });
      const text = `${caption ? `${caption}\n` : ''}☁️ ${up.link}`;
      // Prefer the file itself; the link is there if WhatsApp refuses it.
      try {
        await sendMedia(sock, chatId, msg, { file, title, caption: text });
      } catch {
        await sock.sendMessage(chatId, { text }, { quoted: msg });
      }
      return { as: 'link', bytes, link: up.link };
    } catch (e) {
      console.warn('[movies] Drime upload failed:', e.message);
      const sent = await sendMedia(sock, chatId, msg, { file, title, caption });
      return { ...sent, error: e.message };
    }
  }

  return sendMedia(sock, chatId, msg, { file, title, caption });
}

/** One-line capability summary used by `.moviestatus` / `.providers`. */
function statusLine() {
  const caps = capabilities();
  const ff = caps.ffmpeg.works ? `ffmpeg ${caps.ffmpeg.version || 'ok'}` : 'ffmpeg missing';
  const drime = caps.drime.configured ? `Drime ✓ (${caps.drime.mode})` : 'Drime ✗';
  const dl = caps.downloader ? 'downloader ✓' : 'downloader ✗';
  return `${dl} · ${ff} · ${drime}`;
}

module.exports = {
  // lifecycle
  reset, setHttp, capabilities, statusLine,
  // paths
  tempDir, tempFile, cleanup, fmtMB,
  // media
  sniff, safeName, ffmpeg, ffmpegPath, defaultQuality, maxDownloadMB,
  download, sendMedia,
  // drime
  drimeReady, drimeMode, drimeThresholdMB, shouldUploadDrime, drimeUpload,
  // delivery
  deliver,
};
