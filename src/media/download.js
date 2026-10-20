// src/media/download.js — streamed downloads: never buffer a movie in RAM.
// HTTP: resume-aware, backpressure-handled, low-disk guard, progress events.
// HLS:  ffmpeg remux straight to disk.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import config from '../config.js';
import { formatBytes } from '../utils/format.js';
import { freeBytes, ensureDir, which, sanitize as sanitizeName } from '../utils/disk.js';
import { emit, EVENTS } from '../core/events.js';
import { metrics } from '../core/metrics.js';

export const sanitize = (name, q, s, e) => {
  const base = sanitizeName(name);
  const tag = s != null ? `S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}` : '';
  return [base, tag, `${q}p`, 'x264'].filter(Boolean).join('.') + '.mp4';
};

// HLS -> mp4 via ffmpeg, straight to disk
export async function hlsToFile(url, dest, onProgress) {
  const ffmpeg = await which('ffmpeg');
  if (!ffmpeg) throw new Error('ffmpeg required for HLS sources (apt install ffmpeg)');
  ensureDir(path.dirname(dest));

  await new Promise((resolve, reject) => {
    const p = execFile(ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-headers', `User-Agent: ${config.userAgent}\r\n`,
      '-i', url,
      '-c', 'copy', '-bsf:a', 'aac_adtstoasc',
      '-movflags', '+faststart',
      dest
    ], { maxBuffer: 1 << 24 });
    let lastSize = 0;
    const tick = setInterval(() => {
      try {
        const s = fs.statSync(dest).size;
        if (s !== lastSize) { lastSize = s; onProgress?.(s, 0); }
      } catch {}
    }, 4000);
    p.on('error', (e) => { clearInterval(tick); reject(e); });
    p.on('close', (c) => { clearInterval(tick); c === 0 ? resolve() : reject(new Error(`ffmpeg ${c}`)); });
  });

  const bytes = fs.statSync(dest).size;
  metrics.bump('download.bytes', {}, bytes);
  return { bytes };
}

// streamed HTTPS download. resume-aware, zero heap buffering
export async function httpToFile(url, dest, { onProgress, onAbort } = {}) {
  ensureDir(path.dirname(dest));

  let start = 0;
  if (fs.existsSync(dest)) start = fs.statSync(dest).size;

  emit(EVENTS.DOWNLOAD_START, { dest, resumeFrom: start });
  const res = await fetch(url, {
    headers: { 'user-agent': config.userAgent, ...(start ? { range: `bytes=${start}-` } : {}) },
    signal: AbortSignal.timeout(60000)
  });
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);

  // server ignored the range header? restart cleanly
  if (start && res.status !== 206) start = 0;

  const total = Number(res.headers.get('content-length') || 0) + start;

  const free = await freeBytes(path.dirname(dest));
  if (free !== null && total && free < total + 400 * 1048576) {
    throw new Error(`low disk: need ${formatBytes(total)}, have ${formatBytes(free)}`);
  }

  const out = fs.createWriteStream(dest, { flags: start ? 'a' : 'w' });
  let got = start, last = 0;

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
  metrics.bump('download.bytes', {}, got);
  emit(EVENTS.DOWNLOAD_DONE, { dest, bytes: got });
  return { bytes: got };
}
