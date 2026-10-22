// engine/core/cache.js — TTL maps + disk LRU, persistent across restarts.
//
// Fixed in the ZaFar Bot integration:
//   • the sweep can no longer delete a file that is still being downloaded
//     (active-download set + mtime grace for fresh media files)
//   • LRU eviction only subtracts bytes it actually freed
//   • cache.hit() now bumps the counters that /stats reads
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import { log } from './log.js';
import { emit, EVENTS } from './events.js';
import { metrics } from './metrics.js';

const clog = log.child('cache');
const now = () => Date.now();

// ── TTL maps ───────────────────────────────────────────────────────────────
const meta = new Map();   // key -> { v, exp }
const links = new Map();  // key -> { url, exp }
const neg = new Map();    // key -> exp   (negative caching)
const files = new Map();  // cacheKey -> { file, sizeMB, title, quality, at }

// Files a download is currently writing. A big movie can take 20 minutes; the
// sweeper runs every 30 — without this it unlinks the file mid-transfer and the
// upload that follows fails with ENOENT.
const active = new Set();                       // resolved absolute paths

const MEDIA_EXT = /\.(mp4|mkv|webm|avi|ts|m4v|mov|m4a|mp3|ogg|opus|webp|jpg|jpeg|png|part|tmp)$/i;

export const markActive = (f) => { try { active.add(path.resolve(f)); } catch { /* ignore */ } };
export const unmarkActive = (f) => { try { active.delete(path.resolve(f)); } catch { /* ignore */ } };
export const isActive = (f) => { try { return active.has(path.resolve(f)); } catch { return false; } };

const alive = (exp) => exp > now();
const mget = (k) => { const e = meta.get(k); if (e && alive(e.exp)) return e.v; meta.delete(k); return null; };
const mset = (k, v, h = config.metaTTLHours) => { meta.set(k, { v, exp: now() + h * 3600e3 }); dirty = true; };

const lget = (k) => { const e = links.get(k); if (e && alive(e.exp)) return e.url; links.delete(k); return null; };
const lset = (k, url, h = config.linkTTLHours) => { links.set(k, { url, exp: now() + h * 3600e3 }); dirty = true; };

const nget = (k) => { const e = neg.get(k); if (!e) return false; if (!alive(e)) { neg.delete(k); return false; } return true; };
const nset = (k, min = config.negCacheMinutes) => { neg.set(k, now() + min * 60e3); dirty = true; };
const ndel = (k) => { if (neg.delete(k)) dirty = true; };

// ── disk LRU for finished files ────────────────────────────────────────────
export const keyOf = (id, s, e, q) => `${id}:${s ?? ''}:${e ?? ''}:${q}`;

function fget(k) {
  const v = files.get(k);
  if (!v) return null;
  if (!fs.existsSync(v.file)) { files.delete(k); dirty = true; return null; }
  v.at = now();
  dirty = true;
  return { ...v, cached: true };
}
function fset(k, v) { files.set(k, { ...v, at: now() }); dirty = true; }

/** Drop one entry (and its file) — used after the bot has delivered it. */
function fdel(k) {
  const v = files.get(k);
  if (!v) return false;
  files.delete(k);
  dirty = true;
  try { if (v.file && fs.existsSync(v.file)) fs.unlinkSync(v.file); } catch { /* locked */ }
  return true;
}

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
let initialized = false;
async function init({ installSignalHandlers = true } = {}) {
  // Idempotent: the bot bridge initialises the cache first (no signal
  // handlers), then resolveMovie() booted the engine again and added
  // process.exit handlers that fought utils/cleanup.js.
  if (initialized) return;
  initialized = true;
  fs.mkdirSync(config.tempDir, { recursive: true });
  const restored = restore();
  if (restored) clog.info(`restored ${restored} cache entries from disk`);
  sweep();                                       // clear expired + orphans at boot
  if (!sweepTimer) {
    sweepTimer = setInterval(() => { sweep(); persist(); }, 30 * 60e3);
    sweepTimer.unref?.();
  }
  // Only when the engine owns the process. Embedded in the bot these handlers
  // would fight the bot's own shutdown logic (utils/cleanup.js), so the bridge
  // passes installSignalHandlers:false and the bot keeps full control.
  if (installSignalHandlers) {
    process.on('SIGINT', () => { persist(); process.exit(0); });
    process.on('SIGTERM', () => { persist(); process.exit(0); });
  }
}

async function sweep() {
  const ttl = config.cacheTTLHours * 3600e3;

  // expired file entries
  for (const [k, v] of files) {
    if (isActive(v.file)) continue;                // still downloading
    if (now() - v.at > ttl) { try { fs.unlinkSync(v.file); } catch {} files.delete(k); dirty = true; }
  }

  // expired TTL maps
  for (const [k, e] of meta) if (!alive(e.exp)) { meta.delete(k); dirty = true; }
  for (const [k, e] of links) if (!alive(e.exp)) { links.delete(k); dirty = true; }
  for (const [k, e] of neg) if (!alive(e)) { neg.delete(k); dirty = true; }

  // LRU eviction when over budget — subtract only what was really freed
  let total = duBytes(config.tempDir) / 1048576;
  if (total > config.cacheMaxMB) {
    const oldest = [...files.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [k, v] of oldest) {
      if (total <= config.cacheMaxMB) break;
      if (isActive(v.file)) continue;
      let freedMB = 0;
      try { freedMB = fs.statSync(v.file).size / 1048576; } catch { freedMB = 0; }
      let gone = false;
      try { fs.unlinkSync(v.file); gone = true; } catch { /* locked / already gone */ }
      if (gone) { total -= freedMB; files.delete(k); dirty = true; }
    }
  }

  // orphan sweep: unknown files, but never live downloads, hidden files or
  // fresh media (a partial that can still be resumed).
  try {
    const known = new Set([...files.values()].map(f => path.resolve(f.file)));
    for (const name of fs.readdirSync(config.tempDir)) {
      const p = path.resolve(config.tempDir, name);
      if (known.has(p) || active.has(p) || name.startsWith('.')) continue;
      let st = null;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) continue;
      if (MEDIA_EXT.test(name) && now() - st.mtimeMs < config.partialGraceMs) continue;
      try { fs.unlinkSync(p); } catch {}
    }
  } catch {}
}

function stats() {
  return {
    files: files.size,
    bytes: duBytes(config.tempDir),
    meta: meta.size,
    links: links.size,
    neg: neg.size,
    active: active.size
  };
}

function wipe() {
  for (const v of files.values()) { try { fs.unlinkSync(v.file); } catch {} }
  files.clear(); meta.clear(); links.clear(); neg.clear();
  dirty = true;
  persist();
}

// test hooks (not used in production paths)
export const _internal = { meta, links, neg, files, active, persist, restore, duBytes };

export default {
  init, sweep, stats, wipe, keyOf, persist,
  mget, mset, lget, lset, nget, nset, ndel, fget, fset, fdel, files,
  markActive, unmarkActive, isActive,
  hit(kind, key) {
    metrics.bump(`cache.${kind}`);       // /stats reads these counters
    emit(EVENTS.CACHE_HIT, { kind, key });
  }
};
