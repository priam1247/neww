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
  proxy: '',              // e.g. http://user:pass@host:port (overrides config.ytdlp.proxy)
  songSendAs: '',         // '' = use config, 'audio' | 'document'
  videoQuality: 0,        // 0 = use config.video.defaultQuality
  remoteFallback: true,   // use remote downloader APIs when yt-dlp fails
  cobaltInstances: [],    // extra cobalt API instances (base URLs)
  preferEngine: '',       // '' | 'ytdlp' | 'remote' — force a starting engine
  searchPicker: null,     // null = use config.search.picker; true shows the numbered list
};

let _cache = null;
const isPlainObject = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v));

const filePath = () => FILE;

function read() {
  if (_cache) return _cache;
  const res = readJsonSafe(FILE, { defaultValue: {}, validate: isPlainObject });
  if (!res.ok) {
    console.warn('[mediaSettings] unreadable settings file, using defaults:', res.error?.message);
  }
  _cache = { ...DEFAULTS, ...(res.ok ? res.data : {}) };
  return _cache;
}

function write(next) {
  _cache = { ...DEFAULTS, ...(next || {}) };
  try {
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
    writeJsonAtomic(FILE, _cache);
  } catch (e) {
    console.error('[mediaSettings] could not save settings:', e.message);
  }
  return _cache;
}

const get = (key, fallback) => {
  const v = read()[key];
  return v === undefined || v === null || v === '' ? fallback : v;
};

const set = (key, value) => {
  if (!(key in DEFAULTS)) throw new Error(`Unknown setting: ${key}`);
  const next = { ...read(), [key]: value };
  write(next);
  return next[key];
};

const all = () => ({ ...read() });

const reset = (key) => {
  if (key) return set(key, DEFAULTS[key]);
  return write({});
};

module.exports = { get, set, all, reset, DEFAULTS, filePath };
