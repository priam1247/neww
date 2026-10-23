/**
 * ZaFar Bot — Media runtime settings
 *
 * Small JSON store (database/media_settings.json) for things the owner may want
 * to change *without* editing files on the host — the usual reason .song/.ytv
 * "just fail" is that the host has no cookies and no proxy, and the owner has
 * no way to add them from WhatsApp.
 *
 *   .ytdl proxy <url|off>     → settings.proxy
 *   .cookies set              → settings.cookiesSource (managed by youtubedl.js)
 *   .song ... audio           → settings.songSendAs
 *
 * Precedence is always: runtime setting → config.js / environment → default.
 */

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic, readJsonSafe } = require('./jsonStore');

const DB_DIR = path.join(__dirname, '..', 'database');
const FILE = path.join(DB_DIR, 'media_settings.json');

const DEFAULTS = {
  proxy: '',              // e.g. http://user:pass@198.51.100.10:8080 (overrides config.ytdlp.proxy)
  songSendAs: '',         // '' = use config, 'audio' | 'document'
  videoQuality: 0,        // 0 = use config.video.defaultQuality
  remoteFallback: true,   // use remote downloader APIs when yt-dlp fails
  cobaltInstances: [],    // extra cobalt API instances (base URLs)
  preferEngine: '',       // '' | 'ytdlp' | 'innertube' | 'remote' — force a starting engine
  searchPicker: null,     // null = use config.search.picker; true shows the numbered list
};

const PLACEHOLDER_HOSTS = new Set([
  'host',
  'hostname',
  'proxy',
  'us-proxy',
  'eu-proxy',
  'uk-proxy',
  'your-proxy',
  'proxy-host',
  'proxyhost',
  'proxyserver',
  'proxy-server',
  'server',
  'ip',
  'your-ip',
  'example',
  'example.com',
  'example.org',
  'example.net',
  'proxy.example.com',
]);

/**
 * Validate a proxy URL for yt-dlp / HTTP clients.
 * Catches documentation placeholders such as `http://user:pass@us-proxy:port`
 * before they break every yt-dlp invocation with `nonnumeric port: 'port'`.
 *
 * @param {string} raw
 * @returns {{ ok: boolean, empty?: boolean, placeholder?: boolean, url?: string, reason?: string }}
 */
function validateProxyUrl(raw) {
  const input = String(raw ?? '').trim();
  if (!input) return { ok: false, empty: true, reason: 'empty proxy URL' };

  if (/\s/.test(input) || /[<>]/.test(input)) {
    return { ok: false, placeholder: true, reason: 'contains spaces or template brackets' };
  }

  const schemeMatch = input.match(/^(https?|socks4a?|socks5h?):\/\/(.+)$/i);
  if (!schemeMatch) {
    return { ok: false, reason: 'scheme must be http://, https://, socks4://, or socks5://' };
  }

  const scheme = schemeMatch[1].toLowerCase();
  const rest = schemeMatch[2];
  const authority = rest.split(/[/?#]/)[0] || '';
  const atIdx = authority.lastIndexOf('@');
  const hostPort = atIdx !== -1 ? authority.slice(atIdx + 1) : authority;
  if (!hostPort) {
    return { ok: false, reason: 'missing proxy host' };
  }

  // Inspect explicit port before `new URL()` so `:port` gives an exact reason.
  let rawHost = hostPort;
  let rawPort = '';
  if (hostPort.startsWith('[')) {
    const closeIdx = hostPort.indexOf(']');
    if (closeIdx === -1) return { ok: false, reason: 'unclosed IPv6 address' };
    rawHost = hostPort.slice(0, closeIdx + 1);
    const tail = hostPort.slice(closeIdx + 1);
    if (tail.startsWith(':')) rawPort = tail.slice(1);
    else if (tail) return { ok: false, reason: 'invalid host:port syntax' };
  } else {
    const colonIdx = hostPort.lastIndexOf(':');
    if (colonIdx !== -1) {
      rawHost = hostPort.slice(0, colonIdx);
      rawPort = hostPort.slice(colonIdx + 1);
    }
  }

  if (!rawHost) {
    return { ok: false, reason: 'missing proxy host' };
  }

  if (rawPort !== '') {
    if (!/^\d+$/.test(rawPort)) {
      return {
        ok: false,
        placeholder: rawPort.toLowerCase() === 'port',
        reason: `non-numeric port '${rawPort}'`,
      };
    }
    const portNum = Number(rawPort);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return { ok: false, reason: `port ${rawPort} out of range (1–65535)` };
    }
  }

  const cleanHost = rawHost.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    PLACEHOLDER_HOSTS.has(cleanHost) ||
    cleanHost.endsWith('.example.com') ||
    cleanHost.endsWith('.example.org') ||
    cleanHost.endsWith('.example.net')
  ) {
    return { ok: false, placeholder: true, reason: `placeholder host '${cleanHost}'` };
  }

  // Parse via WHATWG URL (map socks* to http temporarily for uniform parsing).
  try {
    const parseable = `http://${ rest }`;
    const parsed = new URL(parseable);
    if (!parsed.hostname) return { ok: false, reason: 'missing proxy hostname' };
  } catch {
    return { ok: false, reason: 'malformed proxy URL' };
  }

  return { ok: true, url: `${scheme}://${rest}` };
}

let _cache = null;
const isPlainObject = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v));

const filePath = () =>
  process.env.MEDIA_SETTINGS_FILE ? path.resolve(process.env.MEDIA_SETTINGS_FILE) : FILE;

function write(next) {
  const target = filePath();
  _cache = { ...DEFAULTS, ...(next || {}) };
  try {
    const dir = path.dirname(target);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    writeJsonAtomic(target, _cache);
  } catch (e) {
    console.error('[mediaSettings] could not save settings:', e.message);
  }
  return _cache;
}

function read() {
  if (_cache) return _cache;
  const target = filePath();
  const res = readJsonSafe(target, { defaultValue: {}, validate: isPlainObject });
  if (!res.ok) {
    console.warn('[mediaSettings] unreadable settings file, using defaults:', res.error?.message);
  }
  const merged = { ...DEFAULTS, ...(res.ok ? res.data : {}) };

  // Self-heal poisoned runtime proxy values (e.g. `http://user:pass@us-proxy:port`
  // left in database/media_settings.json from earlier builds).
  if (merged.proxy && !validateProxyUrl(merged.proxy).ok) {
    const check = validateProxyUrl(merged.proxy);
    console.warn(`[mediaSettings] clearing invalid stored proxy (${check.reason})`);
    merged.proxy = '';
    _cache = merged;
    write(merged);
    return _cache;
  }

  _cache = merged;
  return _cache;
}

const get = (key, fallback) => {
  const v = read()[key];
  return v === undefined || v === null || v === '' ? fallback : v;
};

const set = (key, value) => {
  if (!(key in DEFAULTS)) throw new Error(`Unknown setting: ${key}`);
  let normalized = value;
  if (key === 'proxy') {
    const trimmed = String(value ?? '').trim();
    if (trimmed) {
      const check = validateProxyUrl(trimmed);
      if (!check.ok) {
        const err = new Error(`Invalid proxy URL: ${check.reason}`);
        err.code = 'INVALID_PROXY';
        err.reason = check.reason;
        throw err;
      }
      normalized = check.url;
    } else {
      normalized = '';
    }
  }
  const next = { ...read(), [key]: normalized };
  write(next);
  return next[key];
};

const all = () => ({ ...read() });

const reset = (key) => {
  if (key) return set(key, DEFAULTS[key]);
  return write({});
};

/** Force reload from disk (used by tests when mutating media_settings.json directly). */
const reload = () => {
  _cache = null;
  return read();
};

module.exports = { get, set, all, reset, reload, validateProxyUrl, DEFAULTS, filePath };
