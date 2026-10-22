const fs = require('fs');
const log = require('./logger')('diskSpace');

const MB = 1024 * 1024;
let warnedStatfsUnavailable = false;

function freeMB(dir, statfsSync = fs.statfsSync) {
  try {
    const stats = statfsSync(dir);
    const blocks = Number(stats.bavail ?? stats.bfree);
    const blockSize = Number(stats.bsize);
    if (!Number.isFinite(blocks) || !Number.isFinite(blockSize)) throw new Error('invalid statfs result');
    return blocks * blockSize / MB;
  } catch (error) {
    if (!warnedStatfsUnavailable) {
      warnedStatfsUnavailable = true;
      log.warn('statfs unavailable; allowing media job to continue', error);
    }
    return null;
  }
}

function requireFreeSpace(dir, requiredMB, statfsSync = fs.statfsSync) {
  const free = freeMB(dir, statfsSync);
  if (free == null) return { freeMB: null, requiredMB, skipped: true };
  if (free < requiredMB) {
    throw Object.assign(
      new Error(`not enough disk (${(free / 1024).toFixed(1)} GB free; need ${Math.ceil(requiredMB)} MB)`),
      { code: 'NOT_ENOUGH_DISK' },
    );
  }
  return { freeMB: free, requiredMB };
}

function requireMovieSpace(dir, sizeMB, options = {}, statfsSync = fs.statfsSync) {
  const size = Number(sizeMB) > 0 ? Number(sizeMB) : Number(options.unknownSizeMB ?? 2000);
  const multiplier = Number(options.diskSizeMultiplier ?? 2);
  const overhead = Number(options.diskOverheadMB ?? 500);
  const floor = Number(options.minFreeMB ?? 800);
  return requireFreeSpace(dir, Math.max(floor, size * multiplier + overhead), statfsSync);
}

function requireMediaDownloadSpace(dir, media = {}, statfsSync = fs.statfsSync) {
  return requireFreeSpace(dir, Number(media.diskMinFreeMB ?? 1500), statfsSync);
}

function requireMediaCopySpace(dir, sizeMB, media = {}, statfsSync = fs.statfsSync) {
  const multiplier = Number(media.diskCopyMultiplier ?? 1.2);
  const overhead = Number(media.diskCopyOverheadMB ?? 300);
  return requireFreeSpace(dir, Number(sizeMB) * multiplier + overhead, statfsSync);
}

module.exports = { freeMB, requireFreeSpace, requireMovieSpace, requireMediaDownloadSpace, requireMediaCopySpace };
