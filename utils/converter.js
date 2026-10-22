/**
 * ZaFar Bot — ffmpeg helpers
 *
 * Every ffmpeg call must go through this module: it picks a binary that is
 * actually runnable on the host (system ffmpeg → user install → installer package)
 * instead of assuming one specific packaging.
 *
 * Credits: original wrapper idea from the black-hat-md / Baileys community.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawn } = require('child_process');
const { getTempDir, deleteTempFile } = require('./tempManager');

const FFMPEG_CANDIDATES = () => [
  process.env.FFMPEG_PATH,
  'ffmpeg',
  '/usr/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  path.join(os.homedir(), '.local', 'bin', 'ffmpeg'),
  // @ffmpeg-installer ships the binary INSIDE a platform package, so it works
  // on panels that block npm install scripts (which is what killed
  // install-script-only binaries). This is what makes .song → mp3 and merged .ytv
  // possible on the Pterodactyl image.
  (() => {
    try {
      const inst = require('@ffmpeg-installer/ffmpeg');
      return inst && inst.path ? inst.path : null;
    } catch { return null; }
  })(),
].filter(Boolean);

let cached = null;

/** @returns {string} path to a working ffmpeg binary (falls back to 'ffmpeg'). */
function resolve() {
  if (cached) return cached;
  for (const candidate of FFMPEG_CANDIDATES()) {
    try {
      execFileSync(candidate, ['-version'], { stdio: 'ignore', timeout: 8000 });
      cached = candidate;
      return cached;
    } catch { /* try the next candidate */ }
  }
  cached = 'ffmpeg'; // let the caller surface a clear error
  return cached;
}

let _works = null;
/** True when ffmpeg actually runs (some packaged binaries do not run on Termux/Android). */
function works() {
  if (_works === null) {
    try { execFileSync(resolve(), ['-version'], { stdio: 'ignore', timeout: 8000 }); _works = true; }
    catch { _works = false; }
  }
  return _works;
}

/** ffmpeg --version first line, or null when it is not runnable. */
function version() {
  if (!works()) return null;
  try {
    const out = execFileSync(resolve(), ['-version'], { encoding: 'utf8', timeout: 8000 });
    return String(out).split('\n')[0].replace(/^ffmpeg version\s*/i, '').split(' ')[0];
  } catch { return null; }
}

/**
 * Run ffmpeg on a buffer and return the converted buffer.
 * @param {Buffer} buffer input
 * @param {string[]} args ffmpeg arguments (output path is appended)
 * @param {string} ext input extension (no dot)
 * @param {string} outExt output extension (no dot)
 */
function ffmpeg(buffer, args = [], ext = '', outExt = '') {
  return new Promise((resolve, reject) => {
    const tempDir = getTempDir();
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const tmpIn = path.join(tempDir, `conv_${id}${ext ? `.${ext}` : ''}`);
    const tmpOut = path.join(tempDir, `conv_${id}.${outExt || 'out'}`);

    try {
      fs.writeFileSync(tmpIn, buffer);
    } catch (e) {
      return reject(new Error(`Could not write temp file: ${e.message}`));
    }

    if (!works()) {
      deleteTempFile(tmpIn);
      const err = new Error('ffmpeg is not installed or not runnable on this host');
      err.code = 'NO_FFMPEG';
      return reject(err);
    }

    const child = spawn(resolve(), ['-y', '-hide_banner', '-loglevel', 'error', '-i', tmpIn, ...args, tmpOut]);
    let stderr = '';
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
    // If ffmpeg cannot read stdin it just exits; keep the process alive anyway.
    child.stdin.on('error', () => {});

    child.on('error', (e) => {
      deleteTempFile(tmpIn);
      deleteTempFile(tmpOut);
      reject(new Error(`Failed to start ffmpeg: ${e.message}`));
    });

    child.on('close', (code) => {
      try {
        if (code !== 0) {
          deleteTempFile(tmpOut);
          throw new Error(`ffmpeg exited with code ${code}${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`);
        }
        const out = fs.readFileSync(tmpOut);
        if (!out.length) throw new Error('ffmpeg produced an empty file');
        deleteTempFile(tmpOut);
        resolve(out);
      } catch (e) {
        reject(e);
      } finally {
        deleteTempFile(tmpIn);
      }
    });
  });
}

/** Buffer → WhatsApp-playable MP3 audio. */
function toAudio(buffer, ext) {
  return ffmpeg(buffer, ['-vn', '-ac', '2', '-b:a', '128k', '-ar', '44100', '-f', 'mp3'], ext, 'mp3');
}

/** Buffer → WhatsApp voice note (Opus/OGG). */
function toPTT(buffer, ext) {
  return ffmpeg(buffer, ['-vn', '-c:a', 'libopus', '-b:a', '128k', '-vbr', 'on', '-compression_level', '10'], ext, 'opus');
}

/** Buffer → WhatsApp-playable MP4 video. */
function toVideo(buffer, ext) {
  return ffmpeg(buffer, ['-c:v', 'libx264', '-c:a', 'aac', '-ab', '128k', '-ar', '44100', '-crf', '32', '-preset', 'veryfast', '-movflags', '+faststart'], ext, 'mp4');
}

module.exports = {
  ffmpeg, toAudio, toPTT, toVideo,
  resolve, works, version,
};
