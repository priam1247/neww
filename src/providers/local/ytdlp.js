// src/providers/local/ytdlp.js — merged from Zafar-bot-main: the full yt-dlp
// engine (ESM port, zero deps). Responsibilities:
//   • finds (or auto-installs) a runnable yt-dlp binary
//   • probes which options the installed build actually supports
//   • escalates through YouTube player-client profiles under a global deadline
//   • cookies (Netscape / base64 / JSON export) + runtime proxy
//   • classifies the real failure and returns honest, actionable messages
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import config from '../../config.js';
import { log } from '../../core/log.js';
import { store } from '../../core/store.js';
import ffmpeg from '../../utils/ffmpeg.js';
import { jobDir, sweepJobs } from '../../media/transfer.js';

const ylog = log.child('ytdlp');
const execFileAsync = promisify(execFileCb);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ─── URL / ID HELPERS ────────────────────────────────────────────────────────
const YT_HOST_RE = /(?:youtube\.com|youtu\.be|youtube-nocookie\.com|music\.youtube\.com)/i;
const YT_ID_RE = /(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|live\/|embed\/|clip\/|v\/)|youtu\.be\/|music\.youtube\.com\/watch\?(?:[^#\s]*&)?v=)([A-Za-z0-9_-]{11})/i;

export const isYouTubeUrl = (text) => YT_HOST_RE.test(String(text || ''));

export const extractVideoId = (text) => {
  const m = String(text || '').match(YT_ID_RE);
  return m ? m[1] : null;
};

/** Pull the first http(s) URL out of a text blob. */
export const extractUrl = (text) => {
  const m = String(text || '').match(/https?:\/\/[^\s"'<>]+/);
  return m ? m[0].replace(/[),.;]+$/, '') : null;
};

export const normalizeYouTubeUrl = (text) => {
  const id = extractVideoId(text);
  if (id) return `https://www.youtube.com/watch?v=${id}`;
  return extractUrl(text) || String(text || '').trim();
};

// ─── BINARY RESOLUTION ───────────────────────────────────────────────────────
const BIN_DIR = path.join(process.cwd(), 'bin');
const LOCAL_BIN = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const USER_BIN = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

let _cmd;   // undefined = not probed, null = absent, [bin, ...prefix] = usable

const candidates = () => [
  [LOCAL_BIN], [USER_BIN], ['yt-dlp'],
  ['/usr/local/bin/yt-dlp'], ['/usr/bin/yt-dlp'],
  ['python3', '-m', 'yt_dlp'], ['python', '-m', 'yt_dlp'],
];

function probeCommand(cmd) {
  try {
    const out = execFileSync(cmd[0], [...cmd.slice(1), '--version'], {
      timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return String(out || '').trim().split('\n').pop().trim() || null;
  } catch { return null; }
}

/** @returns {string[]|null} argv prefix for yt-dlp, or null when absent. */
export function resolveCommand({ force = false } = {}) {
  if (!force && _cmd !== undefined) return _cmd;
  _cmd = null;
  for (const cmd of candidates()) if (probeCommand(cmd)) { _cmd = cmd; break; }
  return _cmd;
}

export const version = () => {
  const cmd = resolveCommand();
  return cmd ? probeCommand(cmd) : null;
};

let _installError = null;
export const installError = () => _installError;

async function fetchBinary(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: '*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await fs.promises.writeFile(LOCAL_BIN, Buffer.from(await res.arrayBuffer()));
}

// Download the official standalone build (works without pip / root).
async function downloadStandaloneBinary() {
  const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
  fs.mkdirSync(BIN_DIR, { recursive: true });
  await fetchBinary(url);
  fs.chmodSync(LOCAL_BIN, 0o755);
  if (!probeCommand([LOCAL_BIN])) throw new Error('downloaded yt-dlp is not runnable (python3 missing on this host?)');
  return LOCAL_BIN;
}

async function pipInstall() {
  const pipCmds = [
    ['python3', '-m', 'pip', 'install', '--user', '-q', '--break-system-packages', '--upgrade', 'yt-dlp'],
    ['python3', '-m', 'pip', 'install', '--user', '-q', '--upgrade', 'yt-dlp'],
    ['pip3', 'install', '--user', '-q', '--break-system-packages', '--upgrade', 'yt-dlp'],
    ['pip', 'install', '-q', '--upgrade', 'yt-dlp'],
  ];
  for (const cmd of pipCmds) {
    try {
      await execFileAsync(cmd[0], cmd.slice(1), { timeout: 180_000 });
      if (resolveCommand({ force: true })) return true;
    } catch { /* try the next pip flavour */ }
  }
  return false;
}

let _ensurePromise = null;

/** Make sure yt-dlp exists; installs once (standalone → pip) when absent. */
export async function ensureInstalled() {
  if (resolveCommand()) return resolveCommand();
  if (_ensurePromise) return _ensurePromise;
  _ensurePromise = (async () => {
    _installError = null;
    try { await downloadStandaloneBinary(); ylog.info(`installed standalone binary at ${LOCAL_BIN}`); }
    catch (e) { _installError = `binary download: ${e.message}`; ylog.warn('binary download failed:', e.message); }
    if (!resolveCommand({ force: true })) {
      try {
        if (await pipInstall()) ylog.info('installed via pip');
        else _installError = `${_installError || ''} | pip install failed`.trim();
      } catch (e) { _installError = e.message; }
    }
    if (resolveCommand({ force: true })) capabilities({ force: true });
    return resolveCommand({ force: true });
  })().finally(() => { _ensurePromise = null; });
  return _ensurePromise;
}

/** Self-update (standalone binary) or pip upgrade. `quick` = binary only. */
export async function update({ quick = false } = {}) {
  const cmd = resolveCommand();
  const isLocal = cmd && cmd[0] === LOCAL_BIN;
  let ok = false;
  if (isLocal) {
    try { await execFileAsync(LOCAL_BIN, ['-U'], { timeout: 180_000 }); ok = Boolean(resolveCommand({ force: true })); }
    catch (e) { ylog.warn('self-update failed:', String(e.message).split('\n')[0]); }
  }
  if (!ok && !quick) ok = await pipInstall();
  if (!ok && !cmd && !quick) await ensureInstalled();
  capabilities({ force: true });
  return version();
}

// ─── CAPABILITIES ────────────────────────────────────────────────────────────
let _caps = null;

export function capabilities({ force = false } = {}) {
  if (_caps && !force) return _caps;
  const caps = {
    version: null, flags: new Set(),
    jsRuntimes: false, remoteComponents: false,
    impersonate: false, impersonateBroken: false,
    matchFilter: null, forceIpv4: false, noCheckCertificates: false,
    extractorRetries: false, noCheckFormats: false, concurrentFragments: false,
    maxFilesize: false, newline: false, progressTemplate: false,
  };
  const cmd = resolveCommand();
  if (!cmd) { _caps = caps; return caps; }
  caps.version = probeCommand(cmd);
  let help = '';
  try {
    help = String(execFileSync(cmd[0], [...cmd.slice(1), '--help'], {
      timeout: 20_000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    }) || '');
  } catch { /* ancient build: keep conservative defaults */ }
  for (const m of help.matchAll(/--([a-z0-9][a-z0-9-]+)/g)) caps.flags.add(m[1]);
  const has = (n) => caps.flags.has(n) || caps.flags.has(`${n}s`);
  caps.jsRuntimes = caps.flags.has('js-runtimes');
  caps.remoteComponents = caps.flags.has('remote-components');
  caps.impersonate = caps.flags.has('impersonate');
  caps.matchFilter = has('match-filter') ? '--match-filter' : null;
  caps.forceIpv4 = caps.flags.has('force-ipv4');
  caps.noCheckCertificates = caps.flags.has('no-check-certificates');
  caps.extractorRetries = caps.flags.has('extractor-retries');
  caps.noCheckFormats = caps.flags.has('no-check-formats');
  caps.concurrentFragments = caps.flags.has('concurrent-fragments');
  caps.maxFilesize = caps.flags.has('max-filesize');
  caps.newline = caps.flags.has('newline');
  caps.progressTemplate = caps.flags.has('progress-template');
  _caps = caps;
  return caps;
}

/** Called when a run proves --impersonate unusable (no curl_cffi on host). */
export const disableImpersonation = () => { if (_caps) _caps.impersonateBroken = true; };

// ─── COOKIES ─────────────────────────────────────────────────────────────────
export const COOKIE_STORE = path.join(process.cwd(), config.dataDir, 'yt_cookies.txt');

const looksLikeCookieFile = (text) =>
  typeof text === 'string' && (text.includes('\t') || /^#\s*(Netscape|HTTP Cookie File)/im.test(text));

/** Browser-extension JSON export → Netscape cookie text. */
export function jsonCookiesToNetscape(text) {
  let arr;
  try { arr = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(arr) || !arr.length || !arr[0] || typeof arr[0] !== 'object') return null;
  if (!('domain' in arr[0]) || !('name' in arr[0])) return null;
  const lines = ['# Netscape HTTP Cookie File', '# converted from JSON by ZaFarBot', ''];
  const bool = (v) => (v === true || v === 'TRUE' || v === 'True' ? 'TRUE' : 'FALSE');
  for (const c of arr) {
    if (!c || !c.domain || !c.name) continue;
    const domain = String(c.domain);
    const includeSub = c.hostOnly === true ? 'FALSE' : (domain.startsWith('.') ? 'TRUE' : 'FALSE');
    const expires = Number.isFinite(Number(c.expirationDate)) ? Math.floor(Number(c.expirationDate))
      : Number.isFinite(Number(c.expires)) ? Math.floor(Number(c.expires)) : 0;
    lines.push([domain, includeSub, String(c.path || '/'), bool(c.secure),
      String(expires), String(c.name), String(c.value ?? '')].join('\t'));
  }
  return lines.length > 3 ? lines.join('\n') + '\n' : null;
}

/** Netscape text, base64 of it, or a JSON export → Netscape text (or null). */
export function normaliseCookieText(raw) {
  let text = String(raw || '').trim();
  if (!text) return null;
  if (!looksLikeCookieFile(text)) {
    const fromJson = jsonCookiesToNetscape(text);
    if (fromJson) return fromJson;
    try {
      const decoded = Buffer.from(text.replace(/\s+/g, ''), 'base64').toString('utf8');
      if (looksLikeCookieFile(decoded)) text = decoded;
      else {
        const decodedJson = jsonCookiesToNetscape(decoded);
        if (decodedJson) return decodedJson;
      }
    } catch { /* not base64 */ }
  }
  if (!looksLikeCookieFile(text)) return null;
  return text.endsWith('\n') ? text : `${text}\n`;
}

export function setCookies(raw) {
  const text = normaliseCookieText(raw);
  if (!text) throw Object.assign(new Error('That does not look like a cookies.txt (Netscape) file'), { code: 'BAD_COOKIES' });
  fs.mkdirSync(path.dirname(COOKIE_STORE), { recursive: true });
  fs.writeFileSync(COOKIE_STORE, text);
  try { fs.chmodSync(COOKIE_STORE, 0o600); } catch { /* windows */ }
  _cookieInfoCache = null;
  return { file: COOKIE_STORE, count: countCookies(text) };
}

export function clearCookies() {
  let removed = false;
  for (const p of [COOKIE_STORE, path.join(process.cwd(), 'cookies.txt')]) {
    try { if (fs.existsSync(p)) { fs.unlinkSync(p); removed = true; } } catch { /* ignore */ }
  }
  _cookieInfoCache = null;
  return removed;
}

export const countCookies = (text) => String(text || '')
  .split('\n')
  .filter((l) => l.trim() && !l.trim().startsWith('#') && l.split('\t').length >= 6)
  .length;

let _cookieInfoCache = null;

export function cookieInfo() {
  if (_cookieInfoCache) {
    const age = Date.now() - _cookieInfoCache.checkedAt;
    if (_cookieInfoCache.source && age < 30_000) {
      if (!_cookieInfoCache.file || fs.existsSync(_cookieInfoCache.file)) return _cookieInfoCache;
    }
  }
  const sources = [
    { source: 'inline (config/env)', file: null, text: config.youtubeCookies || process.env.YOUTUBE_COOKIES || '' },
    { source: 'managed (.cookies set)', file: COOKIE_STORE, text: null },
    { source: 'config file', file: config.youtubeCookiesFile || process.env.YOUTUBE_COOKIES_FILE || '', text: null },
    { source: 'cookies.txt (bot folder)', file: path.join(process.cwd(), 'cookies.txt'), text: null },
  ];
  for (const c of sources) {
    if (c.text && String(c.text).trim()) {
      const n = normaliseCookieText(c.text);
      if (n) { _cookieInfoCache = { source: c.source, file: null, count: countCookies(n), mtime: null, checkedAt: Date.now() }; return _cookieInfoCache; }
    }
    if (c.file && fs.existsSync(c.file)) {
      let mtime = null, count = 0;
      try { mtime = fs.statSync(c.file).mtimeMs; count = countCookies(fs.readFileSync(c.file, 'utf8')); }
      catch { /* unreadable */ }
      _cookieInfoCache = { source: c.source, file: c.file, count, mtime, checkedAt: Date.now() };
      return _cookieInfoCache;
    }
  }
  _cookieInfoCache = { source: null, file: null, count: 0, mtime: null, checkedAt: Date.now() };
  return _cookieInfoCache;
}

export const hasCookies = () => Boolean(cookieInfo().source);

/** Resolve the cookies flag value for yt-dlp (inline cookies are materialised). */
export function cookieFile() {
  const inline = config.youtubeCookies || process.env.YOUTUBE_COOKIES || '';
  if (String(inline).trim()) {
    const text = normaliseCookieText(inline);
    if (text) {
      try {
        fs.mkdirSync(path.dirname(COOKIE_STORE), { recursive: true });
        if (!fs.existsSync(COOKIE_STORE) || fs.readFileSync(COOKIE_STORE, 'utf8') !== text) {
          fs.writeFileSync(COOKIE_STORE, text);
          try { fs.chmodSync(COOKIE_STORE, 0o600); } catch { /* windows */ }
        }
        return COOKIE_STORE;
      } catch { /* fall through */ }
    }
  }
  return cookieInfo().file || null;
}

// ─── PROXY ───────────────────────────────────────────────────────────────────
export const proxyUrl = () => String(
  store.get('settings', 'proxy', '') || config.ytdlpProxy || process.env.YTDLP_PROXY || ''
).trim() || null;

// ─── ARGUMENT BUILDING ───────────────────────────────────────────────────────
let _minimalBaseArgs = false;
export const setMinimalBaseArgs = (on = true) => { _minimalBaseArgs = Boolean(on); };
export const usingMinimalBaseArgs = () => _minimalBaseArgs;

const PROGRESS_PREFIX = '@@ZFPROG@@';
const PROGRESS_TEMPLATE =
  `${PROGRESS_PREFIX}%(progress.downloaded_bytes)s|%(progress.total_bytes)s|` +
  '%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s';

function baseArgs({ progress = false } = {}) {
  const caps = capabilities();
  const args = ['--no-playlist', '--no-warnings', '--ignore-config', '--retries', '2',
    '--fragment-retries', '2', '--socket-timeout', '20'];
  if (!_minimalBaseArgs) args.push('--no-color', '--user-agent', UA, '--add-header', 'Accept-Language: en-US,en;q=0.9');
  if (caps.extractorRetries) args.push('--extractor-retries', '1');
  if (caps.noCheckCertificates) args.push('--no-check-certificates');
  if (caps.forceIpv4) args.push('--force-ipv4');
  if (caps.jsRuntimes) args.push('--js-runtimes', 'node');
  const cookies = cookieFile();
  if (cookies) args.push('--cookies', cookies);
  const proxy = proxyUrl();
  if (proxy) args.push('--proxy', proxy);
  if (progress && caps.newline && caps.progressTemplate) {
    args.push('--newline', '--progress-template', PROGRESS_TEMPLATE);
  } else {
    args.push('--no-progress');
  }
  return args;
}

/**
 * Escalating attempt profiles. YouTube's per-client rules change constantly;
 * trying several client sets is what actually keeps downloads working.
 */
export function attemptProfiles(url) {
  const caps = capabilities();
  if (!isYouTubeUrl(url)) return [{ name: 'default', args: [] }];
  const list = [{ name: 'default', args: [] }];
  if (caps.impersonate && !caps.impersonateBroken) list.push({ name: 'impersonate', args: ['--impersonate', 'chrome'] });
  list.push({ name: 'tv', args: ['--extractor-args', 'youtube:player_client=tv,web_safari'] });
  list.push({ name: 'android_vr', args: ['--extractor-args', 'youtube:player_client=android_vr,web_embedded'] });
  list.push({ name: 'ios', args: ['--extractor-args', 'youtube:player_client=ios,mweb'] });
  list.push({ name: 'web_safari', args: ['--extractor-args', 'youtube:player_client=web_safari,web'] });
  if (caps.remoteComponents) {
    list.push({ name: 'ejs', args: ['--remote-components', 'ejs:github', '--extractor-args', 'youtube:player_client=default,web_embedded'] });
  }
  list.push({ name: 'missing_pot', args: ['--extractor-args', 'youtube:player_client=default;formats=missing_pot'] });
  return list;
}

// ─── RUNNER ──────────────────────────────────────────────────────────────────
const MAX_CAPTURE = 256 * 1024;

function spawnYtdlp(args, { timeout = 120_000, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const cmd = resolveCommand();
    if (!cmd) return reject(Object.assign(new Error('yt-dlp is not installed'), { code: 'NO_YTDLP' }));
    let child;
    try { child = spawn(cmd[0], [...cmd.slice(1), ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return reject(Object.assign(new Error(`could not start yt-dlp: ${e.message}`), { code: 'NO_YTDLP' })); }

    let stdout = '', stderr = '', settled = false, killedByTimeout = false;
    const timer = timeout > 0 ? setTimeout(() => {
      killedByTimeout = true;
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }, timeout) : null;
    const finish = (fn, v) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); fn(v); };

    const handleLine = (line) => {
      if (!onProgress || !line.startsWith(PROGRESS_PREFIX)) return;
      const [downloaded, total, estimate, speed, eta] = line.slice(PROGRESS_PREFIX.length).split('|');
      const done = Number(downloaded), sz = Number(total) || Number(estimate);
      if (!Number.isFinite(done) || !Number.isFinite(sz) || sz <= 0) return;
      onProgress({ percent: Math.max(0, Math.min(100, Math.round((done / sz) * 100))), speed: Number(speed) || 0, eta: Number(eta) || 0 });
    };

    let outTail = '';
    child.stdout.on('data', (d) => {
      const text = String(d);
      if (stdout.length < MAX_CAPTURE) stdout += text;
      if (onProgress) {
        const lines = (outTail + text).split('\n');
        outTail = lines.pop() || '';
        for (const line of lines) handleLine(line.trim());
      }
    });
    child.stderr.on('data', (d) => {
      const text = String(d);
      if (stderr.length < MAX_CAPTURE) stderr += text;
      if (onProgress) for (const line of text.split('\n')) handleLine(line.trim());
    });
    child.on('error', (e) => finish(reject, Object.assign(new Error(e.message), { code: 'NO_YTDLP' })));
    child.on('close', (code, signal) => {
      if (code === 0) return finish(resolve, { stdout, stderr });
      const err = new Error(killedByTimeout ? 'yt-dlp timed out' : `yt-dlp exited with code ${code}`);
      err.stderr = stderr; err.stdout = stdout; err.exitCode = code; err.signal = signal;
      if (killedByTimeout) err.killed = true;
      finish(reject, err);
    });
  });
}

/** One-shot yt-dlp run (metadata, diagnostics). */
export async function run(args, { timeout = 120_000 } = {}) {
  if (!resolveCommand()) await ensureInstalled();
  return spawnYtdlp(args, { timeout });
}

// ─── ERROR CLASSIFICATION ────────────────────────────────────────────────────
export const RULES = [
  { code: 'RATE_LIMIT', re: /HTTP Error 429|too many requests|rate.?limit/i },
  { code: 'AGE_RESTRICTED', re: /age.?restricted|sign in to confirm your age|inappropriate for some users/i },
  { code: 'BOT_CHECK', re: /not a bot|confirm you'?re not a bot|sign in to confirm|please sign in|use --cookies|login required|this content isn'?t available to bots|cookies for the authentication/i },
  { code: 'GEO_BLOCK', re: /available in your country|available in your location|available in your region|not available in this country|geo.?restrict|blocked in your country|unavailable in your region|has blocked (?:this|it) (?:video|content) in your|not made this video available/i },
  { code: 'PRIVATE', re: /private video|this video is private/i },
  { code: 'MEMBERS_ONLY', re: /members-only|members only|only available to (?:channel )?members|join this channel|channel membership/i },
  { code: 'LIVE_EVENT', re: /live event will begin|premieres in|is currently live|this live event has ended/i },
  { code: 'DRM', re: /drm protected|protected by drm|encrypted media/i },
  { code: 'PO_TOKEN', re: /po.?token|missing pot|requires a po token/i },
  { code: 'UNAVAILABLE', re: /video unavailable|this video is not available|has been removed|no longer available|does not exist|removed by the uploader|account (?:has been )?(?:terminated|suspended)|unavailable video|not available on this app|requested video is not available/i },
  { code: 'TOO_LONG', re: /is longer than|exceeds the duration|duration filter|does not pass (?:the )?filter/i },
  { code: 'TOO_BIG', re: /larger than max-filesize|file is larger than|skipping due to --max-filesize|exceeds (?:the )?max.?filesize/i },
  { code: 'BAD_ARGS', re: /no such option|unrecognized arguments|unrecognised arguments|invalid argument|invalid value for/i },
  { code: 'FFMPEG_MISSING', re: /ffmpeg (?:is )?not (?:installed|found)|ffprobe and ffmpeg not found|postprocessing.*ffmpeg|requested merging of multiple formats|you have requested merging/i },
  { code: 'IMPERSONATE', re: /impersonat\w+ (?:target|request)|curl_cffi|impersonate.*not (?:available|supported)/i },
  { code: 'UNSUPPORTED_URL', re: /unsupported url|no suitable extractor|unknown extractor|is not a valid url|no video formats found for this url/i },
  { code: 'NO_FORMATS', re: /requested format (?:is )?not available|no video formats found|only images are available|no video formats|unable to extract (?:any )?(?:video|data)|no formats? found for|some formats may be missing/i },
  { code: 'NETWORK', re: /unable to download (?:webpage|api page|video data|json)|timed out|timeout|temporary failure|connection (?:refused|reset|aborted)|getaddrinfo|ssl|certificate|EOF occurred|HTTP Error 5\d\d|network is unreachable|remote end closed|tls\/ssl connection has been closed/i },
  { code: 'NO_YTDLP', re: /yt-dlp is not installed|ENOENT|not recognized as an internal or external command/i },
];

const firstErrorLine = (text) => {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const errors = lines.filter(l => /^(ERROR|WARNING):/i.test(l));
  const line = errors.length ? errors[errors.length - 1] : (lines[lines.length - 1] || '');
  return line.replace(/^(ERROR|WARNING):\s*/i, '').slice(0, 300);
};

export function classify(err) {
  const parts = [];
  if (err?.stderr) parts.push(String(err.stderr));
  if (err?.stdout) parts.push(String(err.stdout));
  if (err?.message && !/^Command failed/i.test(String(err.message))) parts.push(String(err.message));
  const text = parts.join('\n');
  if (err && typeof err === 'object' && typeof err.code === 'string'
    && !/^(ERR_|E[A-Z]+$)/.test(err.code) && RULES.some(r => r.code === err.code)) {
    return { code: err.code, detail: firstErrorLine(text), text };
  }
  if (err?.killed) return { code: 'NETWORK', detail: 'download timed out', text };
  for (const rule of RULES) if (rule.re.test(text)) return { code: rule.code, detail: firstErrorLine(text), text };
  return { code: 'UNKNOWN', detail: firstErrorLine(text), text };
}

const RETRY_CODES = new Set(['BOT_CHECK', 'NO_FORMATS', 'UNKNOWN', 'NETWORK', 'AGE_RESTRICTED', 'IMPERSONATE', 'PO_TOKEN']);
export const isRetryable = (code) => RETRY_CODES.has(code);

export const HINTS = {
  NO_YTDLP: '❌ *yt-dlp* is not installed and could not be auto-installed on this host.\nFix: `pip install -U yt-dlp`, or run `.ytdl repair`.',
  BOT_CHECK: '❌ YouTube asked this server to prove it is *not a bot* — the normal wall for hosting IPs, **not** a region block.\nFix: `.cookies set` (add a YouTube cookies.txt) — cures it in ~95% of cases. Or set a proxy: `.ytdl proxy <url>`.',
  AGE_RESTRICTED: '❌ This video is age-restricted, so YouTube wants a signed-in session.\nFix: add cookies with `.cookies set` and try again.',
  GEO_BLOCK: '❌ YouTube really does geo-block this video for the server\'s country (the only failure that is *truly* regional).\nFix: try another video, or set a proxy in that country: `.ytdl proxy <url>`.',
  PRIVATE: '❌ This video is private — only its owner can download it.',
  MEMBERS_ONLY: '❌ This video is members-only (paid channel membership).',
  LIVE_EVENT: '❌ This is a live stream or a not-yet-started premiere. Only normal videos can be downloaded.',
  DRM: '❌ This video is DRM-protected — no downloader can fetch it.',
  PO_TOKEN: '❌ YouTube wants a "PO token" for this video (an anti-bot requirement).\nFix: update yt-dlp (`.ytdl update`) and add cookies (`.cookies set`).',
  UNAVAILABLE: '❌ This video is unavailable — deleted, removed by the uploader, or a dead link.',
  TOO_LONG: '❌ That media is longer than the limit this bot allows.',
  TOO_BIG: '❌ That file is bigger than the size limit set for this bot — try a lower quality (e.g. `.ytv <link> 360`).',
  FFMPEG_MISSING: '❌ *ffmpeg* is missing on this host, so the audio/video cannot be converted.\nFix: `apt install ffmpeg` (Termux: `pkg install ffmpeg`).',
  UNSUPPORTED_URL: '❌ That link is not a media page the downloader understands (or the site is not supported).\nSupported: YouTube, TikTok, Instagram, Facebook, X/Twitter, Reddit, SoundCloud and ~1000 more — paste the link to the *post/video*, not a profile or search page.',
  NO_FORMATS: '❌ YouTube returned no downloadable stream for that video. Try a different quality (e.g. 360p) or another video.',
  IMPERSONATE: '❌ This yt-dlp build cannot impersonate a browser on this host.',
  BAD_ARGS: '❌ The yt-dlp build on this host does not support one of the options the bot used.\nFix: `.ytdl update` (or `.ytdl repair`) to install a current build.',
  RATE_LIMIT: '❌ YouTube is rate-limiting this server (HTTP 429). Wait a few minutes and try again.',
  NETWORK: '❌ The host could not reach the media server (network/DNS/TLS/timeout).\nThis is a problem with the *server\'s internet*, not the video — or set a proxy: `.ytdl proxy <url>`.',
  UNKNOWN: '❌ Download failed. Run `.ytdl` to see what the host reported, then try again.',
};

export function friendlyError(err) {
  const info = classify(err);
  const extra = info?.detail ? `\n_${String(info.detail).slice(0, 160)}_` : '';
  return (HINTS[info.code] || HINTS.UNKNOWN) + extra;
}

export function attemptsSummary(attempts) {
  if (!Array.isArray(attempts) || !attempts.length) return '';
  const lines = attempts.slice(0, 6).map(a => `• ${a.engine}: ${a.code}`);
  return `\n\n*What was tried:*\n${lines.join('\n')}`;
}

// ─── INFO / SEARCH / DOWNLOAD ────────────────────────────────────────────────
let _lastError = null;
export const lastError = () => _lastError;
export const recordFailure = (info) => (_lastError = { code: info.code, detail: info.detail, attempts: info.attempts || [], at: Date.now(), url: info.url || null });

function parseInfoLine(stdout) {
  const line = String(stdout || '').trim().split('\n').pop() || '';
  const [title, duration, uploader, thumbnail, id] = line.split('\t');
  return {
    title: (title || '').trim(), duration: Number(duration) || 0,
    uploader: (uploader || '').trim(), thumbnail: (thumbnail || '').trim(), id: (id || '').trim(),
  };
}

const INFO_PRINT = '%(title)s\t%(duration)s\t%(uploader)s\t%(thumbnail)s\t%(id)s';

export async function getInfo(url, { timeout = 60_000 } = {}) {
  const caps = capabilities();
  const args = [...baseArgs(), '--skip-download'];
  if (caps.noCheckFormats) args.push('--no-check-formats');
  args.push('--print', INFO_PRINT, url);
  try {
    const { stdout } = await run(args, { timeout });
    return parseInfoLine(stdout);
  } catch (err) {
    // metadata is often the first thing a bot-check kills — escalate before giving up
    let last = err;
    for (const profile of attemptProfiles(url).slice(1, 4)) {
      try {
        const { stdout } = await run([...baseArgs(), ...profile.args, '--skip-download', '--print', INFO_PRINT, url], { timeout });
        return parseInfoLine(stdout);
      } catch (e) { last = e; }
    }
    throw last;
  }
}

/** Raw probe for diagnostics (`.ytdl raw <link>`). */
export async function probeRaw(url, { timeout = 60_000, client = null } = {}) {
  const args = [...baseArgs(), '--skip-download', '--simulate', '--verbose'];
  if (client) args.push('--extractor-args', `youtube:player_client=${client}`);
  args.push(url);
  try {
    const { stdout, stderr } = await run(args, { timeout });
    return { ok: true, stdout, stderr };
  } catch (e) {
    return { ok: false, stdout: e.stdout || '', stderr: e.stderr || String(e.message), code: classify(e).code };
  }
}

/** Search YouTube through yt-dlp (API endpoints survive HTML-scraping blocks). */
export async function searchVideos(query, { limit = 5, timeout = 60_000 } = {}) {
  const caps = capabilities();
  const n = Math.max(1, Math.min(20, Number(limit) || 5));
  const args = [
    ...baseArgs().filter(a => a !== '--no-playlist'),
    '--flat-playlist', '--skip-download',
  ];
  if (caps.noCheckFormats) args.push('--no-check-formats');
  args.push('--print', '%(id)s\t%(title)s\t%(duration)s\t%(uploader)s\t%(thumbnail)s', `ytsearch${n}:${query}`);
  const { stdout } = await run(args, { timeout });
  return String(stdout || '').trim().split('\n')
    .map(line => line.split('\t'))
    .filter(parts => parts[0] && parts[0] !== 'NA')
    .map(([id, title, duration, uploader, thumbnail]) => {
      const videoId = id.trim();
      return {
        id: videoId, url: `https://www.youtube.com/watch?v=${videoId}`,
        title: (title || '').trim(), duration: Number(duration) || 0,
        uploader: (uploader || '').trim(),
        thumbnail: /^https?:/i.test(String(thumbnail || '')) ? String(thumbnail).trim() : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      };
    });
}

/** Find the file yt-dlp produced for `outBase` (it picks the extension). */
export function findProduced(outBase) {
  const dir = path.dirname(outBase);
  const base = path.basename(outBase);
  const exts = ['.mp3', '.m4a', '.opus', '.ogg', '.webm', '.aac', '.wav', '.flac', '.mp4', '.mkv', '.mov', '.3gp', '.m4v'];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  const hit = names.find(f => f.startsWith(base) && exts.includes(path.extname(f).toLowerCase()))
    || names.find(f => f.startsWith(base) && !f.endsWith('.part') && !f.endsWith('.ytdl'));
  return hit ? path.join(dir, hit) : null;
}

let _autoUpdated = false;

/** Run one download with escalating client profiles under a global deadline. */
export async function runWithProfiles(url, buildArgs, {
  timeout = 12 * 60_000,
  deadlineMs = config.ytdlpDeadlineMs,
  progress = false, onAttempt, onProgress,
} = {}) {
  const startedAt = Date.now();
  const profiles = attemptProfiles(url);
  const attempts = [];
  let lastErr = null, lastCode = 'UNKNOWN';

  for (let i = 0; i < profiles.length; i++) {
    const profile = profiles[i];
    const remaining = deadlineMs - (Date.now() - startedAt);
    if (remaining <= 5000) { ylog.warn(`deadline reached after ${attempts.length} attempt(s)`); break; }
    try {
      const args = [...baseArgs({ progress }), ...profile.args, ...buildArgs(profile)];
      await spawnYtdlp(args, {
        timeout: Math.min(timeout, remaining),
        onProgress: onProgress ? (p) => { try { onProgress(p, profile.name); } catch { /* ignore */ } } : undefined,
      });
      return { profile: profile.name, attempts };
    } catch (err) {
      const info = classify(err);
      lastErr = err; lastCode = info.code;
      attempts.push({ engine: `yt-dlp:${profile.name}`, code: info.code, detail: info.detail });
      if (onAttempt) onAttempt(profile.name, err, info);
      if (info.code === 'IMPERSONATE' && profile.name === 'impersonate') disableImpersonation();
      if (info.code === 'BAD_ARGS' && !_minimalBaseArgs) {
        ylog.warn('this build rejected an optional option — retrying with minimal arguments');
        setMinimalBaseArgs(true);
        i--; continue;
      }
      if (info.code === 'BOT_CHECK' && !_autoUpdated && config.ytdlpUpdateOnBotCheck) {
        _autoUpdated = true;
        ylog.info('bot-check detected — updating yt-dlp before retrying');
        try { await update({ quick: true }); } catch (e) { ylog.warn('auto-update failed:', e.message); }
      }
      if (!isRetryable(info.code)) break;
    }
  }
  if (lastErr) {
    const info = classify(lastErr);
    const code = info.code === 'UNKNOWN' && lastCode ? lastCode : info.code;
    const wrapped = Object.assign(new Error(info.detail || 'yt-dlp failed'), { code, detail: info.detail, stderr: info.text, attempts });
    recordFailure({ ...info, url, attempts });
    throw wrapped;
  }
  throw Object.assign(new Error('yt-dlp did not run'), { code: 'NO_YTDLP' });
}

/** Best audio-only stream → MP3 when ffmpeg is available. */
export async function downloadAudio(url, { outBase, maxMB = 200, maxSeconds = 0, onAttempt, onProgress, deadlineMs } = {}) {
  const ffmpegWorks = ffmpeg.works();
  const caps = capabilities();
  const base = outBase || path.join(jobDir(), `audio_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
  const durationFilter = maxSeconds > 0 && caps.matchFilter ? [caps.matchFilter, `duration <?${Math.floor(maxSeconds)}`] : [];
  const sizeLimit = caps.maxFilesize ? ['--max-filesize', `${maxMB}M`] : [];

  const convertArgs = () => [
    '-f', 'bestaudio[ext=m4a]/bestaudio/best',
    ...(ffmpegWorks ? ['--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0', '--ffmpeg-location', ffmpeg.resolve()] : []),
    ...durationFilter, ...sizeLimit,
    '-o', `${base}.%(ext)s`, url,
  ];
  try {
    const { profile, attempts } = await runWithProfiles(url, convertArgs, { onAttempt, onProgress, deadlineMs });
    const file = findProduced(base);
    if (!file) throw Object.assign(new Error('yt-dlp produced no audio file'), { code: 'NO_FORMATS' });
    return { file, ext: path.extname(file).slice(1).toLowerCase(), profile, attempts };
  } catch (err) {
    const info = classify(err);
    if (info.code !== 'FFMPEG_MISSING' && info.code !== 'NO_FORMATS') throw err;
    ylog.warn('audio conversion unavailable, downloading the raw audio stream instead');
    const rawArgs = () => [
      '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
      ...durationFilter, ...sizeLimit,
      '-o', `${base}.%(ext)s`, url,
    ];
    const { profile, attempts } = await runWithProfiles(url, rawArgs, { onAttempt, onProgress, deadlineMs });
    const file = findProduced(base);
    if (!file) throw Object.assign(new Error('yt-dlp produced no audio file'), { code: 'NO_FORMATS' });
    return { file, ext: path.extname(file).slice(1).toLowerCase(), profile, attempts };
  }
}

/** Video download (H.264/MP4 preferred) capped by height, size and duration. */
export async function downloadVideo(url, { height = 720, outBase, maxMB = 300, maxSeconds = 3600, onAttempt, onProgress, deadlineMs } = {}) {
  const caps = capabilities();
  const base = outBase || path.join(jobDir(), `video_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
  const h = Number(height) || 720;
  const durationFilter = maxSeconds > 0 && caps.matchFilter ? [caps.matchFilter, `duration <?${Math.floor(maxSeconds)}`] : [];

  const buildArgs = () => [
    '-f', `bv*[vcodec^=avc1][height<=${h}]+ba[ext=m4a]/b[ext=mp4][height<=${h}]/bv*[height<=${h}]+ba/b[height<=${h}]/b`,
    '--merge-output-format', 'mp4',
    '--ffmpeg-location', ffmpeg.resolve(),
    ...(caps.maxFilesize ? ['--max-filesize', `${maxMB}M`] : []),
    ...durationFilter,
    '-o', `${base}.%(ext)s`, url,
  ];
  const { profile, attempts } = await runWithProfiles(url, buildArgs, { onAttempt, onProgress, deadlineMs });
  const file = findProduced(base);
  if (!file) throw Object.assign(new Error('yt-dlp produced no video file (size or duration limit)'), { code: 'NO_FORMATS' });
  return { file, profile, attempts };
}

// ─── DIAGNOSTICS (.ytdl) ─────────────────────────────────────────────────────
export async function diagnostics() {
  const cmd = resolveCommand();
  let ffVersion = null;
  try {
    const { stdout } = await execFileAsync(ffmpeg.resolve(), ['-version'], { timeout: 8000 });
    ffVersion = String(stdout).split('\n')[0].replace(/^ffmpeg version\s*/i, '').split(' ')[0];
  } catch { /* ffmpeg missing */ }
  const caps = capabilities();
  const ci = cookieInfo();
  return {
    installed: Boolean(cmd),
    source: cmd ? cmd.join(' ') : null,
    version: cmd ? probeCommand(cmd) : null,
    ffmpeg: ffVersion,
    cookies: ci.file || (ci.source || null),
    cookieSource: ci.source,
    cookieCount: ci.count,
    cookieAgeMs: ci.mtime ? Date.now() - ci.mtime : null,
    proxy: proxyUrl(),
    capabilities: {
      version: caps.version,
      impersonate: caps.impersonate && !caps.impersonateBroken,
      jsRuntimes: caps.jsRuntimes,
      matchFilter: caps.matchFilter,
      ipv4: caps.forceIpv4,
    },
    minimalArgs: _minimalBaseArgs,
    installError: _installError,
    lastError: _lastError,
  };
}

// ─── DEFAULT EXPORT (namespace-style for command imports) ────────────────────
import * as ytdlp from './ytdlp.js';
export default ytdlp;
