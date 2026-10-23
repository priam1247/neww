'use strict';

/**
 * ZaFar Bot — N_m3u8DL-RE High-Speed Parallel HLS/DASH Downloader
 *
 * Manages the standalone `N_m3u8DL-RE` NativeAOT binary in `./bin/` (no root,
 * no Docker, no system package manager required) and executes multi-threaded
 * HLS/DASH segment downloads muxed straight into MP4 via the bot's verified
 * `ffmpeg` binary.
 *
 * Key guarantees:
 *   • Isolated per-job temp directory (`.nm3u8_<id>/`) inside the destination
 *     folder so concurrent `.movie`/`.series` jobs never collide and `SafeDeleteDir`
 *     inside N_m3u8DL-RE can never touch shared folders.
 *   • Exact colon-free `--drop-video` resolution filter so `maxHeight` (e.g.
 *     480p / 720p) is honoured on master playlists without breaking single-stream
 *     media playlists whose `RESOLUTION` attribute is omitted, with automatic
 *     `-sv worst` retry if every variant exceeds `maxHeight`.
 *   • `--no-log --write-meta-json false --no-config --vod-select-parts false`
 *     so non-interactive runs never block on stdin or clutter the repo with `Logs/`.
 *   • Real-time byte tracking across the per-job workspace to feed `onProgress`,
 *     enforce `maxBytes` (`TOO_BIG`), and kill stalled transfers (`stallMs`).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const { spawn, execFileSync } = require('child_process');
const axios = require('axios');
const config = require('../config');
const getFfmpeg = require('./ffmpeg');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BIN_NAME = process.platform === 'win32' ? 'N_m3u8DL-RE.exe' : 'N_m3u8DL-RE';
const REPO_ROOT = path.resolve(__dirname, '..');

const RELEASE_API_URL = 'https://api.github.com/repos/nilaoda/N_m3u8DL-RE/releases/latest';
const PINNED_VERSION = 'v0.6.0-beta';
const PINNED_DATE = '20260629';

let _resolvedBin; // undefined = not probed, null = absent, string = runnable path
let _version = null;
let _installError = null;
let _ensurePromise = null;

function isMockTestEnv() {
  return Boolean(process.env.FAKE_YTDLP || process.env.NM3U8DL_OFFLINE_TEST === '1');
}

function localBinPath() {
  return path.join(process.cwd(), 'bin', BIN_NAME);
}

function repoBinPath() {
  return path.join(REPO_ROOT, 'bin', BIN_NAME);
}

function candidatePaths() {
  const list = [];
  if (process.env.NM3U8DL_BIN) list.push(path.resolve(process.env.NM3U8DL_BIN));
  list.push(localBinPath());
  if (!isMockTestEnv()) {
    const rb = repoBinPath();
    if (!list.includes(rb)) list.push(rb);
    list.push(path.join(os.homedir(), '.local', 'bin', BIN_NAME));
    list.push(BIN_NAME);
    list.push(`/usr/local/bin/${BIN_NAME}`);
    list.push(`/usr/bin/${BIN_NAME}`);
  }
  return list;
}

function ensureExecPermission(filePath) {
  if (process.platform === 'win32') return;
  try {
    if (path.isAbsolute(filePath) && fs.existsSync(filePath)) {
      const mode = fs.statSync(filePath).mode & 0o777;
      if ((mode & 0o111) === 0) fs.chmodSync(filePath, 0o755);
    }
  } catch { /* read-only fs */ }
}

function probeBinary(binPath) {
  if (!binPath) return null;
  if (path.isAbsolute(binPath) && !fs.existsSync(binPath)) return null;
  ensureExecPermission(binPath);
  try {
    const out = execFileSync(binPath, ['--version'], {
      timeout: 8000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' },
    });
    const text = String(out || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
    return text.trim() || 'ready';
  } catch {
    return null;
  }
}

function resolveBinary({ force = false } = {}) {
  if (process.env.NM3U8DL_DISABLED === '1') return null;
  if (!force && _resolvedBin !== undefined) return _resolvedBin;
  _resolvedBin = null;
  _version = null;
  for (const cand of candidatePaths()) {
    const ver = probeBinary(cand);
    if (ver) {
      _resolvedBin = cand;
      _version = ver;
      break;
    }
  }
  return _resolvedBin;
}

function version() {
  if (_resolvedBin === undefined) resolveBinary();
  return _version;
}

function isAvailable() {
  return Boolean(resolveBinary());
}

function installError() {
  return _installError;
}

function threadCount() {
  const raw = Number(process.env.NM3U8DL_THREADS || config.movies?.hlsThreads || 16);
  if (!Number.isFinite(raw)) return 16;
  return Math.max(1, Math.min(32, Math.floor(raw)));
}

function retryCount() {
  const raw = Number(process.env.NM3U8DL_RETRIES || config.movies?.hlsRetries || 10);
  if (!Number.isFinite(raw)) return 10;
  return Math.max(1, Math.min(20, Math.floor(raw)));
}

/**
 * Map current OS/CPU to upstream N_m3u8DL-RE release tar.gz asset slug.
 * Returns null on unsupported platforms (e.g. non-tar.gz Windows builds).
 */
function platformAssetSlug(platform = process.platform, arch = process.arch) {
  if (platform === 'linux') {
    if (arch === 'x64') return 'linux-x64';
    if (arch === 'arm64') return 'linux-arm64';
  }
  if (platform === 'darwin') {
    if (arch === 'arm64') return 'osx-arm64';
    if (arch === 'x64') return 'osx-x64';
  }
  return null;
}

/**
 * Pure Node.js `.tar.gz` single-binary extractor (POSIX ustar 512-byte blocks).
 * Avoids relying on system `tar` inside minimal container images.
 */
function extractBinaryFromTarGz(gzBuffer, targetNames = ['N_m3u8DL-RE', 'N_m3u8DL-RE.exe']) {
  const tarBuf = zlib.gunzipSync(gzBuffer);
  const wanted = new Set(targetNames.map((n) => n.toLowerCase()));
  let offset = 0;

  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512);
    // Two consecutive zero blocks mark end-of-archive
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) { allZero = false; break; }
    }
    if (allZero) break;

    const readStr = (start, len) => {
      const slice = header.subarray(start, start + len);
      const nul = slice.indexOf(0);
      return slice.subarray(0, nul === -1 ? len : nul).toString('utf8').trim();
    };

    const name = readStr(0, 100);
    const prefix = readStr(345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const typeFlag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);

    // Size is stored in octal ASCII at bytes 124..136 (or base-256 if high bit set)
    let size = 0;
    if ((header[124] & 0x80) !== 0) {
      for (let i = 125; i < 136; i++) size = size * 256 + header[i];
    } else {
      const sizeOctal = readStr(124, 12);
      size = sizeOctal ? parseInt(sizeOctal, 8) || 0 : 0;
    }

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tarBuf.length) {
      throw new Error('corrupt tar archive (entry exceeds buffer)');
    }

    const base = path.posix.basename(fullName.replace(/\\/g, '/')).toLowerCase();
    if ((typeFlag === '0' || typeFlag === '') && wanted.has(base) && size > 0) {
      return Buffer.from(tarBuf.subarray(dataStart, dataEnd));
    }

    const blocks = Math.ceil(size / 512);
    offset = dataStart + blocks * 512;
  }

  throw new Error(`binary (${targetNames.join('/')}) not found in tar.gz archive`);
}

async function fetchBufferWithTlsFallback(url, maxBytes = 60 * 1024 * 1024) {
  const attempt = async (insecure) => {
    const isHttps = /^https:/i.test(url);
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 120000,
      maxRedirects: 10,
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
      httpsAgent: isHttps ? new https.Agent({ keepAlive: false, rejectUnauthorized: !insecure }) : undefined,
      headers: { 'User-Agent': UA, Accept: '*/*' },
    });
    return Buffer.from(res.data);
  };

  try {
    return await attempt(false);
  } catch (e) {
    if (!/certificate|self.signed|unable to verify|CERT_|SSL/i.test(String(e.message))) throw e;
    return attempt(true);
  }
}

async function resolveDownloadUrl(slug, releaseApiUrl = RELEASE_API_URL) {
  try {
    const raw = await fetchBufferWithTlsFallback(releaseApiUrl, 2 * 1024 * 1024);
    const json = JSON.parse(raw.toString('utf8'));
    const assets = Array.isArray(json?.assets) ? json.assets : [];
    // Prefer exact `_${slug}_` tar.gz (not android-bionic)
    const match = assets.find((a) => {
      const n = String(a?.name || '');
      return n.includes(`_${slug}_`) && n.endsWith('.tar.gz') && !n.includes('bionic');
    });
    if (match?.browser_download_url) return match.browser_download_url;
  } catch { /* fall back to pinned release URL */ }

  return `https://github.com/nilaoda/N_m3u8DL-RE/releases/download/${PINNED_VERSION}/N_m3u8DL-RE_${PINNED_VERSION}_${slug}_${PINNED_DATE}.tar.gz`;
}

/**
 * Ensure `N_m3u8DL-RE` is present and runnable, downloading the standalone
 * NativeAOT release into `./bin/N_m3u8DL-RE` once if absent.
 */
async function ensureInstalled(opts = {}) {
  if (process.env.NM3U8DL_DISABLED === '1') return null;
  const existing = resolveBinary();
  if (existing && !opts.forceDownload) return existing;

  // Never touch the network during offline selftests unless an explicit test URL is supplied
  if (isMockTestEnv() && !opts.downloadUrl && !opts.releaseApiUrl) {
    return null;
  }

  if (_ensurePromise && !opts.downloadUrl && !opts.releaseApiUrl) return _ensurePromise;

  const task = (async () => {
    _installError = null;
    const slug = opts.slug || platformAssetSlug();
    if (!slug) {
      _installError = `unsupported platform/arch (${process.platform}/${process.arch})`;
      return null;
    }

    const targetPath = opts.destPath || (isMockTestEnv() ? localBinPath() : repoBinPath());
    const binDir = path.dirname(targetPath);
    const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;

    try {
      fs.mkdirSync(binDir, { recursive: true });
      const url = opts.downloadUrl || await resolveDownloadUrl(slug, opts.releaseApiUrl);
      const gzBuf = await fetchBufferWithTlsFallback(url);
      const binBuf = extractBinaryFromTarGz(gzBuf);
      fs.writeFileSync(tmpPath, binBuf, { mode: 0o755 });
      fs.chmodSync(tmpPath, 0o755);
      fs.renameSync(tmpPath, targetPath);

      const ver = probeBinary(targetPath);
      if (!ver) {
        try { fs.unlinkSync(targetPath); } catch { /* ignore */ }
        throw new Error('downloaded N_m3u8DL-RE binary failed --version check');
      }
      _resolvedBin = targetPath;
      _version = ver;
      return targetPath;
    } catch (e) {
      try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
      _installError = e.message;
      return resolveBinary({ force: true });
    }
  })();

  if (!opts.downloadUrl && !opts.releaseApiUrl) {
    _ensurePromise = task.finally(() => { _ensurePromise = null; });
    return _ensurePromise;
  }
  return task;
}

/**
 * Build a colon-free regex matching `x<H>$` for every integer height H > cutoff.
 * Must NOT contain `:` (so no `(?:...)`) because N_m3u8DL-RE's ComplexParamParser
 * splits `key=val:key2=val2` on unescaped colons.
 */
function buildAboveHeightRegex(maxHeight, slack = 60) {
  const h = Math.floor(Number(maxHeight) || 0);
  if (h <= 0) return '';
  const cutoff = Math.max(1, h + Math.max(0, Math.floor(Number(slack) || 0)));
  const digits = String(cutoff).split('').map(Number);
  const k = digits.length;
  const branches = [];

  // Same-digit-count numbers strictly greater than cutoff
  for (let i = 0; i < k; i++) {
    const d = digits[i];
    if (d >= 9) continue;
    const prefix = digits.slice(0, i).join('');
    const nextRange = d + 1 === 9 ? '9' : `[${d + 1}-9]`;
    const rem = k - 1 - i;
    const tail = rem === 0 ? '' : rem === 1 ? '\\d' : `\\d{${rem}}`;
    branches.push(`${prefix}${nextRange}${tail}`);
  }

  // Strictly more digits than cutoff (e.g. >= 1000 when cutoff is 780)
  branches.push(`[1-9]\\d{${k},}`);
  return `x(${branches.join('|')})$`;
}

function sanitizeHeaderLine(key, val) {
  const k = String(key || '').replace(/[\r\n:]/g, '').trim();
  const v = String(val ?? '').replace(/[\r\n]/g, '').trim();
  if (!k || !v) return null;
  return `${k}: ${v}`;
}

const _flagsCache = new Map();

function supportedFlags(bin) {
  const b = bin || resolveBinary();
  if (!b) return new Set();
  let cacheKey = b;
  try {
    const st = fs.statSync(b);
    cacheKey = `${b}:${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch { /* ignore */ }
  if (_flagsCache.has(cacheKey)) return _flagsCache.get(cacheKey);

  const flags = new Set();
  try {
    const res = spawnSync(b, ['--help'], {
      encoding: 'utf8',
      timeout: 8_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const out = `${res.stdout || ''}\n${res.stderr || ''}`;
    const matches = out.match(/--[a-z0-9][a-z0-9-]*/gi) || [];
    for (const m of matches) flags.add(m.toLowerCase());
  } catch { /* ignore */ }
  if (flags.size > 0) _flagsCache.set(cacheKey, flags);
  return flags;
}

function buildArgs(url, {
  bin,
  workTmpDir,
  workOutDir,
  saveName = 'media',
  ffmpegPath,
  headers = {},
  maxHeight = 0,
  threads = threadCount(),
  retries = retryCount(),
  requestTimeoutSec = 35,
  fallbackWorst = false,
  keys = [],
  proxy = '',
} = {}) {
  const flags = supportedFlags(bin);
  const args = [
    url,
    '--tmp-dir', workTmpDir,
    '--save-dir', workOutDir,
    '--save-name', saveName,
    '--thread-count', String(Math.max(1, Math.min(32, Number(threads) || 16))),
    '--download-retry-count', String(Math.max(1, Math.min(20, Number(retries) || 10))),
    '--http-request-timeout', String(Math.max(10, Number(requestTimeoutSec) || 35)),
    '-mt',
    '--del-after-done',
    '--no-log',
    '--write-meta-json', 'false',
    '--disable-update-check',
    '--no-ansi-color',
    '--ui-language', 'en-US',
  ];
  if (flags.has('--no-config')) {
    args.push('--no-config');
  }
  if (flags.has('--vod-select-parts')) {
    args.push('--vod-select-parts', 'false');
  }

  if (ffmpegPath) {
    args.push('--ffmpeg-binary-path', ffmpegPath);
    args.push('-M', 'format=mp4:muxer=ffmpeg:skip_sub=true');
  }

  if (fallbackWorst) {
    args.push('-sv', 'worst', '-sa', 'best');
  } else if (Number(maxHeight) > 0) {
    const dropRe = buildAboveHeightRegex(maxHeight);
    if (dropRe) args.push('-dv', `res="${dropRe}":for=all`);
    args.push('-sv', 'best', '-sa', 'best');
  } else {
    args.push('-sv', 'best', '-sa', 'best');
  }

  const mergedHeaders = { 'User-Agent': UA };
  for (const [k, v] of Object.entries(headers || {})) {
    if (/^user-agent$/i.test(k)) delete mergedHeaders['User-Agent'];
    mergedHeaders[k] = v;
  }
  for (const [k, v] of Object.entries(mergedHeaders)) {
    const line = sanitizeHeaderLine(k, v);
    if (line) args.push('-H', line);
  }

  if (proxy) {
    args.push('--custom-proxy', String(proxy));
  }

  if (Array.isArray(keys)) {
    for (const key of keys) {
      const clean = String(key || '').trim();
      if (clean) args.push('--key', clean);
    }
  }

  return args;
}

function dirBytes(dir) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += dirBytes(full);
    else {
      try { total += fs.statSync(full).size; } catch { /* raced with mux cleanup */ }
    }
  }
  return total;
}

function findProducedOutput(outDir) {
  let entries;
  try { entries = fs.readdirSync(outDir, { withFileTypes: true }); } catch { return null; }
  const files = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (/\.MUX\./i.test(e.name) || /\.(part|tmp|json|srt|vtt)$/i.test(e.name)) continue;
    const full = path.join(outDir, e.name);
    try {
      const st = fs.statSync(full);
      if (st.size > 0) files.push({ path: full, name: e.name, size: st.size });
    } catch { /* ignore */ }
  }
  if (!files.length) return null;
  // Prefer .mp4 first, then largest media file
  files.sort((a, b) => {
    const aMp4 = a.name.toLowerCase().endsWith('.mp4') ? 1 : 0;
    const bMp4 = b.name.toLowerCase().endsWith('.mp4') ? 1 : 0;
    if (aMp4 !== bMp4) return bMp4 - aMp4;
    return b.size - a.size;
  });
  return files[0];
}

function runAttempt(bin, args, { workDir, maxBytes = 0, stallMs = 180000, onProgress, onAbort }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' },
    });

    let stdoutTail = '';
    let stderrTail = '';
    let lastActivity = Date.now();
    let peakBytes = 0;
    let settled = false;

    const finishErr = (err) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      err.stdout = stdoutTail;
      err.stderr = stderrTail;
      reject(err);
    };

    const appendLog = (prev, chunk) => {
      const next = prev + chunk.toString('utf8');
      return next.length > 16384 ? next.slice(-16384) : next;
    };

    child.stdout.on('data', (chunk) => {
      lastActivity = Date.now();
      stdoutTail = appendLog(stdoutTail, chunk);
    });

    child.stderr.on('data', (chunk) => {
      lastActivity = Date.now();
      stderrTail = appendLog(stderrTail, chunk);
    });

    const timer = setInterval(() => {
      if (onAbort?.()) {
        return finishErr(Object.assign(new Error('download aborted'), { code: 'ABORTED' }));
      }
      const current = dirBytes(workDir);
      if (current > peakBytes) {
        peakBytes = current;
        lastActivity = Date.now();
        try { onProgress?.(peakBytes, 0); } catch { /* ignore */ }
      }
      if (maxBytes > 0 && current > maxBytes) {
        return finishErr(Object.assign(new Error('HLS stream larger than the cap'), { code: 'TOO_BIG' }));
      }
      if (stallMs > 0 && Date.now() - lastActivity > stallMs) {
        return finishErr(Object.assign(new Error('N_m3u8DL-RE stalled (no data)'), { code: 'STALLED' }));
      }
    }, 1500);
    timer.unref?.();

    child.on('error', (err) => finishErr(err));
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (code === 0) {
        resolve({ stdout: stdoutTail, stderr: stderrTail, peakBytes });
      } else {
        const combined = `${stderrTail}\n${stdoutTail}`.trim();
        const lastLine = combined.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || `exit ${code}`;
        const err = new Error(`N_m3u8DL-RE exited ${code}: ${lastLine}`);
        err.exitCode = code;
        err.stdout = stdoutTail;
        err.stderr = stderrTail;
        reject(err);
      }
    });
  });
}

/**
 * Download an HLS/DASH manifest using `N_m3u8DL-RE` + `ffmpeg` muxing.
 *
 * @param {string} url
 * @param {string} dest
 * @param {object} [opts]
 * @returns {Promise<{file: string, bytes: number, engine: 'nm3u8dl-re'}>}
 */
async function downloadHls(url, dest, opts = {}) {
  if (process.env.NM3U8DL_DISABLED === '1') {
    throw Object.assign(new Error('N_m3u8DL-RE disabled by environment'), { code: 'NM3U8DL_DISABLED' });
  }

  const ffPath = opts.ffmpegPath || (getFfmpeg.works() ? getFfmpeg() : null);
  if (!ffPath) {
    throw Object.assign(new Error('ffmpeg required for N_m3u8DL-RE muxing'), { code: 'FFMPEG_MISSING' });
  }

  const bin = resolveBinary() || (opts.autoInstall !== false ? await ensureInstalled() : null);
  if (!bin) {
    throw Object.assign(new Error('N_m3u8DL-RE binary unavailable'), { code: 'NO_NM3U8DL' });
  }

  const destDir = path.dirname(path.resolve(dest));
  fs.mkdirSync(destDir, { recursive: true });

  const jobId = `.nm3u8_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const workDir = path.join(destDir, jobId);
  const workTmpDir = path.join(workDir, 'tmp');
  const workOutDir = path.join(workDir, 'out');
  fs.mkdirSync(workTmpDir, { recursive: true });
  fs.mkdirSync(workOutDir, { recursive: true });

  const runOpts = {
    workDir,
    maxBytes: Number(opts.maxBytes) || 0,
    stallMs: Number(opts.stallMs) || 180000,
    onProgress: opts.onProgress,
    onAbort: opts.onAbort,
  };

  try {
    const primaryArgs = buildArgs(url, {
      bin,
      workTmpDir,
      workOutDir,
      saveName: 'media',
      ffmpegPath: ffPath,
      headers: opts.headers,
      maxHeight: opts.maxHeight,
      threads: opts.threads,
      retries: opts.retries,
      requestTimeoutSec: opts.requestTimeoutSec,
      keys: opts.keys,
      proxy: opts.proxy,
    });

    try {
      await runAttempt(bin, primaryArgs, runOpts);
    } catch (err) {
      if (err.code === 'TOO_BIG' || err.code === 'ABORTED') throw err;

      // If `--drop-video` filtered out every variant because all variants exceed
      // `maxHeight` (e.g. a 1080p-only playlist when 480p was requested), retry
      // once picking the lowest available variant (`-sv worst`), matching chooseVariant().
      const outText = `${err.stdout || ''}\n${err.stderr || ''}\n${err.message || ''}`;
      if (Number(opts.maxHeight) > 0 && /no streams to download|nothing to download/i.test(outText)) {
        fs.rmSync(workTmpDir, { recursive: true, force: true });
        fs.rmSync(workOutDir, { recursive: true, force: true });
        fs.mkdirSync(workTmpDir, { recursive: true });
        fs.mkdirSync(workOutDir, { recursive: true });

        const worstArgs = buildArgs(url, {
          bin,
          workTmpDir,
          workOutDir,
          saveName: 'media',
          ffmpegPath: ffPath,
          headers: opts.headers,
          threads: opts.threads,
          retries: opts.retries,
          requestTimeoutSec: opts.requestTimeoutSec,
          fallbackWorst: true,
          keys: opts.keys,
          proxy: opts.proxy,
        });
        await runAttempt(bin, worstArgs, runOpts);
      } else {
        throw err;
      }
    }

    const produced = findProducedOutput(workOutDir);
    if (!produced || produced.size < 10 * 1024) {
      throw new Error('N_m3u8DL-RE produced no valid output media');
    }
    if (runOpts.maxBytes > 0 && produced.size > runOpts.maxBytes) {
      throw Object.assign(new Error('HLS stream larger than the cap'), { code: 'TOO_BIG' });
    }

    const prodExt = path.extname(produced.name).toLowerCase() || '.mp4';
    const finalDest = dest.toLowerCase().endsWith(prodExt)
      ? dest
      : dest.replace(/\.(mp4|mkv|ts|m4v)$/i, '') + prodExt;

    try { fs.rmSync(finalDest, { force: true }); } catch { /* ignore */ }
    fs.renameSync(produced.path, finalDest);

    const bytes = fs.statSync(finalDest).size;
    try { opts.onProgress?.(bytes, bytes); } catch { /* ignore */ }
    return { file: finalDest, bytes, engine: 'nm3u8dl-re' };
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function diagnostics() {
  const bin = resolveBinary();
  return {
    available: Boolean(bin),
    path: bin || null,
    version: _version,
    threads: threadCount(),
    retries: retryCount(),
    installError: _installError,
  };
}

function _resetForTests() {
  _resolvedBin = undefined;
  _version = null;
  _installError = null;
  _ensurePromise = null;
  _flagsCache.clear();
}

module.exports = {
  resolveBinary,
  probeBinary,
  version,
  isAvailable,
  installError,
  threadCount,
  retryCount,
  platformAssetSlug,
  extractBinaryFromTarGz,
  ensureInstalled,
  supportedFlags,
  buildAboveHeightRegex,
  buildArgs,
  downloadHls,
  diagnostics,
  _resetForTests,
};
