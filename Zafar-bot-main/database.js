/**
 * ZaFar Bot — Database
 *
 * Read-through in-memory cache: this bot is a single process, so every JSON
 * file is parsed once and then served from RAM; every mutation writes through
 * to disk immediately. Getters return LIVE references — do not mutate them
 * directly, always go through the update* functions.
 */

const fs   = require('fs');
const path = require('path');

const DB_PATH      = path.join(__dirname, 'database');
const BOT_STATE_DB = path.join(DB_PATH, 'botstate.json');
const PAPER_LOG_DB = path.join(DB_PATH, 'paper_log.json');

if (!fs.existsSync(DB_PATH)) fs.mkdirSync(DB_PATH, { recursive: true });

const initDB = (filePath, defaultData = {}) => {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2));
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

const readDB = (filePath) => {
  if (!_cache[filePath]) {
    try {
      _cache[filePath] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (error) {
      console.error(`[DB] Read error (${path.basename(filePath)}): ${error.message}`);
      _cache[filePath] = JSON.parse(JSON.stringify(_defaults.get(filePath) || {}));
    }
  }
  return _cache[filePath];
};

const writeDB = (filePath, data) => {
  _cache[filePath] = data; // update cache first so readers never see stale data
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
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
