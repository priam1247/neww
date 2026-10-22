/**
 * Global Cleanup System
 *
 * Keeps ./temp from growing forever. Two independent brakes:
 *
 *   1. age   — a file older than its threshold is deleted
 *              (downloads 30 min, media jobs 60 min, everything else 6 h)
 *   2. size  — if ./temp is still bigger than TEMP_MAX_MB (default 1024 MB)
 *              the oldest files go first, whatever their age
 *
 * The whole tree is walked, including temp/movies: delivered movies are
 * removed by the delivery path itself (utils/movieHost.release), but a crashed
 * job or a killed download must not leave a 2 GB partial on a 3 GB disk.
 *
 * The WhatsApp session directory is never touched.
 */

const fs = require('fs');
const path = require('path');
const { getTempDir } = require('./tempManager');
const config = require('../config');

// Cleanup interval: 10 minutes
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

// Age thresholds
const SCRAP_AGE_MS = 30 * 60 * 1000;        // download scraps, part files
const MEDIA_AGE_MS = 60 * 60 * 1000;        // ytv_/song_/movie files
const OTHER_AGE_MS = 6 * 60 * 60 * 1000;    // anything else in temp/
const MEDIA_PREFIX = /^(ytv_|song_|dl_|fb_|paper_|conv_|audio_|video_|movie_)/i;

// Size cap for the whole temp tree (0 = no cap)
const TEMP_MAX_MB = Number(process.env.TEMP_MAX_MB || 1024);

// Session directory name (must NOT be cleaned)
const SESSION_DIR_NAME = config.sessionName || 'session';

// Engine bookkeeping that must survive a sweep (small, but they are state)
const KEEP_NAMES = /^(cache\.json|.*\.tmp)$/i;

let cleanupInterval = null;

const thresholdFor = (name) => {
  if (MEDIA_PREFIX.test(name)) return MEDIA_AGE_MS;
  if (/\.(part|ytdl|tmp)$/i.test(name)) return SCRAP_AGE_MS;
  return SCRAP_AGE_MS;
};

/** Every regular file under `dir`, with its size and mtime. */
function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }

  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === SESSION_DIR_NAME) continue;
      walk(p, out);
      continue;
    }
    try {
      const st = fs.statSync(p);
      out.push({ path: p, name: e.name, size: st.size, mtime: st.mtimeMs });
    } catch { /* raced with a delete */ }
  }
  return out;
}

/** Total bytes in the temp tree (used by the boot log and `.moviestatus`). */
function tempUsage() {
  const files = walk(getTempDir());
  return files.reduce((n, f) => n + f.size, 0);
}

function unlink(file) {
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

/**
 * Delete old files, then enforce the size cap.
 * @returns {{files:number, freedBytes:number, remainingBytes:number}}
 */
function cleanupOldFiles() {
  const result = { files: 0, freedBytes: 0, remainingBytes: 0 };
  try {
    const tempDir = getTempDir();
    if (!fs.existsSync(tempDir)) return result;

    const now = Date.now();
    const all = walk(tempDir).filter((f) => !KEEP_NAMES.test(f.name));

    // ── 1. age ────────────────────────────────────────────────────────────
    const survivors = [];
    for (const f of all) {
      if (now - f.mtime > thresholdFor(f.name)) {
        if (unlink(f.path)) { result.files++; result.freedBytes += f.size; }
        else survivors.push(f);
      } else {
        survivors.push(f);
      }
    }

    // ── 2. size cap ───────────────────────────────────────────────────────
    let total = survivors.reduce((n, f) => n + f.size, 0);
    if (TEMP_MAX_MB > 0 && total > TEMP_MAX_MB * 1024 * 1024) {
      survivors.sort((a, b) => a.mtime - b.mtime);       // oldest first
      for (const f of survivors) {
        if (total <= TEMP_MAX_MB * 1024 * 1024) break;
        if (unlink(f.path)) { total -= f.size; result.files++; result.freedBytes += f.size; }
      }
    }

    result.remainingBytes = Math.max(0, total);

    if (result.files > 0) {
      const freedMB = (result.freedBytes / 1048576).toFixed(1);
      const leftMB = (result.remainingBytes / 1048576).toFixed(1);
      console.log(`🧹 Cleanup: removed ${result.files} file(s), freed ${freedMB} MB — temp now ${leftMB} MB`);
    }
  } catch (error) {
    console.error('Error during cleanup:', error.message);
  }
  return result;
}

/**
 * Start the cleanup system
 * Runs cleanup at startup and then every CLEANUP_INTERVAL_MS
 */
function startCleanup() {
  console.log('🧹 Starting temp file cleanup system...');
  const first = cleanupOldFiles();
  console.log(
    `🧹 temp ${(first.remainingBytes / 1048576).toFixed(1)} MB after cleanup` +
    `${TEMP_MAX_MB ? ` (cap ${TEMP_MAX_MB} MB)` : ''}`
  );

  cleanupInterval = setInterval(() => { cleanupOldFiles(); }, CLEANUP_INTERVAL_MS);
  cleanupInterval.unref?.();

  console.log(`✅ Cleanup system started (runs every ${CLEANUP_INTERVAL_MS / 1000 / 60} minutes)`);
}

/** Stop the cleanup system */
function stopCleanup() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    console.log('🛑 Cleanup system stopped');
  }
}

// Handle process termination gracefully
process.on('SIGINT', () => {
  stopCleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopCleanup();
  process.exit(0);
});

module.exports = {
  cleanupOldFiles,
  startCleanup,
  stopCleanup,
  tempUsage,
};
