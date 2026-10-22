/**
 * ZaFar Bot — Disk quota, host statfs diagnostic, and per-job reservations
 *
 * On Pterodactyl-style shared panels, `fs.statfsSync()` often reports the
 * underlying hypervisor node's free space (hundreds of GB) rather than the
 * container's 10 GB disk quota. We therefore guard against BOTH:
 *   1. The bot's own folder usage (`DISK_BUDGET_MB`, default 9000 MB ≈ 9 GB),
 *   2. Active per-job reservations so concurrent downloads cannot over-commit,
 *   3. `fs.statfsSync()` in case the host filesystem itself is genuinely low.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const log = require('./logger')('diskSpace');

const MB = 1024 * 1024;
const BOT_ROOT = path.resolve(__dirname, '..');
const DYNAMIC_DIRS = new Set(['temp', 'data', 'database', 'session', 'bin']);
const STATIC_CACHE_TTL_MS = 10 * 60 * 1000;

let warnedStatfsUnavailable = false;
let staticCache = { root: null, bytes: 0, at: 0 };

// Active reservations: id -> { id, mb, label, at, tagDir, tagPrefix }
let nextReservationId = 1;
const reservations = new Map();

function walkBytes(targetPath) {
  let st;
  try { st = fs.lstatSync(targetPath); } catch { return 0; }
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size || 0;

  let entries;
  try { entries = fs.readdirSync(targetPath, { withFileTypes: true }); } catch { return 0; }
  let sum = 0;
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const p = path.join(targetPath, e.name);
    if (e.isDirectory()) sum += walkBytes(p);
    else {
      try { sum += fs.statSync(p).size || 0; } catch { /* raced with unlink */ }
    }
  }
  return sum;
}

/**
 * Fast, accurate byte count of the bot's own directory.
 * Static subtrees (`node_modules`, `engine`, `dashboard`, …) are cached for
 * 10 minutes; dynamic subtrees (`temp`, `database`, `session`, `data`, `bin`)
 * and root files are measured fresh on every call.
 */
function folderUsageBytes(rootDir = BOT_ROOT, { forceStatic = false } = {}) {
  const root = path.resolve(rootDir);
  if (root !== BOT_ROOT) return walkBytes(root);

  const now = Date.now();
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return 0; }

  const needStatic = forceStatic || staticCache.root !== root || (now - staticCache.at) > STATIC_CACHE_TTL_MS;
  let staticBytes = needStatic ? 0 : staticCache.bytes;
  let dynamicBytes = 0;

  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      const dynamic = DYNAMIC_DIRS.has(e.name) || e.name === (config.sessionName || 'session');
      if (dynamic) {
        dynamicBytes += walkBytes(full);
      } else if (needStatic) {
        staticBytes += walkBytes(full);
      }
    } else {
      try { dynamicBytes += fs.statSync(full).size || 0; } catch { /* ignore */ }
    }
  }

  if (needStatic) staticCache = { root, bytes: staticBytes, at: now };
  return staticBytes + dynamicBytes;
}

function folderUsageMB(rootDir = BOT_ROOT, opts = {}) {
  return folderUsageBytes(rootDir, opts) / MB;
}

function budgetMB(overrideBudgetMB) {
  if (overrideBudgetMB !== undefined && overrideBudgetMB !== null) {
    const n = Number(overrideBudgetMB);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  const envVal = Number(process.env.DISK_BUDGET_MB ?? config.disk?.budgetMB ?? 9000);
  return Number.isFinite(envVal) && envVal > 0 ? envVal : 9000;
}

function statfsInfo(dir, statfsSync = fs.statfsSync) {
  try {
    const stats = statfsSync(dir);
    const availBlocks = Number(stats.bavail ?? stats.bfree);
    const totalBlocks = Number(stats.blocks ?? availBlocks);
    const blockSize = Number(stats.bsize);
    if (!Number.isFinite(availBlocks) || !Number.isFinite(blockSize)) {
      throw new Error('invalid statfs result');
    }
    return {
      freeMB: (availBlocks * blockSize) / MB,
      totalMB: Number.isFinite(totalBlocks) ? (totalBlocks * blockSize) / MB : null,
    };
  } catch (error) {
    if (!warnedStatfsUnavailable) {
      warnedStatfsUnavailable = true;
      log.warn('statfs unavailable; relying on bot folder disk budget', error);
    }
    return { freeMB: null, totalMB: null };
  }
}

function freeMB(dir, statfsSync = fs.statfsSync) {
  return statfsInfo(dir, statfsSync).freeMB;
}

/** Bytes already written on disk for a reservation's prefix, to avoid double counting. */
function writtenForReservationMB(entry) {
  if (!entry.tagDir || !entry.tagPrefix) return 0;
  let entries;
  try { entries = fs.readdirSync(entry.tagDir, { withFileTypes: true }); } catch { return 0; }
  let bytes = 0;
  for (const e of entries) {
    if (!e.name.startsWith(entry.tagPrefix)) continue;
    const p = path.join(entry.tagDir, e.name);
    bytes += walkBytes(p);
  }
  return bytes / MB;
}

function reservedMB() {
  let total = 0;
  for (const entry of reservations.values()) {
    const alreadyOnDisk = writtenForReservationMB(entry);
    total += Math.max(0, entry.mb - alreadyOnDisk);
  }
  return total;
}

function activeReservations() {
  return [...reservations.values()].map((r) => ({
    id: r.id,
    mb: r.mb,
    label: r.label,
    at: r.at,
  }));
}

/**
 * Full disk picture comparing the bot's 9 GB folder budget against `statfs`.
 */
function inspectDisk(dir = BOT_ROOT, { rootDir = BOT_ROOT, budget, statfsSync = fs.statfsSync } = {}) {
  const capMB = budgetMB(budget);
  const usedMB = folderUsageMB(rootDir);
  const heldMB = reservedMB();
  const sf = statfsInfo(dir, statfsSync);

  const budgetLeftMB = capMB > 0 ? Math.max(0, capMB - usedMB - heldMB) : Infinity;
  const statfsLeftMB = sf.freeMB != null ? Math.max(0, sf.freeMB - heldMB) : Infinity;
  const effectiveFreeMB = Math.min(budgetLeftMB, statfsLeftMB);

  // On shared Pterodactyl nodes statfs.totalMB is typically 100 GB – 4 TB even
  // on a 10 GB plan. Flag that explicitly so the boot log answers Phase 2 #5.
  const statfsSeesHostNode = Boolean(
    capMB > 0 && sf.totalMB != null && sf.totalMB > capMB * 2
  );

  return {
    folderUsedMB: usedMB,
    budgetMB: capMB,
    reservedMB: heldMB,
    reservationCount: reservations.size,
    budgetFreeMB: Number.isFinite(budgetLeftMB) ? budgetLeftMB : null,
    statfsFreeMB: sf.freeMB,
    statfsTotalMB: sf.totalMB,
    statfsSeesHostNode,
    effectiveFreeMB: Number.isFinite(effectiveFreeMB) ? effectiveFreeMB : null,
  };
}

function requireFreeSpace(dir, requiredMB, statfsSync = fs.statfsSync, opts = {}) {
  const need = Math.max(0, Number(requiredMB) || 0);
  // Preserve pure statfs unit-test semantics when a synthetic statfsSync is passed without rootDir
  const customStatfsOnly = statfsSync !== fs.statfsSync && !opts.rootDir && opts.budget === undefined;
  if (customStatfsOnly) {
    const free = freeMB(dir, statfsSync);
    const held = reservedMB();
    if (free == null) return { freeMB: null, requiredMB: need, skipped: true };
    const avail = Math.max(0, free - held);
    if (avail < need) {
      throw Object.assign(
        new Error(`not enough disk (${(avail / 1024).toFixed(1)} GB free; need ${Math.ceil(need)} MB)`),
        { code: 'NOT_ENOUGH_DISK' },
      );
    }
    return { freeMB: avail, requiredMB: need };
  }

  const info = inspectDisk(dir, { rootDir: opts.rootDir || BOT_ROOT, budget: opts.budget, statfsSync });
  if (info.effectiveFreeMB == null) return { freeMB: null, requiredMB: need, skipped: true };

  if (info.effectiveFreeMB < need) {
    const reservedNote = info.reservedMB > 0
      ? `, ${(info.reservedMB / 1024).toFixed(1)} GB reserved by ${info.reservationCount} running job(s)`
      : '';
    throw Object.assign(
      new Error(
        `not enough disk (${(info.effectiveFreeMB / 1024).toFixed(1)} GB free${reservedNote}; need ${Math.ceil(need)} MB)`
      ),
      { code: 'NOT_ENOUGH_DISK' },
    );
  }
  return { freeMB: info.effectiveFreeMB, requiredMB: need, info };
}

/**
 * Check space AND reserve `requiredMB` until the returned `release()` function
 * is called, preventing concurrent movies/downloads from over-committing disk.
 */
function reserveSpace(dir, requiredMB, {
  label = 'job',
  tagDir = null,
  tagPrefix = null,
  rootDir,
  budget,
  statfsSync = fs.statfsSync,
} = {}) {
  const need = Math.max(0, Number(requiredMB) || 0);
  requireFreeSpace(dir, need, statfsSync, { rootDir, budget });

  const id = nextReservationId++;
  const entry = {
    id,
    mb: need,
    label,
    at: Date.now(),
    tagDir,
    tagPrefix,
  };
  reservations.set(id, entry);

  let released = false;
  const release = () => {
    if (released) return false;
    released = true;
    return reservations.delete(id);
  };
  const update = (nextMB) => {
    if (released || !reservations.has(id)) return;
    entry.mb = Math.max(0, Number(nextMB) || 0);
  };

  return { id, mb: need, release, update };
}

function movieRequiredMB(sizeMB, options = {}) {
  const size = Number(sizeMB) > 0 ? Number(sizeMB) : Number(options.unknownSizeMB ?? 2000);
  const multiplier = Number(options.diskSizeMultiplier ?? 1.5);
  const overhead = Number(options.diskOverheadMB ?? 400);
  const floor = Number(options.minFreeMB ?? 800);
  return Math.max(floor, size * multiplier + overhead);
}

function requireMovieSpace(dir, sizeMB, options = {}, statfsSync = fs.statfsSync, extraOpts = {}) {
  return requireFreeSpace(dir, movieRequiredMB(sizeMB, options), statfsSync, extraOpts);
}

function reserveMovieSpace(dir, sizeMB, options = {}, reserveOpts = {}) {
  return reserveSpace(dir, movieRequiredMB(sizeMB, options), reserveOpts);
}

function requireMediaDownloadSpace(dir, media = {}, statfsSync = fs.statfsSync, extraOpts = {}) {
  return requireFreeSpace(dir, Number(media.diskMinFreeMB ?? 1200), statfsSync, extraOpts);
}

function reserveMediaSpace(dir, media = {}, reserveOpts = {}) {
  return reserveSpace(dir, Number(media.diskMinFreeMB ?? 1200), reserveOpts);
}

function requireMediaCopySpace(dir, sizeMB, media = {}, statfsSync = fs.statfsSync, extraOpts = {}) {
  const multiplier = Number(media.diskCopyMultiplier ?? 1.2);
  const overhead = Number(media.diskCopyOverheadMB ?? 300);
  return requireFreeSpace(dir, Number(sizeMB) * multiplier + overhead, statfsSync, extraOpts);
}

function _clearReservationsForTests() {
  reservations.clear();
  staticCache = { root: null, bytes: 0, at: 0 };
}

module.exports = {
  BOT_ROOT,
  folderUsageBytes,
  folderUsageMB,
  budgetMB,
  statfsInfo,
  freeMB,
  reservedMB,
  activeReservations,
  inspectDisk,
  requireFreeSpace,
  reserveSpace,
  movieRequiredMB,
  requireMovieSpace,
  reserveMovieSpace,
  requireMediaDownloadSpace,
  reserveMediaSpace,
  requireMediaCopySpace,
  _clearReservationsForTests,
};
