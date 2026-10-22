/**
 * ZaFar Bot — YouTube engine (shared by .song and .ytv)   v3
 *
 * Why this module exists
 * ----------------------
 * "Blocked in your region" was never a diagnosis: the old build printed it for
 * *every* failure, including the two that actually happen on hosting panels:
 *
 *   1. YouTube asks the host's IP to prove it is not a bot
 *      ("Sign in to confirm you're not a bot") — fixed with cookies/proxy, and
 *   2. YouTube rewrites its player every few weeks, so an old yt-dlp build
 *      stops working — fixed with an update + several player clients.
 *
 * This module does the work properly:
 *   • finds (or auto-installs) a runnable yt-dlp,
 *   • detects which options the *installed* build actually supports, so an old
 *     build never dies with "no such option",
 *   • escalates through several YouTube player clients with a global deadline,
 *   • supports cookies (file / raw / base64 / JSON) and a proxy, changeable at
 *     runtime from WhatsApp (.cookies / .ytdl proxy),
 *   • classifies the real failure and returns an accurate, actionable message.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn, execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const axios = require('axios');
const config = require('../config');
const settings = require('./mediaSettings');
const getFfmpeg = require('./ffmpeg');
const { probeMedia } = require('./mediaTransfer');
const { getTempDir } = require('./tempManager');

const execFileAsync = promisify(execFile);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Where cookies the *bot* manages live. Never inside temp/ — the cleanup timer
// would delete them mid-job (the old build wrote them to temp and they vanished).
const COOKIE_STORE = path.join(process.cwd(), 'database', 'yt_cookies.txt');

// ─── URL / ID HELPERS ─────────────────────────────────────────────────────────

const YT_HOST_RE = /(?:youtube\.com|youtu\.be|youtube-nocookie\.com|music\.youtube\.com)/i;
const YT_ID_RE = /(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|live\/|embed\/|clip\/|v\/)|youtu\.be\/|music\.youtube\.com\/watch\?(?:[^#\s]*&)?v=)([A-Za-z0-9_-]{11})/i;

const isYouTubeUrl = (text) => YT_HOST_RE.test(String(text || ''));

const extractVideoId = (text) => {
  const m = String(text || '').match(YT_ID_RE);
  return m ? m[1] : null;
};

const youtubeId = (url) => extractVideoId(url);

/** Pull the first http(s) URL out of a text blob. */
const extractUrl = (text) => {
  const m = String(text || '').match(/https?:\/\/[^\s"'<>]+/);
  return m ? m[0].replace(/[),.;]+$/, '') : null;
};

/**
 * Any accepted input -> a canonical youtube URL (or the raw URL for other
 * sites). Extra words next to a link ("check this https://youtu.be/x out")
 * are stripped so yt-dlp never sees junk.
 */
const normalizeYouTubeUrl = (text) => {
  const id = extractVideoId(text);
  if (id) return `https://www.youtube.com/watch?v=${id}`;
  return extractUrl(text) || String(text || '').trim();
};

// ─── BINARY RESOLUTION ────────────────────────────────────────────────────────

const BIN_DIR = path.join(process.cwd(), 'bin');
const LOCAL_BIN = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const USER_BIN = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

let _cmd; // undefined = not probed, null = absent, [bin, ...prefixArgs] = usable

const candidates = () => [
  [LOCAL_BIN],
  [USER_BIN],
  ['yt-dlp'],
  ['/usr/local/bin/yt-dlp'],
  ['/usr/bin/yt-dlp'],
  ['python3', '-m', 'yt_dlp'],
  ['python', '-m', 'yt_dlp'],
];

function probeCommand(cmd) {
  try {
    const out = execFileSync(cmd[0], [...cmd.slice(1), '--version'], {
      timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const v = String(out || '').trim().split('\n').pop().trim();
    return v || null;
  } catch {
    return null;
  }
}

/** @returns {string[]|null} argv prefix for yt-dlp, or null when absent. */
function resolveCommand({ force = false } = {}) {
  if (!force && _cmd !== undefined) return _cmd;
  _cmd = null;
  for (const cmd of candidates()) {
    if (probeCommand(cmd)) { _cmd = cmd; break; }
  }
  return _cmd;
}

const version = () => {
  const cmd = resolveCommand();
  return cmd ? probeCommand(cmd) : null;
};

let _installError = null;
const installError = () => _installError;

async function fetchBinary(url, insecure) {
  const res = await axios.get(url, {
    responseType: 'stream', timeout: 180000, maxRedirects: 10,
    // Strict verification first; the fallback exists because many cheap hosts
    // ship an outdated CA bundle ("unable to verify the first certificate").
    httpsAgent: new https.Agent({ keepAlive: false, rejectUnauthorized: !insecure }),
    headers: { 'User-Agent': UA, Accept: '*/*' },
  });
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(LOCAL_BIN);
    res.data.pipe(ws);
    res.data.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
  });
}

// Download the official standalone build (works without pip / root).
async function downloadStandaloneBinary() {
  const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
  fs.mkdirSync(BIN_DIR, { recursive: true });
  try {
    await fetchBinary(url, false);
  } catch (e) {
    if (!/certificate|self.signed|unable to verify|CERT_|SSL/i.test(String(e.message))) throw e;
    console.warn('[ytdlp] TLS verification failed for the download, retrying without certificate checks');
    await fetchBinary(url, true);
  }
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
      await execFileAsync(cmd[0], cmd.slice(1), { timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
      if (resolveCommand({ force: true })) return true;
    } catch { /* try the next pip flavour */ }
  }
  return false;
}

let _ensurePromise = null;

/**
 * Make sure yt-dlp exists. Installs it once (standalone binary first, then pip)
 * when the host has none — the old build just told the user "not installed".
 */
async function ensureInstalled() {
  if (resolveCommand()) return resolveCommand();
  if (_ensurePromise) return _ensurePromise;

  _ensurePromise = (async () => {
    _installError = null;
    try { await downloadStandaloneBinary(); console.log('[ytdlp] installed standalone binary at', LOCAL_BIN); }
    catch (e) { _installError = `binary download: ${e.message}`; console.warn('[ytdlp] binary download failed:', e.message); }
    if (!resolveCommand({ force: true })) {
      try {
        if (await pipInstall()) console.log('[ytdlp] installed via pip');
        else _installError = `${_installError || ''} | pip install failed (tried --user and --break-system-packages)`.trim();
      } catch (e) { _installError = e.message; console.warn('[ytdlp] pip install failed:', e.message); }
    }
    if (resolveCommand({ force: true })) capabilities({ force: true });
    return resolveCommand({ force: true });
  })().finally(() => { _ensurePromise = null; });

  return _ensurePromise;
}

/**
 * Self-update (standalone binary) or pip upgrade. Returns the new version.
 * `quick: true` (used automatically after a bot-check) only does the fast
 * standalone-binary update, so a user's .song request is never stuck waiting
 * for a slow pip install.
 */
async function update({ quick = false } = {}) {
  const cmd = resolveCommand();
  const isLocal = cmd && cmd[0] === LOCAL_BIN;
  let ok = false;
  if (isLocal) {
    try {
      await execFileAsync(LOCAL_BIN, ['-U'], { timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
      ok = Boolean(resolveCommand({ force: true }));
    } catch (e) { console.warn('[ytdlp] self-update failed:', String(e.message).split('\n')[0]); }
  }
  if (!ok && !quick) ok = await pipInstall();
  if (!ok && !cmd && !quick) await ensureInstalled();
  capabilities({ force: true }); // flags may have changed with the version
  return version();
}

// ─── CAPABILITIES (which options does the installed build understand?) ────────
//
// The old build always passed --js-runtimes and --remote-components. A build
// older than those options exits with "no such option" and *every* download
// fails, no matter the video. We probe --help once and only use what exists.

let _caps = null;

function capabilities({ force = false } = {}) {
  if (_caps && !force) return _caps;

  const caps = {
    version: null,
    flags: new Set(),
    jsRuntimes: false,
    remoteComponents: false,
    impersonate: false,
    impersonateBroken: false,
    matchFilter: null,
    forceIpv4: false,
    noCheckCertificates: false,
    extractorRetries: false,
    noCheckFormats: false,
    concurrentFragments: false,
    maxFilesize: false,
    newline: false,
    progressTemplate: false,
  };

  const cmd = resolveCommand();
  if (!cmd) { _caps = caps; return caps; }

  caps.version = probeCommand(cmd);

  let help = '';
  try {
    help = String(execFileSync(cmd[0], [...cmd.slice(1), '--help'], {
      timeout: 20000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    }) || '');
  } catch { /* a build too old for --help: keep the conservative defaults */ }

  for (const m of help.matchAll(/--([a-z0-9][a-z0-9-]+)/g)) caps.flags.add(m[1]);
  const has = (name) => caps.flags.has(name) || caps.flags.has(`${name}s`);

  caps.jsRuntimes = caps.flags.has('js-runtimes');
  caps.remoteComponents = caps.flags.has('remote-components');
  caps.impersonate = caps.flags.has('impersonate');
  // argparse accepts unambiguous abbreviations, so --match-filter works even on
  // builds that only document --match-filters.
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

/** Called when a run proves --impersonate unusable (no curl_cffi on the host). */
const disableImpersonation = () => { if (_caps) _caps.impersonateBroken = true; };

// ─── COOKIES ──────────────────────────────────────────────────────────────────

const looksLikeCookieFile = (text) =>
  typeof text === 'string' && (text.includes('\t') || /^#\s*(Netscape|HTTP Cookie File)/im.test(text));

/** Browser-extension JSON export -> Netscape cookie text (people send this a lot). */
function jsonCookiesToNetscape(text) {
  let arr;
  try { arr = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(arr) || !arr.length || !arr[0] || typeof arr[0] !== 'object') return null;
  if (!('domain' in arr[0]) || !('name' in arr[0])) return null;

  const lines = ['# Netscape HTTP Cookie File', '# converted from JSON by ZaFar Bot', ''];
  const bool = (v) => (v === true || v === 'TRUE' || v === 'True' ? 'TRUE' : 'FALSE');
  for (const c of arr) {
    if (!c || !c.domain || !c.name) continue;
    const domain = String(c.domain);
    const includeSub = c.hostOnly === true ? 'FALSE' : (domain.startsWith('.') ? 'TRUE' : 'FALSE');
    const expires = Number.isFinite(Number(c.expirationDate)) ? Math.floor(Number(c.expirationDate))
      : Number.isFinite(Number(c.expires)) ? Math.floor(Number(c.expires)) : 0;
    lines.push([
      domain, includeSub, String(c.path || '/'), bool(c.secure),
      String(expires), String(c.name), String(c.value ?? ''),
    ].join('\t'));
  }
  return lines.length > 3 ? lines.join('\n') + '\n' : null;
}

/**
 * Normalise anything the user gave us (Netscape text, base64 of it, or a JSON
 * export) into Netscape cookie text. Returns null when it is not cookies.
 */
function normaliseCookieText(raw) {
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

/**
 * Persist cookies on the host so they survive restarts (.cookies set).
 * @returns {{file:string,count:number}}
 */
function setCookies(raw) {
  const text = normaliseCookieText(raw);
  if (!text) {
    const err = new Error('That does not look like a cookies.txt (Netscape) file');
    err.code = 'BAD_COOKIES';
    throw err;
  }
  fs.mkdirSync(path.dirname(COOKIE_STORE), { recursive: true });
  fs.writeFileSync(COOKIE_STORE, text);
  try { fs.chmodSync(COOKIE_STORE, 0o600); } catch { /* windows */ }
  _cookieInfoCache = null;
  return { file: COOKIE_STORE, count: countCookies(text) };
}

function clearCookies() {
  let removed = false;
  for (const p of [COOKIE_STORE, path.join(process.cwd(), 'cookies.txt')]) {
    try { if (fs.existsSync(p)) { fs.unlinkSync(p); removed = true; } } catch { /* ignore */ }
  }
  _cookieInfoCache = null;
  return removed;
}

const countCookies = (text) => String(text || '')
  .split('\n')
  .filter((l) => l.trim() && !l.trim().startsWith('#') && l.split('\t').length >= 6)
  .length;

let _cookieInfoCache = null;

/**
 * Which cookie source is in use, how many cookies, how old.
 * A cached *positive* answer is reused for a few seconds; a cached negative one
 * is re-checked every time (four existsSync calls), otherwise cookies added
 * while the bot is running (.cookies set) would be ignored until a restart.
 */
function cookieInfo() {
  if (_cookieInfoCache) {
    const age = Date.now() - _cookieInfoCache.checkedAt;
    const cachedFile = _cookieInfoCache.file;
    if (_cookieInfoCache.source && cachedFile && fs.existsSync(cachedFile) && age < 30000) return _cookieInfoCache;
    if (_cookieInfoCache.source && !cachedFile && age < 30000) return _cookieInfoCache;
  }

  const cfg = config.ytdlp || {};
  const candidates = [
    { source: 'inline (config/env)', file: null, text: cfg.cookies || process.env.YOUTUBE_COOKIES || '' },
    { source: 'managed (.cookies set)', file: COOKIE_STORE, text: null },
    { source: 'config file', file: cfg.cookiesFile || process.env.YOUTUBE_COOKIES_FILE || '', text: null },
    { source: 'cookies.txt (bot folder)', file: path.join(process.cwd(), 'cookies.txt'), text: null },
  ];

  for (const c of candidates) {
    if (c.text && String(c.text).trim()) {
      const normalised = normaliseCookieText(c.text);
      if (normalised) {
        _cookieInfoCache = { source: c.source, file: null, count: countCookies(normalised), mtime: null, checkedAt: Date.now() };
        return _cookieInfoCache;
      }
    }
    if (c.file && fs.existsSync(c.file)) {
      let mtime = null, count = 0;
      try {
        mtime = fs.statSync(c.file).mtimeMs;
        count = countCookies(fs.readFileSync(c.file, 'utf8'));
      } catch { /* unreadable */ }
      _cookieInfoCache = { source: c.source, file: c.file, count, mtime, checkedAt: Date.now() };
      return _cookieInfoCache;
    }
  }

  _cookieInfoCache = { source: null, file: null, count: 0, mtime: null, checkedAt: Date.now() };
  return _cookieInfoCache;
}

const hasCookies = () => Boolean(cookieInfo().source);

/**
 * Resolve the cookies flag value for yt-dlp.
 * Inline cookies are materialised to the managed file (stable path, no temp
 * cleanup deleting them).
 */
function cookieFile() {
  const cfg = config.ytdlp || {};
  const inline = cfg.cookies || process.env.YOUTUBE_COOKIES || '';
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
      } catch { /* fall through to other sources */ }
    }
  }
  const info = cookieInfo();
  return info.file || null;
}

// ─── PROXY ────────────────────────────────────────────────────────────────────

const proxyUrl = () => {
  const cfg = config.ytdlp || {};
  // Runtime setting (.ytdl proxy) wins over config/environment.
  const runtime = settings.get('proxy', '');
  return String(runtime || cfg.proxy || process.env.YTDLP_PROXY || '').trim();
};

// ─── ARGUMENT BUILDING ────────────────────────────────────────────────────────

/**
 * Optional, cosmetic/robustness flags. If a build ever rejects one of them the
 * engine drops them all and retries once (see runWithProfiles) instead of
 * failing every download with "no such option".
 */
let _minimalBaseArgs = false;
const setMinimalBaseArgs = (on = true) => { _minimalBaseArgs = Boolean(on); };
const usingMinimalBaseArgs = () => _minimalBaseArgs;

const PROGRESS_PREFIX = '@@ZFPROG@@';
const PROGRESS_TEMPLATE =
  `${PROGRESS_PREFIX}%(progress.downloaded_bytes)s|%(progress.total_bytes)s|` +
  '%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s';

/**
 * @param {{progress?:boolean}} opts
 */
function baseArgs({ progress = false } = {}) {
  const cfg = config.ytdlp || {};
  const caps = capabilities();

  const args = [
    '--no-playlist',
    '--no-warnings',
    '--ignore-config',
    '--retries', '2',
    '--fragment-retries', '2',
    '--socket-timeout', '20',
  ];

  if (!_minimalBaseArgs) {
    args.push('--no-color', '--user-agent', UA, '--add-header', 'Accept-Language: en-US,en;q=0.9');
  }

  if (caps.extractorRetries) args.push('--extractor-retries', '1');

  // Hosts with broken/outdated CA stores (common on free panels) fail every
  // HTTPS request otherwise. On by default; set ytdlp.noCheckCertificates=false
  // to re-enable strict verification.
  if (caps.noCheckCertificates && cfg.noCheckCertificates !== false) args.push('--no-check-certificates');

  // Some hosts only have IPv6 egress and YouTube throttles/blocks it.
  if (caps.forceIpv4 && cfg.ipv4 !== false) args.push('--force-ipv4');

  // yt-dlp needs a JavaScript runtime to solve YouTube's challenges; node is
  // always present because this bot *is* a node process. Only pass the flag on
  // builds that know it.
  if (caps.jsRuntimes) args.push('--js-runtimes', `node:${process.execPath}`);

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
 * Only flags the installed yt-dlp understands are ever used.
 */
function attemptProfiles(url) {
  const caps = capabilities();
  if (!isYouTubeUrl(url)) return [{ name: 'default', args: [] }];

  const list = [{ name: 'default', args: [] }];
  if (caps.impersonate && !caps.impersonateBroken) {
    list.push({ name: 'impersonate', args: ['--impersonate', 'chrome'] });
  }
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

// Kept as a stable export for older callers / diagnostics output.
const ATTEMPT_PROFILES = [
  { name: 'default', args: [] },
  { name: 'impersonate', args: ['--impersonate', 'chrome'] },
  { name: 'tv', args: ['--extractor-args', 'youtube:player_client=tv,web_safari'] },
  { name: 'android_vr', args: ['--extractor-args', 'youtube:player_client=android_vr,web_embedded'] },
  { name: 'ios', args: ['--extractor-args', 'youtube:player_client=ios,mweb'] },
  { name: 'web_safari', args: ['--extractor-args', 'youtube:player_client=web_safari,web'] },
  { name: 'ejs', args: ['--remote-components', 'ejs:github', '--extractor-args', 'youtube:player_client=default,web_embedded'] },
  { name: 'missing_pot', args: ['--extractor-args', 'youtube:player_client=default;formats=missing_pot'] },
];

// ─── RUNNER ───────────────────────────────────────────────────────────────────

const MAX_CAPTURE = 256 * 1024;

/**
 * Spawn yt-dlp and capture output with hard caps.
 * `onProgress({percent,speed,eta})` is called while downloading when the
 * `progress` option is on — used by .ytv to show live progress in WhatsApp.
 */
function spawnYtdlp(args, { timeout = 120000, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const cmd = resolveCommand() || null;
    if (!cmd) {
      return reject(Object.assign(new Error('yt-dlp is not installed'), { code: 'NO_YTDLP' }));
    }

    let child;
    try {
      child = spawn(cmd[0], [...cmd.slice(1), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(Object.assign(new Error(`could not start yt-dlp: ${e.message}`), { code: 'NO_YTDLP' }));
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let killedByTimeout = false;

    const timer = timeout > 0 ? setTimeout(() => {
      killedByTimeout = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeout) : null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };

    const handleLine = (line) => {
      if (!onProgress || !line.startsWith(PROGRESS_PREFIX)) return;
      const [downloaded, total, estimate, speed, eta] = line.slice(PROGRESS_PREFIX.length).split('|');
      const done = Number(downloaded);
      const size = Number(total) || Number(estimate);
      if (!Number.isFinite(done) || !Number.isFinite(size) || size <= 0) return;
      onProgress({
        percent: Math.max(0, Math.min(100, Math.round((done / size) * 100))),
        speed: Number.isFinite(Number(speed)) ? Number(speed) : String(speed || '').trim(),
        eta: Number(eta) || 0,
      });
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
      // yt-dlp prints progress to stderr in some versions
      if (onProgress) {
        for (const line of text.split('\n')) handleLine(line.trim());
      }
    });

    child.on('error', (e) => {
      finish(reject, Object.assign(new Error(e.message), { code: 'NO_YTDLP' }));
    });

    child.on('close', (code, signal) => {
      if (code === 0) return finish(resolve, { stdout, stderr });
      const err = new Error(killedByTimeout ? 'yt-dlp timed out' : `yt-dlp exited with code ${code}`);
      err.stderr = stderr;
      err.stdout = stdout;
      err.exitCode = code;
      err.signal = signal;
      if (killedByTimeout) err.killed = true;
      finish(reject, err);
    });
  });
}

/** One-shot yt-dlp run (metadata, diagnostics). */
async function run(args, { timeout = 120000 } = {}) {
  if (!resolveCommand()) await ensureInstalled();
  return spawnYtdlp(args, { timeout });
}

// ─── ERROR CLASSIFICATION ─────────────────────────────────────────────────────

const RULES = [
  { code: 'RATE_LIMIT',     re: /HTTP Error 429|too many requests|rate.?limit/i },
  // Age must be checked before the generic "sign in" rule: yt-dlp words an
  // age-restriction as "Sign in to confirm your age", which is not a bot-check.
  { code: 'AGE_RESTRICTED', re: /age.?restricted|sign in to confirm your age|inappropriate for some users/i },
  { code: 'BOT_CHECK',      re: /not a bot|confirm you'?re not a bot|sign in to confirm|please sign in|use --cookies|login required|this content isn'?t available to bots|cookies for the authentication/i },
  { code: 'GEO_BLOCK',      re: /available in your country|available in your location|available in your region|not available in this country|geo.?restrict|blocked in your country|unavailable in your region|has blocked (?:this|it) (?:video|content) in your|not made this video available/i },
  { code: 'PRIVATE',        re: /private video|this video is private/i },
  { code: 'MEMBERS_ONLY',   re: /members-only|members only|only available to (?:channel )?members|join this channel|channel membership/i },
  { code: 'LIVE_EVENT',     re: /live event will begin|premieres in|is currently live|this live event has ended/i },
  { code: 'DRM',            re: /drm protected|protected by drm|encrypted media/i },
  { code: 'PO_TOKEN',       re: /po.?token|missing pot|requires a po token/i },
  { code: 'UNAVAILABLE',    re: /video unavailable|this video is not available|has been removed|no longer available|does not exist|removed by the uploader|account (?:has been )?(?:terminated|suspended)|unavailable video|not available on this app|requested video is not available/i },
  { code: 'TOO_LONG',       re: /is longer than|exceeds the duration|duration filter|does not pass (?:the )?filter/i },
  { code: 'TOO_BIG',        re: /larger than max-filesize|file is larger than|skipping due to --max-filesize|exceeds (?:the )?max.?filesize/i },
  { code: 'BAD_ARGS',       re: /no such option|unrecognized arguments|unrecognised arguments|invalid argument|invalid value for/i },
  { code: 'FFMPEG_MISSING', re: /ffmpeg (?:is )?not (?:installed|found)|ffprobe and ffmpeg not found|postprocessing.*ffmpeg|requested merging of multiple formats|you have requested merging|\b(?:won['’]t|will not) be merged\b/i },
  { code: 'IMPERSONATE',    re: /impersonat\w+ (?:target|request)|curl_cffi|impersonate.*not (?:available|supported)/i },
  { code: 'UNSUPPORTED_URL', re: /unsupported url|no suitable extractor|unknown extractor|is not a valid url|no video formats found for this url/i },
  { code: 'NO_FORMATS',     re: /requested format (?:is )?not available|no video formats found|only images are available|no video formats|unable to extract (?:any )?(?:video|data)|no formats? found for|some formats may be missing/i },
  { code: 'NETWORK',        re: /unable to download (?:webpage|api page|video data|json)|timed out|timeout|temporary failure|connection (?:refused|reset|aborted)|getaddrinfo|ssl|certificate|EOF occurred|HTTP Error 5\d\d|network is unreachable|remote end closed|tls\/ssl connection has been closed/i },
  { code: 'NO_YTDLP',       re: /yt-dlp is not installed|ENOENT|not recognized as an internal or external command/i },
];

function firstErrorLine(text) {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const errors = lines.filter(l => /^(ERROR|WARNING):/i.test(l));
  const line = errors.length ? errors[errors.length - 1] : (lines[lines.length - 1] || '');
  return line.replace(/^(ERROR|WARNING):\s*/i, '').slice(0, 300);
}

/**
 * Turn any yt-dlp failure into { code, detail, text }.
 * Unknown failures stay UNKNOWN instead of being blamed on the region.
 */
function classify(err) {
  // NOTE: err.message from execFile contains the full command line ("Command
  // failed: yt-dlp ... --match-filter duration < 3600 ..."), which used to make
  // innocent failures look like duration/size errors. Only real yt-dlp output
  // is used for matching.
  const parts = [];
  if (err && err.stderr) parts.push(String(err.stderr));
  if (err && err.stdout) parts.push(String(err.stdout));
  if (err && err.message && !/^Command failed/i.test(String(err.message))) parts.push(String(err.message));
  const text = parts.join('\n');

  if (err && typeof err === 'object' && err.code && typeof err.code === 'string' && !/^(ERR_|E[A-Z]+$)/.test(err.code)) {
    if (RULES.some(r => r.code === err.code)) {
      return { code: err.code, detail: firstErrorLine(text), text };
    }
  }
  if (err && err.killed) return { code: 'NETWORK', detail: 'download timed out', text };

  for (const rule of RULES) {
    if (rule.re.test(text)) return { code: rule.code, detail: firstErrorLine(text), text };
  }
  return { code: 'UNKNOWN', detail: firstErrorLine(text), text };
}

// Failures worth retrying with a different player client.
const RETRY_CODES = new Set(['BOT_CHECK', 'NO_FORMATS', 'UNKNOWN', 'NETWORK', 'AGE_RESTRICTED', 'IMPERSONATE', 'PO_TOKEN']);
// UNSUPPORTED_URL is final: retrying other player clients cannot help.

const isRetryable = (code) => RETRY_CODES.has(code);

// ─── USER-FACING MESSAGES ─────────────────────────────────────────────────────

const HINTS = {
  NO_YTDLP: '❌ *yt-dlp* is not installed and could not be auto-installed on this host.\nFix: `pip install -U yt-dlp`, or run `.ytdl repair`.',
  BOT_CHECK: '❌ YouTube asked this server to prove it is *not a bot* — this is the normal wall for VPS/hosting IPs, **not** a region block.\nFix: `.cookies set` (add a YouTube cookies.txt) — that cures it in ~95% of cases. Or set a proxy: `.ytdl proxy <url>`.',
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
  FFMPEG_MISSING: '❌ *ffmpeg* is missing on this host, so the audio/video cannot be converted.\nFix: `apt install ffmpeg` (Termux: `pkg install ffmpeg`), or run `npm install` to install the packaged fallback.',
  UNSUPPORTED_URL: '❌ That link is not a media page the downloader understands (or the site is not supported).\nSupported: YouTube, TikTok, Instagram, Facebook, X/Twitter, Reddit, SoundCloud and ~1000 more — paste the link to the *post/video*, not to a profile or a search page.',
  NO_FORMATS: '❌ YouTube returned no downloadable stream for that video. Try a different quality (e.g. 360p) or another video.',
  IMPERSONATE: '❌ This yt-dlp build cannot impersonate a browser on this host.',
  BAD_ARGS: '❌ The yt-dlp build on this host does not support one of the options the bot used.\nFix: `.ytdl update` (or `.ytdl repair`) to install a current build.',
  RATE_LIMIT: '❌ YouTube is rate-limiting this server (HTTP 429). Wait a few minutes and try again.',
  NETWORK: '❌ The host could not reach YouTube (network/DNS/TLS/timeout).\nThis is a problem with the *server\'s internet*, not the video — check the host\'s connection, or set a proxy: `.ytdl proxy <url>`.',
  UNKNOWN: '❌ Download failed. Run `.ytdl` to see what the host reported, then try again.',
};

/** Accurate, actionable message for any error thrown by this module. */
function friendlyError(err) {
  const info = classify(err);
  const extra = info && info.detail ? `\n_${String(info.detail).slice(0, 160)}_` : '';
  return (HINTS[info.code] || HINTS.UNKNOWN) + extra;
}

/** One-line summary of every engine that was tried (for the final error). */
function attemptsSummary(attempts) {
  if (!Array.isArray(attempts) || !attempts.length) return '';
  const lines = attempts.slice(0, 6).map(a => `• ${a.engine}: ${a.code}`);
  return `\n\n*What was tried:*\n${lines.join('\n')}`;
}

// ─── INFO / DOWNLOAD ──────────────────────────────────────────────────────────

let _lastError = null;
const lastError = () => _lastError;

const recordFailure = (info) => {
  _lastError = {
    code: info.code,
    detail: info.detail,
    attempts: info.attempts || [],
    at: Date.now(),
    url: info.url || null,
  };
  return _lastError;
};

const remember = (err, url, attempts) => {
  const info = classify(err);
  recordFailure({ ...info, url, attempts });
  return info;
};

/**
 * Video metadata via yt-dlp (no download).
 * @returns {Promise<{title:string,duration:number,uploader:string,thumbnail:string,id:string}>}
 */
async function fetchInfo(url, { timeout = 60000 } = {}) {
  const caps = capabilities();
  const args = [...baseArgs(), '--skip-download'];
  if (caps.noCheckFormats) args.push('--no-check-formats');
  args.push('--print', '%(title)s\t%(duration)s\t%(uploader)s\t%(thumbnail)s\t%(id)s', url);

  try {
    const { stdout } = await run(args, { timeout });
    const line = String(stdout || '').trim().split('\n').pop() || '';
    const [title, duration, uploader, thumbnail, id] = line.split('\t');
    return {
      title: (title || '').trim(),
      duration: Number(duration) || 0,
      uploader: (uploader || '').trim(),
      thumbnail: (thumbnail || '').trim(),
      id: (id || '').trim(),
    };
  } catch (err) {
    // Metadata is often the first thing a bot-check kills; try the escalations
    // before giving up so search results still resolve.
    let last = err;
    for (const profile of attemptProfiles(url).slice(1, 4)) {
      try {
        const { stdout } = await run([...baseArgs(), ...profile.args, '--skip-download', '--print',
          '%(title)s\t%(duration)s\t%(uploader)s\t%(thumbnail)s\t%(id)s', url], { timeout });
        const line = String(stdout || '').trim().split('\n').pop() || '';
        const [title, duration, uploader, thumbnail, id] = line.split('\t');
        return {
          title: (title || '').trim(),
          duration: Number(duration) || 0,
          uploader: (uploader || '').trim(),
          thumbnail: (thumbnail || '').trim(),
          id: (id || '').trim(),
        };
      } catch (e) { last = e; }
    }
    throw last;
  }
}

const INFO_CACHE_TTL_MS = 10 * 60 * 1000;
const INFO_CACHE_MAX = 100;
const infoCache = new Map();

function getInfo(url, options = {}) {
  const key = String(url || '');
  const now = Date.now();
  const cached = infoCache.get(key);
  if (cached && now - cached.ts < INFO_CACHE_TTL_MS) {
    infoCache.delete(key);
    infoCache.set(key, cached);
    return cached.promise || Promise.resolve(cached.value);
  }
  if (cached) infoCache.delete(key);

  const entry = { ts: now, promise: null, value: null };
  entry.promise = fetchInfo(url, options).then((value) => {
    if (infoCache.get(key) === entry) {
      entry.value = value;
      entry.promise = null;
      entry.ts = Date.now();
    }
    return value;
  }).catch((error) => {
    if (infoCache.get(key) === entry) infoCache.delete(key);
    throw error;
  });
  infoCache.set(key, entry);
  while (infoCache.size > INFO_CACHE_MAX) infoCache.delete(infoCache.keys().next().value);
  return entry.promise;
}

/**
 * Raw probe for diagnostics: run yt-dlp with the given client profile and give
 * back everything it printed (used by `.ytdl raw <link>`).
 */
async function probeRaw(url, { timeout = 60000, client = null } = {}) {
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

/**
 * Search YouTube through yt-dlp (API endpoints, so it survives the HTML
 * scraping blocks that break yt-search on hosting IPs).
 * @returns {Promise<Array<{id,title,duration,uploader,thumbnail}>>}
 */
async function searchVideos(query, { limit = 5, timeout = 60000 } = {}) {
  const caps = capabilities();
  const n = Math.max(1, Math.min(20, Number(limit) || 5));
  const args = [
    // --no-playlist would collapse a search into a single entry
    ...baseArgs().filter(a => a !== '--no-playlist'),
    '--flat-playlist',
    '--skip-download',
  ];
  if (caps.noCheckFormats) args.push('--no-check-formats');
  args.push('--print', '%(id)s\t%(title)s\t%(duration)s\t%(uploader)s\t%(thumbnail)s', `ytsearch${n}:${query}`);

  const { stdout } = await run(args, { timeout });
  return String(stdout || '')
    .trim()
    .split('\n')
    .map(line => line.split('\t'))
    .filter(parts => parts[0] && parts[0] !== 'NA')
    .map(([id, title, duration, uploader, thumbnail]) => {
      const videoId = id.trim();
      return {
        id: videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        title: (title || '').trim(),
        duration: Number(duration) || 0,
        uploader: (uploader || '').trim(),
        thumbnail: /^https?:/i.test(String(thumbnail || '')) ? String(thumbnail).trim() : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      };
    });
}

/** Find the file yt-dlp produced for `outBase` (it picks the extension). */
function findProduced(outBase) {
  const dir = path.dirname(outBase);
  const base = path.basename(outBase);
  const exts = ['.mp3', '.m4a', '.opus', '.ogg', '.webm', '.aac', '.wav', '.flac',
    '.mp4', '.mkv', '.mov', '.3gp', '.m4v'];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }

  // exactly "<base>.<ext>" — anything longer belongs to another step
  const own = names.filter(f => f.startsWith(`${base}.`) && f.slice(base.length + 1).indexOf('.') === -1 && !PART_RE.test(f));
  const hit = own.find(f => exts.includes(path.extname(f).toLowerCase())) || own[0];
  return hit ? path.join(dir, hit) : null;
}

const PART_RE = /\.f[0-9A-Za-z_-]+\.[a-z0-9]+$|\.(part|ytdl|temp|tmp)$|\.part-Frag\d+/i;

/** Leftover per-format parts for `outBase` (a merge that never happened). */
function leftoverParts(outBase) {
  const dir = path.dirname(outBase);
  const base = path.basename(outBase);
  try { return fs.readdirSync(dir).filter(f => f.startsWith(`${base}.`) && PART_RE.test(f)).map(f => path.join(dir, f)); }
  catch { return []; }
}

function mergeVideoParts(outBase, parts) {
  if (parts.length !== 2) return null;
  const videoExts = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4v', '.ts']);
  const audioExts = new Set(['.m4a', '.mp3', '.opus', '.ogg', '.aac', '.wav', '.flac']);
  const videos = parts.filter(file => videoExts.has(path.extname(file).toLowerCase()));
  const audios = parts.filter(file => audioExts.has(path.extname(file).toLowerCase()));
  if (videos.length !== 1 || audios.length !== 1 || videos[0] === audios[0]) return null;

  const ffmpeg = getFfmpeg();
  const output = `${outBase}.mp4`;
  try {
    execFileSync(ffmpeg, [
      '-y', '-nostdin', '-i', videos[0], '-i', audios[0],
      '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-movflags', '+faststart', output,
    ], { timeout: 10 * 60 * 1000, stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    try { fs.unlinkSync(output); } catch { /* ignore */ }
    throw error;
  }
  if (!fs.existsSync(output) || !fs.statSync(output).size) {
    try { fs.unlinkSync(output); } catch { /* ignore */ }
    return null;
  }
  return output;
}

/**
 * yt-dlp exits 0 when --max-filesize aborts a download ("File is larger than
 * max-filesize … Aborting."), leaving no file — or only the video half of a
 * DASH pair. Turn that into a proper TOO_BIG error.
 */
function assertProduced(outBase, stdout, what) {
  const file = findProduced(outBase);
  const tooBig = /larger than max-filesize/i.test(String(stdout || ''));
  if (file && !tooBig) return file;
  if (!file && !tooBig && what === 'video') {
    const parts = leftoverParts(outBase);
    if (parts.length === 2 && getFfmpeg.works()) {
      try {
        const merged = mergeVideoParts(outBase, parts);
        if (merged) {
          for (const part of parts) {
            try { fs.unlinkSync(part); } catch { /* ignore */ }
          }
          return merged;
        }
      } catch (error) {
        console.warn('[ytdlp] failed to merge leftover video/audio parts:', error.message || error);
      }
    }
  }
  for (const f of [file, ...leftoverParts(outBase)].filter(Boolean)) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  if (tooBig) throw Object.assign(new Error('File is larger than max-filesize'), { code: 'TOO_BIG' });
  throw Object.assign(new Error(`yt-dlp produced no ${what} file`), { code: 'NO_FORMATS' });
}

let _autoUpdated = false;
let _autoUpdateScheduled = false;

function scheduleAutoUpdate() {
  if (_autoUpdateScheduled) return false;
  const hours = Number(config.ytdlp?.autoUpdateHours ?? 24);
  if (!Number.isFinite(hours) || hours <= 0) return false;
  _autoUpdateScheduled = true;

  const runUpdate = async () => {
    try {
      const command = resolveCommand();
      const result = command ? await update({ quick: true }) : await ensureInstalled();
      if (!result) console.warn('[ytdlp] scheduled auto-update/install did not find a working version');
    } catch (error) {
      console.warn('[ytdlp] scheduled auto-update failed:', error.message || error);
    }
  };
  const timer = setTimeout(() => {
    void runUpdate();
    const interval = setInterval(() => { void runUpdate(); }, hours * 60 * 60 * 1000);
    interval.unref?.();
  }, 5 * 60 * 1000);
  timer.unref?.();
  return true;
}

/**
 * Run one download with the escalating client profiles, under a global deadline
 * so a hopeless job can never hang the user for an hour.
 *
 * @param {string} url
 * @param {(profile:{name:string,args:string[]})=>string[]} buildArgs
 * @param {{timeout?:number,deadlineMs?:number,progress?:boolean,onAttempt?:Function,onProgress?:Function}} opts
 */
async function runWithProfiles(url, buildArgs, {
  timeout = 12 * 60 * 1000,
  deadlineMs = Number(config.ytdlp?.deadlineMs) || 10 * 60 * 1000,
  progress = false,
  onAttempt,
  onProgress,
} = {}) {
  const startedAt = Date.now();
  const profiles = attemptProfiles(url);
  const attempts = [];
  let lastErr = null;
  let lastCode = 'UNKNOWN';

  for (let i = 0; i < profiles.length; i++) {
    const profile = profiles[i];
    const elapsed = Date.now() - startedAt;
    const remaining = deadlineMs - elapsed;
    if (remaining <= 5000) {
      console.warn(`[ytdlp] deadline reached after ${attempts.length} attempt(s)`);
      break;
    }

    try {
      const args = [...baseArgs({ progress }), ...profile.args, ...buildArgs(profile)];
      const { stdout } = await spawnYtdlp(args, {
        timeout: Math.min(timeout, remaining),
        onProgress: onProgress ? (p) => { try { onProgress(p, profile.name); } catch { /* ignore */ } } : undefined,
      });
      return { profile: profile.name, attempts, stdout };
    } catch (err) {
      const info = classify(err);
      lastErr = err;
      lastCode = info.code;
      attempts.push({ engine: `yt-dlp:${profile.name}`, code: info.code, detail: info.detail });
      if (onAttempt) onAttempt(profile.name, err, info);

      // A build that cannot impersonate will not learn to: drop that profile.
      if (info.code === 'IMPERSONATE' && profile.name === 'impersonate') disableImpersonation();

      // Some builds reject one of the optional flags (usually because they are
      // much older than expected). Drop them and retry the same profile once
      // instead of failing every download with "no such option".
      if (info.code === 'BAD_ARGS' && !_minimalBaseArgs) {
        console.warn('[ytdlp] this build rejected an optional option — retrying with minimal arguments');
        setMinimalBaseArgs(true);
        i--;
        continue;
      }

      // YouTube silently breaks older yt-dlp builds: a bot-check on a stale
      // version is worth one self-update per process before giving up.
      if (info.code === 'BOT_CHECK' && !_autoUpdated && config.ytdlp?.updateOnBotCheck !== false) {
        _autoUpdated = true;
        console.log('[ytdlp] bot-check detected — updating yt-dlp before retrying');
        try { await update({ quick: true }); } catch (e) { console.warn('[ytdlp] auto-update failed:', e.message); }
      }

      // "Video unavailable" style failures are final — retrying other clients
      // only wastes minutes of the user's time.
      if (!isRetryable(info.code)) break;
    }
  }

  if (lastErr) {
    const info = classify(lastErr);
    const code = info.code === 'UNKNOWN' && lastCode ? lastCode : info.code;
    const wrapped = Object.assign(new Error(info.detail || 'yt-dlp failed'), {
      code, detail: info.detail, stderr: info.text, attempts,
    });
    remember(wrapped, url, attempts);
    throw wrapped;
  }
  throw Object.assign(new Error('yt-dlp did not run'), { code: 'NO_YTDLP' });
}

/**
 * Download the best audio-only stream and convert it to MP3 when ffmpeg is
 * available (falls back to the raw container otherwise).
 * @returns {Promise<{file:string,ext:string,profile:string,attempts:Array}>}
 */
async function downloadAudio(url, { outBase, maxMB = 200, maxSeconds = 0, onAttempt, onProgress, deadlineMs } = {}) {
  const ffmpeg = getFfmpeg();
  const ffmpegWorks = getFfmpeg.works();
  const caps = capabilities();
  const base = outBase || path.join(getTempDir(), `audio_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);

  // "<?N" keeps the filter optional when YouTube hides the duration —
  // "--match-filter duration < N" used to reject those videos with a
  // misleading "too long" error.
  const durationFilter = maxSeconds > 0 && caps.matchFilter
    ? [caps.matchFilter, `duration <?${Math.floor(maxSeconds)}`]
    : [];

  const sizeLimit = caps.maxFilesize ? ['--max-filesize', `${maxMB}M`] : [];
  const fragments = caps.concurrentFragments
    ? ['--concurrent-fragments', String(Math.max(1, Number(config.ytdlp?.fragments) || 4))]
    : [];

  // ── 1. THE OFFICIAL AUDIO, UNTOUCHED ─────────────────────────────────────
  // Highest quality = whatever YouTube serves: m4a (AAC) first, opus second.
  // No re-encode, therefore no ffmpeg needed and no generation loss.
  const rawArgs = () => [
    '-f', 'bestaudio[ext=m4a]/bestaudio[ext=mp4]/bestaudio[ext=webm]/bestaudio/best',
    ...durationFilter,
    ...sizeLimit,
    ...fragments,
    '-o', `${base}.%(ext)s`, url,
  ];

  try {
    const { profile, attempts, stdout } = await runWithProfiles(url, rawArgs, {
      onAttempt, onProgress, progress: Boolean(onProgress), deadlineMs,
    });
    const file = assertProduced(base, stdout, 'audio');
    return { file, ext: path.extname(file).slice(1).toLowerCase(), profile, attempts, transcoded: false };
  } catch (err) {
    const info = classify(err);
    // Only a missing raw audio stream is worth converting for; bot-checks and
    // network problems would fail exactly the same way.
    if (!ffmpegWorks || (info.code !== 'NO_FORMATS' && info.code !== 'FFMPEG_MISSING')) throw err;

    console.warn('[ytdlp] no raw audio stream — re-encoding to mp3 instead');
    const convertArgs = () => [
      '-f', 'bestaudio[ext=m4a]/bestaudio/best',
      '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0',
      ...ffmpegLocationArgs(ffmpeg),
      ...durationFilter,
      ...sizeLimit,
      ...fragments,
      '-o', `${base}.%(ext)s`, url,
    ];
    const { profile, attempts, stdout } = await runWithProfiles(url, convertArgs, {
      onAttempt, onProgress, progress: Boolean(onProgress), deadlineMs,
    });
    const file = assertProduced(base, stdout, 'audio');
    return { file, ext: path.extname(file).slice(1).toLowerCase(), profile, attempts, transcoded: true };
  }
}

function ffmpegLocationArgs(ffmpeg = getFfmpeg()) {
  return path.isAbsolute(String(ffmpeg || '')) && fs.existsSync(ffmpeg)
    ? ['--ffmpeg-location', ffmpeg]
    : [];
}

/**
 * Download a video (H.264/MP4 preferred so WhatsApp accepts it without a
 * transcode) capped by height, size and duration.
 * @returns {Promise<{file:string,profile:string,attempts:Array}>}
 */
async function downloadVideo(url, { height = 720, outBase, maxMB = 300, maxSeconds = 3600, onAttempt, onProgress, deadlineMs } = {}) {
  const ffmpeg = getFfmpeg();
  const ffmpegWorks = getFfmpeg.works();
  const caps = capabilities();
  const base = outBase || path.join(getTempDir(), `video_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
  const h = Number(height) || 720;

  const durationFilter = maxSeconds > 0 && caps.matchFilter
    ? [caps.matchFilter, `duration <?${Math.floor(maxSeconds)}`]
    : [];

  // A video-only stream is worse than useless when ffmpeg is missing: the file
  // arrives without sound. Two hard rules below:
  //   • every selector requires an audio track (vcodec!=none AND acodec!=none)
  //   • merging is only attempted when ffmpeg actually runs on this host
  const sizeFilter = caps.maxFilesize ? ['--max-filesize', `${maxMB}M`] : [];
  const fragments = caps.concurrentFragments
    ? ['--concurrent-fragments', String(Math.max(1, Number(config.ytdlp?.fragments) || 4))]
    : [];

  const progressive = [
    `b[ext=mp4][height<=${h}][vcodec!=none][acodec!=none]`,
    `b[height<=${h}][vcodec!=none][acodec!=none]`,
    'b[vcodec!=none][acodec!=none]',
  ].join('/');

  const merged = [
    `bv*[vcodec^=avc1][height<=${h}]+ba[ext=m4a]/bv*[height<=${h}]+ba`,
    `b[ext=mp4][height<=${h}][vcodec!=none][acodec!=none]`,
    `b[height<=${h}][vcodec!=none][acodec!=none]`,
  ].join('/');

  const argsFor = (selector) => () => [
    '-f', selector,
    ...(ffmpegWorks ? ['--merge-output-format', 'mp4', ...ffmpegLocationArgs(ffmpeg)] : []),
    ...sizeFilter, ...durationFilter, ...fragments,
    '-o', `${base}.%(ext)s`, url,
  ];

  const startedAt = Date.now();
  const totalDeadline = deadlineMs || Number(config.ytdlp?.deadlineMs) || 10 * 60 * 1000;
  const first = await runWithProfiles(url, argsFor(ffmpegWorks ? merged : progressive), {
    onAttempt, onProgress, progress: Boolean(onProgress), deadlineMs: totalDeadline,
  });
  let file = assertProduced(base, first.stdout, 'video');

  if (!ffmpegWorks) return { file, profile: first.profile, attempts: first.attempts, hasAudio: null };

  let info = await probeMedia(file);
  if (!info.probed || info.hasAudio) {
    return { file, profile: first.profile, attempts: first.attempts, hasAudio: info.probed ? true : null };
  }

  // The merge produced a video with no sound: drop it and ask for a stream
  // that carries its own audio (format 18 / 22 style progressive files).
  console.warn('[ytdlp] downloaded video has no audio track — retrying with a progressive (audio+video) stream');
  try { fs.unlinkSync(file); } catch { /* ignore */ }
  const remaining = Math.max(20000, totalDeadline - (Date.now() - startedAt));
  const second = await runWithProfiles(url, argsFor(progressive), {
    onAttempt, onProgress, progress: Boolean(onProgress), deadlineMs: remaining,
  });
  file = assertProduced(base, second.stdout, 'video');
  info = await probeMedia(file);
  if (info.probed && !info.hasAudio) {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
    throw Object.assign(new Error('the downloaded video has no audio track'), { code: 'NO_AUDIO' });
  }
  return { file, profile: second.profile, attempts: [...first.attempts, ...second.attempts], hasAudio: info.probed ? true : null };
}

// ─── DIAGNOSTICS (.ytdl) ──────────────────────────────────────────────────────

async function diagnostics() {
  const cmd = resolveCommand();
  const ff = getFfmpeg();
  let ffVersion = null;
  try {
    const { stdout, stderr } = await execFileAsync(ff, ['-version'], { timeout: 8000 });
    ffVersion = String(stdout || stderr).split('\n')[0].replace(/^ffmpeg version\s*/i, '').split(' ')[0];
  } catch { /* ffmpeg missing */ }

  const caps = capabilities();
  const ci = cookieInfo();

  return {
    installed: Boolean(cmd),
    source: cmd ? cmd.join(' ') : null,
    version: cmd ? probeCommand(cmd) : null,
    ffmpeg: ffVersion,
    cookies: ci.file || (ci.source ? ci.source : null),
    cookieSource: ci.source,
    cookieCount: ci.count,
    cookieAgeMs: ci.mtime ? Date.now() - ci.mtime : null,
    proxy: proxyUrl() || null,
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
    settingsFile: settings.filePath(),
  };
}

module.exports = {
  // helpers
  isYouTubeUrl, extractVideoId, youtubeId, extractUrl, normalizeYouTubeUrl,
  // engine
  resolveCommand, version, ensureInstalled, update, scheduleAutoUpdate, run, spawnYtdlp,
  getInfo, probeRaw, searchVideos, downloadAudio, downloadVideo, runWithProfiles, findProduced,
  ffmpegLocationArgs, assertProduced,
  capabilities, disableImpersonation, setMinimalBaseArgs, usingMinimalBaseArgs,
  // cookies
  setCookies, clearCookies, cookieInfo, cookieFile, hasCookies, normaliseCookieText,
  // errors
  classify, isRetryable, friendlyError, lastError, recordFailure, attemptsSummary,
  // diagnostics
  diagnostics, baseArgs, attemptProfiles, ATTEMPT_PROFILES, installError,
  COOKIE_STORE,
};
