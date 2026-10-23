/**
 * ZaFar Bot — remote link storage for oversized files
 *
 * WhatsApp caps a document at ~2 GB and long uploads are fragile, so anything
 * bigger than INLINE_LIMIT (default 100 MB) can go to an rclone remote and be
 * delivered as a share link instead. Small files keep using the normal
 * inline sender (utils/mediaTransfer.js).
 *
 *   put(file, size)  -> null            file fits inline, caller sends it
 *                    -> 'https://…'     uploaded, caller sends the link
 *
 * Configuration (.env / panel variables)
 *   INLINE_LIMIT     bytes that still go inline        (default 104857600)
 *   RCLONE_REMOTE    remote name from rclone.conf      (required for uploads)
 *   RCLONE_PATH      folder inside that remote         (optional)
 *   RCLONE_CONFIG    config file                       (default secrets/rclone.conf)
 *   RCLONE_BIN       binary                            (default ~/.anon/bin/rclone, then $PATH)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const log = require('./logger')('rclone');

const BOT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_INLINE_LIMIT = 100 * 1024 * 1024;   // 100 MB
const COPY_TIMEOUT_MS = 60 * 60 * 1000;           // an hour for a large upload
const LINK_TIMEOUT_MS = 60 * 1000;

const inlineLimit = () => {
  const n = Number(process.env.INLINE_LIMIT);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_INLINE_LIMIT;
};

const remote = () => String(process.env.RCLONE_REMOTE || '').trim();
const remotePath = () => String(process.env.RCLONE_PATH || '').trim().replace(/^\/+|\/+$/g, '');
const configFile = () => path.resolve(process.env.RCLONE_CONFIG || path.join(BOT_ROOT, 'secrets', 'rclone.conf'));

const isExecutable = (file) => {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
};

/** First executable named `name` on $PATH. */
function onPath(name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** RCLONE_BIN, then the userspace toolchain, then $PATH. */
function resolveBin() {
  const explicit = String(process.env.RCLONE_BIN || '').trim();
  if (explicit) {
    if (!isExecutable(explicit)) throw new Error(`RCLONE_BIN is not executable: ${explicit}`);
    return explicit;
  }
  const home = process.env.HOME || '';
  const candidates = [
    home && path.join(home, '.anon', 'bin', 'rclone'),
    path.join(BOT_ROOT, 'bin', 'rclone'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }
  const found = onPath('rclone');
  if (found) return found;
  throw new Error('rclone binary not found (set RCLONE_BIN or install to ~/.anon/bin/rclone)');
}

/** Describe the current setup without uploading anything. */
function available() {
  const cfg = configFile();
  const out = {
    binary: null,
    config: cfg,
    configExists: fs.existsSync(cfg),
    remote: remote(),
    path: remotePath(),
    inlineLimit: inlineLimit(),
    reason: null,
  };
  try { out.binary = resolveBin(); } catch (e) { out.reason = e.message; }
  if (!out.configExists) out.reason = `missing ${path.relative(BOT_ROOT, cfg) || cfg}`;
  else if (!out.remote) out.reason = 'missing RCLONE_REMOTE';
  return out;
}

const redact = (s) => String(s || '').replace(/(token|secret|pass(?:word)?)\s*=\s*\S+/gi, '$1=***');

function run(args, timeout) {
  const bin = resolveBin();
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') {
          return reject(new Error('rclone binary not found (set RCLONE_BIN or install to ~/.anon/bin/rclone)'));
        }
        const tail = String(stderr || err.message || '').trim().split('\n').slice(-3).join(' | ');
        return reject(new Error(`rclone ${args[0]} failed: ${redact(tail)}`));
      }
      return resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/**
 * Upload `filePath` when it does not fit inline.
 *
 * @param {string} filePath
 * @param {number} [size] bytes (stat() is used when omitted)
 * @returns {Promise<string|null>} share link, or null when the file is inline-sized
 */
async function put(filePath, size) {
  if (!filePath) throw new TypeError('rcloneStore.put: filePath is required');

  const bytes = Number.isFinite(Number(size)) ? Number(size) : fs.statSync(filePath).size;
  if (bytes <= inlineLimit()) return null;

  const cfg = configFile();
  if (!fs.existsSync(cfg)) {
    throw Object.assign(
      new Error(`missing ${path.relative(BOT_ROOT, cfg) || cfg} (required for files over ${(inlineLimit() / 1024 / 1024).toFixed(0)} MB)`),
      { code: 'RCLONE_CONFIG_MISSING' },
    );
  }

  const name = remote();
  if (!name) {
    throw Object.assign(new Error('missing RCLONE_REMOTE (e.g. RCLONE_REMOTE=gdrive)'), { code: 'RCLONE_REMOTE_MISSING' });
  }

  const dir = remotePath();
  const base = path.basename(filePath);
  const destination = `${name}:${dir ? `${dir}/` : ''}`;

  log.info(`uploading ${base} (${(bytes / 1024 / 1024).toFixed(1)} MB) to ${destination}`);
  await run(['copy', filePath, destination, '--config', cfg], COPY_TIMEOUT_MS);

  const remoteFile = `${name}:${dir ? `${dir}/` : ''}${base}`;
  const { stdout } = await run(['link', remoteFile, '--config', cfg], LINK_TIMEOUT_MS);
  const link = String(stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//i.test(line))
    .pop();

  if (!link) throw new Error('rclone link returned no URL');
  log.info(`uploaded ${base} -> ${link}`);
  return link;
}

module.exports = {
  put,
  available,
  inlineLimit,
  configFile,
  remote,
  remotePath,
  resolveBin,
  DEFAULT_INLINE_LIMIT,
};
