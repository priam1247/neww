// src/core/cache.js — three TTL maps + disk LRU, ALL persistent across restarts.
// 2.0 kept these in bare Maps: every restart lost link/meta caches AND leaked
// downloaded files on disk. 3.0 snapshots to JSON atomically and rebuilds the
// file index from the snapshot at boot, sweeping orphans it doesn't own.
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import { log } from './log.js';
import { emit, EVENTS } from './events.js';

const clog = log.child('cache');
const now = () => Date.now();

// ── TTL maps ───────────────────────────────────────────────────────────────
const meta = new Map();   // key -> { v, exp }
const links = new Map();  // key -> { url, exp }
const neg = new Map();    // key -> exp   (negative caching)
const files = new Map();  // cacheKey -> { file, sizeMB, title, quality, at }

const alive = (exp) => exp > now();
const mget = (k) => { const e = meta.get(k); if (e && alive(e.exp)) return e.v; meta.delete(k); return null; };
const mset = (k, v, h = config.metaTTLHours) => { meta.set(k, { v, exp: now() + h * 3600e3 }); dirty = true; };

const lget = (k) => { const e = links.get(k); if (e && alive(e.exp)) return e.url; links.delete(k); return null; };
const lset = (k, url, h = config.linkTTLHours) => { links.set(k, { url, exp: now() + h * 3600e3 }); dirty = true; };

const nget = (k) => { const e = neg.get(k); if (!e) return false; if (!alive(e)) { neg.delete(k); return false; } return true; };
const nset = (k, min = config.negCacheMinutes) => { neg.set(k, now() + min * 60e3); dirty = true; };

// ── disk LRU for finished files ────────────────────────────────────────────
export const keyOf = (imdbId, s, e, q) => `${imdbId}:${s ?? ''}:${e ?? ''}:${q}`;

function fget(k) {
  const v = files.get(k);
  if (!v) return null;
  if (!fs.existsSync(v.file)) { files.delete(k); dirty = true; return null; }
  v.at = now();
  return { ...v, cached: true };
}
function fset(k, v) { files.set(k, { ...v, at: now() }); dirty = true; }

// ── persistence (atomic write + boot restore) ──────────────────────────────
let dirty = false;
let sweepTimer = null;

function snapshot() {
  return JSON.stringify({
    v: 3,
    meta: [...meta].filter(([, e]) => alive(e.exp)),
    links: [...links].filter(([, e]) => alive(e.exp)),
    neg: [...neg].filter(([, e]) => alive(e)),
    files: [...files].filter(([, f]) => { try { return fs.existsSync(f.file); } catch { return false; } })
  });
}

function persist() {
  if (!dirty) return;
  try {
    fs.mkdirSync(path.dirname(config.cacheFile), { recursive: true });
    const tmp = `${config.cacheFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, snapshot());
    fs.renameSync(tmp, config.cacheFile);        // atomic on POSIX
    dirty = false;
  } catch (e) { clog.warn('persist failed:', e.message); }
}

function restore() {
  try {
    if (!fs.existsSync(config.cacheFile)) return 0;
    const d = JSON.parse(fs.readFileSync(config.cacheFile, 'utf8'));
    if (d.v !== 3) return 0;
    for (const [k, v] of d.meta || []) meta.set(k, v);
    for (const [k, v] of d.links || []) links.set(k, v);
    for (const [k, v] of d.neg || []) neg.set(k, v);
    for (const [k, v] of d.files || []) files.set(k, v);
    return (d.meta?.length || 0) + (d.links?.length || 0) + (d.files?.length || 0);
  } catch { return 0; }
}

// ── disk usage helpers ─────────────────────────────────────────────────────
function duBytes(dir) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { total += fs.statSync(p).size; } catch {} }
    }
  };
  walk(dir);
  return total;
}

// ── lifecycle ──────────────────────────────────────────────────────────────
async function init() {
  fs.mkdirSync(config.tempDir, { recursive: true });
  const restored = restore();
  if (restored) clog.info(`restored ${restored} cache entries from disk`);
  sweep();                                       // clear expired + orphans at boot
  sweepTimer = setInterval(() => { sweep(); persist(); }, 30 * 60e3);
  sweepTimer.unref?.();
  process.on('SIGINT', () => { persist(); process.exit(0); });
  process.on('SIGTERM', () => { persist(); process.exit(0); });
}

async function sweep() {
  const ttl = config.cacheTTLHours * 3600e3;

  // expired file entries
  for (const [k, v] of files) {
    if (now() - v.at > ttl) { try { fs.unlinkSync(v.file); } catch {} files.delete(k); dirty = true; }
  }

  // expired TTL maps
  for (const [k, e] of meta) if (!alive(e.exp)) { meta.delete(k); dirty = true; }
  for (const [k, e] of links) if (!alive(e.exp)) { links.delete(k); dirty = true; }
  for (const [k, e] of neg) if (!alive(e)) { neg.delete(k); dirty = true; }

  // LRU eviction when over budget
  let total = duBytes(config.tempDir) / 1048576;
  if (total > config.cacheMaxMB) {
    for (const [k, v] of [...files.entries()].sort((a, b) => a[1].at - b[1].at)) {
      if (total <= config.cacheMaxMB) break;
      try { fs.unlinkSync(v.file); total -= v.sizeMB || 0; } catch {}
      files.delete(k); dirty = true;
    }
  }

  // orphan sweep: files on disk that the index doesn't know about
  try {
    const known = new Set([...files.values()].map(f => path.resolve(f.file)));
    for (const name of fs.readdirSync(config.tempDir)) {
      const p = path.resolve(config.tempDir, name);
      if (!known.has(p)) { try { fs.unlinkSync(p); } catch {} }
    }
  } catch {}
}

function stats() {
  return {
    files: files.size,
    bytes: duBytes(config.tempDir),
    meta: meta.size,
    links: links.size,
    neg: neg.size
  };
}

function wipe() {
  for (const v of files.values()) { try { fs.unlinkSync(v.file); } catch {} }
  files.clear(); meta.clear(); links.clear(); neg.clear();
  dirty = true;
  persist();
}

// test hooks (not used in production paths)
export const _internal = { meta, links, neg, files, persist, restore, duBytes };

export default {
  init, sweep, stats, wipe, keyOf, persist,
  mget, mset, lget, lset, nget, nset, fget, fset, files,
  hit(kind, key) { emit(EVENTS.CACHE_HIT, { kind, key }); }
};
