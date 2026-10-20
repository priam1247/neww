// src/core/verify.js — truth-checking before download.
// 2.0 hard-failed every URL when ffprobe was missing. 3.0:
//  • HEAD for real size, reject samples and monsters
//  • ffprobe (if present): exact height within ±240p of the label
//  • NEW magic-byte fallback: mp4/mkv/webm/avi sniffing when ffprobe absent
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import config from '../config.js';
import { which } from '../utils/disk.js';
import { metrics } from './metrics.js';
import { emit, EVENTS } from './events.js';

const exec = (bin, args, ms = 20000) => new Promise((res, rej) => {
  const p = execFile(bin, args, { timeout: ms, maxBuffer: 1 << 22 }, (e, o) => e ? rej(e) : res(o));
  p.on('error', rej);
});

export const MAGIC = [
  { name: 'mp4', test: (b) => b.length > 11 && b.slice(4, 8).toString('ascii') === 'ftyp' },
  { name: 'mkv/webm', test: (b) => b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  { name: 'avi', test: (b) => b.length > 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'AVI ' },
  { name: 'mpegts', test: (b) => b.length > 188 && b[0] === 0x47 && b[188] === 0x47 }
];

export function sniffContainer(buf) {
  for (const m of MAGIC) if (m.test(buf)) return m.name;
  return null;
}

// grab the first N bytes and let ffprobe tell us what it REALLY is
export async function probeRange(url, bytes = config.verifyBytes) {
  const ffprobe = await which('ffprobe');
  if (!ffprobe) return null;

  const res = await fetch(url, {
    headers: { range: `bytes=0-${bytes - 1}`, 'user-agent': config.userAgent },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok && res.status !== 206) throw new Error(`range ${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 20000) throw new Error('suspiciously small header');

  const tmp = path.join(os.tmpdir(), `zf3-probe-${process.pid}-${Date.now()}.bin`);
  fs.writeFileSync(tmp, buf);
  try {
    const out = await exec(ffprobe, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=height,codec_name,width',
      '-show_entries', 'format=duration',
      '-of', 'json', tmp
    ]);
    return JSON.parse(out);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}

export async function verify(cand, opts = {}) {
  const url = cand.url;
  if (!url) throw new Error('no url');

  const head = await fetch(url, {
    method: 'HEAD', headers: { 'user-agent': config.userAgent },
    signal: AbortSignal.timeout(9000)
  }).catch(() => null);

  let sizeMB = cand.sizeMB || 0;
  if (head?.ok) {
    const len = Number(head.headers.get('content-length') || 0);
    if (len) sizeMB = len / 1048576;
  } else if (cand.kind !== 'hls') {
    throw new Error(`dead link ${head?.status ?? 'unreachable'}`);
  }

  if (sizeMB && sizeMB < 60) {
    metrics.bump('verify.fail');
    throw new Error(`too small (${sizeMB.toFixed(0)}MB) — likely a sample`);
  }
  if (sizeMB && sizeMB > config.maxSendMB * 1.4) {
    metrics.bump('verify.fail');
    throw new Error(`too big (${sizeMB.toFixed(0)}MB)`);
  }

  // quality truth-check
  if (cand.kind !== 'hls' && cand.quality) {
    const ffprobe = await which('ffprobe');
    if (ffprobe) {
      try {
        const p = await probeRange(url);
        const h = p?.streams?.[0]?.height;
        if (h && Math.abs(h - cand.quality) > 240) {
          metrics.bump('verify.fail');
          throw new Error(`quality mismatch: labelled ${cand.quality}p, actually ${h}p`);
        }
        metrics.bump('verify.ok');
        emit(EVENTS.VERIFY_OK, { provider: cand.provider || 'unknown', height: h });
        return { url, sizeMB, probe: p, verified: true };
      } catch (e) {
        if (/mismatch|small|too big/.test(e.message)) throw e;
        // probe inconclusive → fall through to magic-byte check below
      }
    }
    // magic-byte container check: proves it's a real video file, not HTML junk
    const container = await sniffRemote(url).catch(() => null);
    if (container === null && sizeMB > 0) {
      // unknown container AND measurable size → likely an error page
      metrics.bump('verify.fail');
      throw new Error('unrecognized container (not mp4/mkv/webm/avi/ts)');
    }
    metrics.bump('verify.ok');
    return { url, sizeMB, verified: container !== null, container };
  }

  metrics.bump('verify.ok');
  return { url, sizeMB, verified: false };
}

// download just the first 256 bytes and identify the container
export async function sniffRemote(url) {
  const res = await fetch(url, {
    headers: { range: 'bytes=0-255', 'user-agent': config.userAgent },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok && res.status !== 206) throw new Error(`sniff ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 16) return null;
  const name = sniffContainer(buf);
  return name;          // null = unrecognized
}
