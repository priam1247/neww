/**
 * ZaFar Bot — Disk Guard (replaces the old RAM watchdog)
 *
 * On shared panels (10 GB quota, ~400 MB RAM use), disk — not V8 heap — is the
 * real limit, and `fs.statfsSync()` usually sees the whole hypervisor node
 * instead of the container's 10 GB quota.
 *
 * This guard:
 *   1. Logs both the bot's own folder size against `DISK_BUDGET_MB` (~9 GB) AND
 *      what `statfs` reports at boot so you can compare them against the panel.
 *   2. Checks folder usage every 60s and triggers normal or tight temp sweeps
 *      (never touching held active jobs, `session/`, or `database/`) before the
 *      container hits quota.
 */

'use strict';

const { inspectDisk, BOT_ROOT } = require('./diskSpace');
const { cleanupOldFiles } = require('./cleanup');

const WARN_RATIO = 0.75;      // 75% (~6.75 GB of 9 GB) -> normal sweep
const TIGHT_RATIO = 0.88;     // 88% (~7.9 GB of 9 GB)  -> tight temp cap sweep
const CHECK_INTERVAL_MS = 60_000;

let guardTimer = null;

function formatBootComparison(info) {
  const folderLine = `folder ${info.folderUsedMB.toFixed(1)} MB / ${info.budgetMB} MB budget` +
    (info.budgetFreeMB != null ? ` (${(info.budgetFreeMB / 1024).toFixed(2)} GB left)` : '');

  if (info.statfsFreeMB == null) {
    return `[DISK] ${folderLine} · statfs unavailable (using folder budget)`;
  }

  const freeGB = (info.statfsFreeMB / 1024).toFixed(1);
  const totalGB = info.statfsTotalMB != null ? (info.statfsTotalMB / 1024).toFixed(1) : '?';
  const verdict = info.statfsSeesHostNode
    ? 'sees host node disk, NOT panel quota — enforcing folder budget'
    : 'matches container quota';

  return `[DISK] ${folderLine} · statfs ${freeGB} GB free / ${totalGB} GB total (${verdict})`;
}

function checkOnce(opts = {}) {
  const info = inspectDisk(opts.dir || BOT_ROOT, opts);
  if (!info.budgetMB) return { action: 'none', info };

  const committedMB = info.folderUsedMB + info.reservedMB;
  const ratio = committedMB / info.budgetMB;

  if (ratio >= TIGHT_RATIO) {
    console.warn(
      `[DISK] 🟠 ${info.folderUsedMB.toFixed(0)} MB used + ${info.reservedMB.toFixed(0)} MB reserved / ` +
      `${info.budgetMB} MB (${(ratio * 100).toFixed(1)}%) — running tight temp sweep`
    );
    cleanupOldFiles(null, { maxMB: 256 });
    if (typeof global.gc === 'function') global.gc();
    return { action: 'tight', info };
  }

  if (ratio >= WARN_RATIO) {
    console.warn(
      `[DISK] 🟡 ${info.folderUsedMB.toFixed(0)} MB used + ${info.reservedMB.toFixed(0)} MB reserved / ` +
      `${info.budgetMB} MB (${(ratio * 100).toFixed(1)}%) — sweeping old temp files`
    );
    cleanupOldFiles();
    return { action: 'warn', info };
  }

  return { action: 'ok', info };
}

function startDiskGuard(opts = {}) {
  const info = inspectDisk(opts.dir || BOT_ROOT, opts);
  console.log(formatBootComparison(info));

  if (guardTimer) clearInterval(guardTimer);
  guardTimer = setInterval(() => {
    try { checkOnce(opts); } catch (e) { console.error('[DISK] check error:', e.message); }
  }, Number(opts.intervalMs) || CHECK_INTERVAL_MS);
  guardTimer.unref?.();
  return guardTimer;
}

function stopDiskGuard() {
  if (guardTimer) {
    clearInterval(guardTimer);
    guardTimer = null;
  }
}

module.exports = {
  startDiskGuard,
  stopDiskGuard,
  checkOnce,
  formatBootComparison,
};
