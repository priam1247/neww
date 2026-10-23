'use strict';

const path = require('path');
const { readJsonSafe, writeJsonAtomic } = require('./jsonStore');

const DEFAULT_FILE = path.join(__dirname, '..', 'database', 'telemetry.json');
const BOOT_AT = Date.now();

let storeFile = DEFAULT_FILE;
let loaded = false;
let flushTimer = null;

const state = {
  commandsTotal: 0,
  downloadsSuccess: 0,
  failedTotal: 0,
  updatedAt: BOOT_AT,
};

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  if (!storeFile) return;
  const { data } = readJsonSafe(storeFile, { fallback: {} });
  if (data && typeof data === 'object') {
    state.commandsTotal = Math.max(0, Number(data.commandsTotal) || 0);
    state.downloadsSuccess = Math.max(0, Number(data.downloadsSuccess) || 0);
    state.failedTotal = Math.max(0, Number(data.failedTotal) || 0);
  }
}

function flushNow() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!storeFile) return;
  try {
    writeJsonAtomic(storeFile, {
      commandsTotal: state.commandsTotal,
      downloadsSuccess: state.downloadsSuccess,
      failedTotal: state.failedTotal,
      updatedAt: state.updatedAt,
    });
  } catch {
    /* non-fatal */
  }
}

function scheduleFlush() {
  state.updatedAt = Date.now();
  if (!storeFile || flushTimer) return;
  flushTimer = setTimeout(flushNow, 1500);
  if (flushTimer && typeof flushTimer.unref === 'function') flushTimer.unref();
}

function recordCommand() {
  ensureLoaded();
  state.commandsTotal += 1;
  scheduleFlush();
}

function recordDownloadSuccess(_kind, count = 1) {
  ensureLoaded();
  const n = Math.max(1, Number(count) || 1);
  state.downloadsSuccess += n;
  scheduleFlush();
}

function recordFailure(_kind, count = 1) {
  ensureLoaded();
  const n = Math.max(1, Number(count) || 1);
  state.failedTotal += n;
  scheduleFlush();
}

function snapshot() {
  ensureLoaded();
  return {
    uptimeSeconds: Math.max(0, Math.floor((Date.now() - BOOT_AT) / 1000)),
    commandsTotal: state.commandsTotal,
    downloadsSuccess: state.downloadsSuccess,
    failedTotal: state.failedTotal,
    ramUsedMB: Math.round(process.memoryUsage().rss / 1048576),
  };
}

function _resetForTests(customFile = null) {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  storeFile = customFile;
  loaded = true;
  state.commandsTotal = 0;
  state.downloadsSuccess = 0;
  state.failedTotal = 0;
  state.updatedAt = Date.now();
  if (storeFile) {
    loaded = false;
    ensureLoaded();
  }
}

module.exports = {
  recordCommand,
  recordDownloadSuccess,
  recordFailure,
  snapshot,
  flushNow,
  _resetForTests,
};
