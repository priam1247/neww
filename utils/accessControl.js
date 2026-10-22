/**
 * ZaFar Bot — Access Control Helpers
 *
 * Shared by handler.js, utils/adminApi.js, utils/allowlistSync.js and
 * commands/admin/users.js.
 *
 * - Atomic whitelist writes (temp file + fsync + rename) with a last-good .bak
 * - Corrupt whitelist.json recovers from .bak or in-memory last-good state and
 *   NEVER silently degrades to "no users" (which would wipe members on the next
 *   allow/sync write).
 */

const fs = require('fs');
const path = require('path');
const { jidVariants } = require('./jid');
const { writeJsonAtomic, readJsonSafe } = require('./jsonStore');

const DB_PATH = path.join(__dirname, '../database');
const WHITELIST_DB = path.join(DB_PATH, 'whitelist.json');

const isValidWL = (d) => Boolean(d && typeof d === 'object' && Array.isArray(d.users));

if (!fs.existsSync(DB_PATH)) fs.mkdirSync(DB_PATH, { recursive: true });
if (!fs.existsSync(WHITELIST_DB) && !fs.existsSync(`${WHITELIST_DB}.bak`)) {
  writeJsonAtomic(WHITELIST_DB, { users: [] });
}

// ─── Whitelist cache (10s TTL) + last-good memory copy ────────────────────────

let _wlCache = null;
let _lastGood = null;
let _wlCorrupt = false;
let _wlTime = 0;
const CACHE_TTL = 10_000;

const clone = (v) => JSON.parse(JSON.stringify(v));

const readWL = ({ force = false, filePath = WHITELIST_DB } = {}) => {
  const isDefaultFile = filePath === WHITELIST_DB;
  if (isDefaultFile && !force && !_wlCorrupt && _wlCache && Date.now() - _wlTime < CACHE_TTL) {
    return _wlCache;
  }

  const res = readJsonSafe(filePath, {
    defaultValue: { users: [] },
    validate: isValidWL,
  });

  if (res.ok) {
    if (!res.exists) {
      try { writeJsonAtomic(filePath, res.data); } catch { /* ignore */ }
    }
    if (isDefaultFile) {
      _wlCache = res.data;
      _lastGood = clone(res.data);
      _wlCorrupt = false;
      _wlTime = Date.now();
    }
    return res.data;
  }

  // Corrupt on disk AND no valid .bak — try in-memory last-good copy first
  if (isDefaultFile && _lastGood && isValidWL(_lastGood)) {
    console.error('[accessControl] whitelist.json corrupted on disk — restoring from in-memory last-good copy');
    try { writeJsonAtomic(filePath, _lastGood); } catch { /* ignore */ }
    _wlCache = clone(_lastGood);
    _wlCorrupt = false;
    _wlTime = Date.now();
    return _wlCache;
  }

  if (isDefaultFile) {
    _wlCorrupt = true;
    _wlCache = null;
  }
  const err = new Error(
    `${path.basename(filePath)} is corrupt and has no valid .bak backup — refusing to treat it as an empty user list`
  );
  err.code = 'WHITELIST_CORRUPT';
  console.error(`[accessControl] ${err.message}`);
  throw err;
};

const writeWL = (data, { filePath = WHITELIST_DB, forceRecovery = false } = {}) => {
  if (!isValidWL(data)) {
    throw new Error('Refusing to write invalid whitelist payload (expected { users: [...] })');
  }
  const isDefaultFile = filePath === WHITELIST_DB;
  if (isDefaultFile && _wlCorrupt && !forceRecovery) {
    const err = new Error('Refusing to overwrite corrupt whitelist.json before manual/backup recovery');
    err.code = 'WHITELIST_CORRUPT';
    throw err;
  }

  writeJsonAtomic(filePath, data);
  if (isDefaultFile) {
    _wlCache = data;
    _lastGood = clone(data);
    _wlCorrupt = false;
    _wlTime = Date.now();
  }
  return true;
};

const _resetCacheForTests = () => {
  _wlCache = null;
  _lastGood = null;
  _wlCorrupt = false;
  _wlTime = 0;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const cleanNumber = (raw) => {
  if (!raw) return null;
  const n = raw.replace(/@.*/, '').replace(/[^0-9]/g, '').trim();
  return n.length >= 7 ? n : null;
};

// Index of the allowed entry that matches any known form (PN or LID) of these JIDs
const findUserIndex = (users, ids) => {
  const v = jidVariants(ids);
  if (!v.size) return -1;
  return users.findIndex(u => v.has(u.number) || (u.alt || []).some(a => v.has(a)));
};

/**
 * Same lookup, but a disabled entry does not count.
 *
 * The dashboard's Allow/Disallow switch writes `enabled: false` instead of
 * deleting the number, so the gate has to skip it — while `.disallow` (which
 * removes the entry) keeps using findUserIndex.
 */
const findAllowedUserIndex = (users, ids) => {
  const idx = findUserIndex(users, ids);
  if (idx === -1) return -1;
  return users[idx].enabled === false ? -1 : idx;
};

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  WHITELIST_DB,
  readWL,
  writeWL,
  cleanNumber,
  findUserIndex,
  findAllowedUserIndex,
  _resetCacheForTests,
};
