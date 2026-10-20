/**
 * ZaFar Bot — Access Control Helpers
 *
 * Shared by handler.js and commands/admin/users.js
 *
 * - Whitelist read/write with 10s in-memory cache
 */

const fs   = require('fs');
const path = require('path');
const { jidVariants } = require('./jid');

const DB_PATH      = path.join(__dirname, '../database');
const WHITELIST_DB = path.join(DB_PATH, 'whitelist.json');

if (!fs.existsSync(DB_PATH))      fs.mkdirSync(DB_PATH, { recursive: true });
if (!fs.existsSync(WHITELIST_DB)) fs.writeFileSync(WHITELIST_DB, JSON.stringify({ users: [] }, null, 2));

// ─── Whitelist cache (10s TTL) ────────────────────────────────────────────────

let _wlCache = null;
let _wlTime  = 0;
const CACHE_TTL = 10_000;

const readWL = () => {
  if (_wlCache && Date.now() - _wlTime < CACHE_TTL) return _wlCache;
  try {
    _wlCache = JSON.parse(fs.readFileSync(WHITELIST_DB, 'utf-8'));
  } catch (_) {
    _wlCache = { users: [] };
  }
  _wlTime = Date.now();
  return _wlCache;
};

const writeWL = (data) => {
  _wlCache = data;
  _wlTime  = Date.now();
  fs.writeFileSync(WHITELIST_DB, JSON.stringify(data, null, 2));
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

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { readWL, writeWL, cleanNumber, findUserIndex };
