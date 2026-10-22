/**
 * ZaFar Bot — Database
 *
 * Read-through in-memory cache with atomic writes (temp file + rename) and
 * `.bak` last-good recovery via utils/jsonStore.js.
 * Getters return LIVE references — do not mutate them directly, always go
 * through the update* functions.
 */

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic, readJsonSafe } = require('./utils/jsonStore');

const DB_PATH = path.join(__dirname, 'database');
const BOT_STATE_DB = path.join(DB_PATH, 'botstate.json');
const PAPER_LOG_DB = path.join(DB_PATH, 'paper_log.json');

if (!fs.existsSync(DB_PATH)) fs.mkdirSync(DB_PATH, { recursive: true });

const isPlainObject = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v));

const initDB = (filePath, defaultData = {}) => {
  if (!fs.existsSync(filePath) && !fs.existsSync(`${filePath}.bak`)) {
    writeJsonAtomic(filePath, defaultData);
  }
};

initDB(BOT_STATE_DB, { on: true });
initDB(PAPER_LOG_DB, {});

// ─── Core (cached) ────────────────────────────────────────────────────────────

const _defaults = new Map([
  [BOT_STATE_DB, { on: true }],
  [PAPER_LOG_DB, {}],
]);

const _cache = {};
const _lastGood = {};

const readDB = (filePath) => {
  if (!_cache[filePath]) {
    const def = _defaults.get(filePath) || {};
    const res = readJsonSafe(filePath, {
      defaultValue: def,
      validate: isPlainObject,
    });
    if (res.ok) {
      _cache[filePath] = res.data;
      _lastGood[filePath] = JSON.parse(JSON.stringify(res.data));
    } else if (_lastGood[filePath]) {
      console.error(`[DB] Corrupt ${path.basename(filePath)} — keeping in-memory last-good state`);
      _cache[filePath] = JSON.parse(JSON.stringify(_lastGood[filePath]));
    } else {
      console.error(`[DB] Read error (${path.basename(filePath)}): ${res.error?.message || 'corrupt JSON'}`);
      _cache[filePath] = JSON.parse(JSON.stringify(def));
    }
  }
  return _cache[filePath];
};

const writeDB = (filePath, data) => {
  _cache[filePath] = data; // update cache first so readers never see stale data
  _lastGood[filePath] = JSON.parse(JSON.stringify(data));
  try {
    writeJsonAtomic(filePath, data);
    return true;
  } catch (error) {
    console.error(`[DB] Write error (${path.basename(filePath)}): ${error.message}`);
    return false;
  }
};

// ─── Bot State ────────────────────────────────────────────────────────────────

const getBotState = () => {
  const data = readDB(BOT_STATE_DB);
  return data.on !== false;
};

const setBotState = (state) => writeDB(BOT_STATE_DB, { on: Boolean(state) });

// ─── Paper Log ────────────────────────────────────────────────────────────────
// Tracks papers sent per chat to avoid re-sending within 3 days.
// Auto-cleans entries older than 7 days on each write.

const _cleanPaperLog = (log) => {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const chatId of Object.keys(log)) {
    for (const fileId of Object.keys(log[chatId])) {
      if (log[chatId][fileId] < cutoff) delete log[chatId][fileId];
    }
    if (Object.keys(log[chatId]).length === 0) delete log[chatId];
  }
  return log;
};

const logPaperSent = (chatId, fileId) => {
  let log = readDB(PAPER_LOG_DB);
  if (!log[chatId]) log[chatId] = {};
  log[chatId][fileId] = Date.now();
  log = _cleanPaperLog(log);
  return writeDB(PAPER_LOG_DB, log);
};

const wasPaperSentRecently = (chatId, fileId, days = 3) => {
  try {
    const log = readDB(PAPER_LOG_DB);
    if (!log[chatId] || !log[chatId][fileId]) return false;
    const elapsed = Date.now() - log[chatId][fileId];
    return elapsed < days * 24 * 60 * 60 * 1000;
  } catch (_) {
    return false;
  }
};

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  getBotState,
  setBotState,
  logPaperSent,
  wasPaperSentRecently,
};
