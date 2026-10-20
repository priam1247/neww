// engine/media/hls.js — HLS downloader that needs NO ffmpeg.
//
// The host this bot runs on has no ffmpeg (the panel blocks npm install
// scripts, and the image ships without it), so "ffmpeg required for HLS" meant
// every stream source died at download time. This module fetches the playlist,
// picks the variant, downloads the segments and concatenates them:
//
//   • fMP4 playlists (#EXT-X-MAP) → init.mp4 + segments  → a valid .mp4
//   • TS playlists                → consecutive .ts chunks → one .ts file
//   • AES-128 encrypted segments  → decrypted with node:crypto
//
// Quality is honest: the requested height is matched against the master
// playlist's RESOLUTION lines, so a 720p request never silently pulls 1080p.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import config from '../config.js';

const UA = () => config.userAgent;
const SEGMENT_CONCURRENCY = Number(process.env.HLS_CONCURRENCY || 4);

const request = (url, headers = {}, timeoutMs) => fetch(url, {
  headers: { 'user-agent': UA(), accept: '*/*', ...headers },
  signal: AbortSignal.timeout(timeoutMs || Math.max(20000, config.verifyTimeoutMs * 3)),
  redirect: 'follow'
});

const abs = (u, base) => { try { return new URL(u, base).toString(); } catch { return u; } };

/**
 * Master playlist → [{height, bandwidth, url}] sorted best-first.
 * Line based (not one big regex) so blank lines, CRLF and #EXT-X-I-FRAME
 * entries cannot swallow the next URI.
 */
export function parseVariants(playlist, baseUrl) {
  const out = [];
  const lines = String(playlist || '').split(/\r?\n/).map(l => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^#EXT-X-STREAM-INF:/i.test(line)) continue;
    const height = Number(/RESOLUTION=\d+x(\d+)/i.exec(line)?.[1] || 0);
    const bandwidth = Number(/BANDWIDTH=(\d+)/i.exec(line)?.[1] || 0);
    let j = i + 1;
    while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
    if (j >= lines.length) break;
    out.push({ height, bandwidth, url: abs(lines[j], baseUrl) });
    i = j;
  }
  return out.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
}

/** Pick the variant closest to (and not above) the wanted height. */
export function chooseVariant(variants, want) {
  if (!variants.length) return null;
  const target = Number(want) || 0;
  if (!target) return variants[0];
  const atOrBelow = variants.filter(v => v.height && v.height <= target + 60);
  if (atOrBelow.length) return atOrBelow[0];          // already sorted best-first
  return variants[variants.length - 1];               // nothing that small → lowest
}

/** Media playlist → { segments, initUrl, mediaSequence, encrypted } */
export function parseMedia(playlist, baseUrl) {
  const lines = String(playlist || '').split(/\r?\n/).map(l => l.trim());
  const segments = [];
  let initUrl = null;
  let key = null;
  let mediaSequence = 0;
  let encrypted = false;

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(line.split(':')[1]) || 0;
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const uri = /URI="([^"]+)"/.exec(line)?.[1];
      if (uri) initUrl = abs(uri, baseUrl);
      continue;
    }
    if (line.startsWith('#EXT-X-KEY:')) {
      const method = /METHOD=([A-Z0-9-]+)/i.exec(line)?.[1] || '';
      const uri = /URI="([^"]+)"/.exec(line)?.[1];
      // METHOD=NONE clears a previous key; SAMPLE-AES we cannot handle → skip.
      key = method === 'AES-128' && uri ? { uri: abs(uri, baseUrl), iv: /IV=0x([0-9a-fA-F]+)/.exec(line)?.[1] || null } : null;
      if (key) encrypted = true;
      continue;
    }
    if (line.startsWith('#')) continue;
    segments.push({ url: abs(line, baseUrl), key });
  }

  return { segments, initUrl, mediaSequence, encrypted };
}

async function fetchKey(keyInfo, headers) {
  const res = await request(keyInfo.uri, headers);
  if (!res.ok) throw new Error(`HLS key HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function decrypt(buffer, key, ivHex, seq) {
  const iv = ivHex
    ? Buffer.from(ivHex.padStart(32, '0').slice(0, 32), 'hex')
    : (() => { const b = Buffer.alloc(16); b.writeUInt32BE(seq >>> 0, 12); return b; })();
  const dec = crypto.createDecipheriv('aes-128-cbc', key, iv);
  try {
    return Buffer.concat([dec.update(buffer), dec.final()]);   // HLS pads each segment
  } catch {
    dec.setAutoPadding(false);                                  // some encoders don't
    return Buffer.concat([dec.update(buffer), dec.final()]);
  }
}

/** Download one segment (with one retry) into memory. */
async function fetchSegment(seg, headers, timeoutMs) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await request(seg.url, headers, timeoutMs);
      if (!res.ok) throw new Error(`HLS segment HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (attempt >= 1) throw e;
      await new Promise(r => setTimeout(r, 400));
    }
  }
}

/**
 * Download an HLS stream to disk with no external tools.
 * Writes init + segments into ONE file, honouring the real container:
 * a TS playlist becomes `.ts`, a fragmented-MP4 playlist becomes `.mp4`.
 *
 * @returns {Promise<{file:string, bytes:number, variant:number}>}
 */
export async function downloadHlsNative(url, dest, { headers = {}, onProgress, maxHeight, maxBytes } = {}) {
  let playlistUrl = url;
  let text = await (async () => {
    const res = await request(playlistUrl, headers);
    if (!res.ok) throw new Error(`HLS playlist HTTP ${res.status}`);
    return res.text();
  })();

  if (!/#EXTM3U/i.test(text)) throw new Error('not an HLS playlist');

  let variantHeight = 0;
  if (/#EXT-X-STREAM-INF/i.test(text)) {
    const variants = parseVariants(text, playlistUrl);
    const chosen = chooseVariant(variants, maxHeight);
    if (!chosen) throw new Error('HLS master playlist has no variants');
    playlistUrl = chosen.url;
    variantHeight = chosen.height;
    const res = await request(playlistUrl, headers);
    if (!res.ok) throw new Error(`HLS variant HTTP ${res.status}`);
    text = await res.text();
  }

  const { segments, initUrl, mediaSequence, encrypted } = parseMedia(text, playlistUrl);
  if (!segments.length) throw new Error('HLS playlist has no segments');

  // Container decision: sniff the first payload instead of trusting the URL.
  const firstKey = initUrl ? null : segments[0].key;
  const firstBuf = await fetchSegment(initUrl ? { url: initUrl, key: null } : segments[0], headers);
  const first = firstKey
    ? decrypt(firstBuf, await fetchKey(firstKey, headers), firstKey.iv, mediaSequence)
    : firstBuf;
  const isTs = first.length > 188 && first[0] === 0x47 && first[188] === 0x47;
  const ext = isTs ? '.ts' : '.mp4';

  const outPath = dest.toLowerCase().endsWith(ext) ? dest : dest.replace(/\.(mp4|mkv|ts|m4v)$/i, '') + ext;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const fd = fs.openSync(outPath, 'w');
  let bytes = 0;
  let done = 0;
  const total = segments.length + (initUrl ? 1 : 0);
  const keys = new Map();

  const write = (buf) => {
    if (maxBytes && bytes + buf.length > maxBytes) {
      throw Object.assign(new Error('HLS stream larger than the cap'), { code: 'TOO_BIG' });
    }
    fs.writeSync(fd, buf);
    bytes += buf.length;
    onProgress?.(++done, total, bytes);
  };

  const keyFor = async (keyInfo) => {
    if (!keyInfo) return null;
    const cacheKey = `${keyInfo.uri}|${keyInfo.iv || ''}`;
    if (!keys.has(cacheKey)) keys.set(cacheKey, await fetchKey(keyInfo, headers));
    return keys.get(cacheKey);
  };

  try {
    write(first);                                   // init, or segment #0
    const start = initUrl ? 0 : 1;                  // segment #0 already written

    // Bounded concurrency keeps the pipe full on long movies without ever
    // holding more than a few MB in RAM.
    for (let i = start; i < segments.length; i += SEGMENT_CONCURRENCY) {
      const chunk = segments.slice(i, i + SEGMENT_CONCURRENCY);
      const buffers = await Promise.all(chunk.map(async (seg) => {
        const raw = await fetchSegment(seg, headers);
        const key = await keyFor(seg.key);
        return key ? decrypt(raw, key, seg.key.iv, mediaSequence + i) : raw;
      }));
      for (const buf of buffers) write(buf);
    }
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }

  if (bytes < 10 * 1024) throw new Error('HLS download produced no data');
  return { file: outPath, bytes, variant: variantHeight, encrypted, segments: segments.length };
}

export default { downloadHlsNative, parseVariants, parseMedia, chooseVariant };
