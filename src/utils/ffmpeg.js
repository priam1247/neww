// src/utils/ffmpeg.js — merged from Zafar-bot-main: single ffmpeg resolver.
// Probes realistic locations (FFMPEG_PATH → system → user install) and returns
// the first binary that actually runs. Everything ffmpeg-related goes through
// here so a missing binary degrades gracefully instead of crashing commands.
import { execFileSync, execFile as _execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { which } from './disk.js';

const candidates = () => [
  process.env.FFMPEG_PATH,
  which('ffmpeg'),
  '/usr/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  path.join(os.homedir(), '.local', 'bin', 'ffmpeg'),
].filter(Boolean);

let cached = null;
let worksCache = null;

/** @returns {string} path to a working ffmpeg binary (falls back to 'ffmpeg'). */
export function resolve() {
  if (cached) return cached;
  for (const c of candidates()) {
    try { execFileSync(c, ['-version'], { stdio: 'ignore', timeout: 8000 }); cached = c; return c; }
    catch { /* next */ }
  }
  cached = 'ffmpeg';
  return cached;
}

/** True when ffmpeg actually runs on this host. */
export function works() {
  if (worksCache === null) {
    try { execFileSync(resolve(), ['-version'], { stdio: 'ignore', timeout: 8000 }); worksCache = true; }
    catch { worksCache = false; }
  }
  return worksCache;
}

/** ffmpeg --version first line, or null when not runnable. */
export function version() {
  if (!works()) return null;
  try {
    const out = execFileSync(resolve(), ['-version'], { encoding: 'utf8', timeout: 8000 });
    return String(out).split('\n')[0].replace(/^ffmpeg version\s*/i, '').split(' ')[0];
  } catch { return null; }
}

/** promisified execFile with a hard timeout (ffmpeg conversions). */
export function execFile(bin, args, { timeout = 10 * 60_000, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return new Promise((res, rej) => {
    _execFile(bin, args, { timeout, maxBuffer, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr || '');
        return rej(err);
      }
      res({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** true when the probe stderr says the container is already H.264/AAC mp4. */
export async function probeCodecs(file) {
  let stderr = '';
  try { await execFile(resolve(), ['-hide_banner', '-i', file], { timeout: 60_000 }); }
  catch (e) { stderr = String(e.stderr || ''); }
  return {
    hasAudio: /Stream #\d+:\d+.*Audio:/i.test(stderr),
    isH264: /Video:\s*h264\b/i.test(stderr),
    stderr,
  };
}

export default { resolve, works, version, execFile, probeCodecs };
