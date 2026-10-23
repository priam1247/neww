'use strict';

/**
 * ZaFar Bot — In-Process Runtime Hot Reload
 *
 * XS Systems' custom Hydrodactyl panel omits Pterodactyl's
 * `/api/client/servers/<id>/power` endpoint (returning HTTP 404/405).
 * When `.restart` or the web dashboard triggers a restart without panel power
 * access, `reloadRuntime()` purges cached command, engine, config, and handler
 * modules from `require.cache` and reloads them straight from disk before
 * reconnecting the WhatsApp socket — picking up newly SFTP-deployed code
 * without killing PID 1.
 */

const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Stateful singletons whose timers, queues, or sockets must stay intact
const PRESERVED_UTILS = new Set([
  'hotReload.js',
  'telemetry.js',
  'dashboardSync.js',
  'cleanup.js',
  'diskGuard.js',
  'tempManager.js',
  'jobQueue.js',
  'accessControl.js',
  'reconnect.js',
  'safeLog.js',
  'adminApi.js',
  'botState.js',
  'jsonStore.js',
]);

const listeners = new Set();

function onReload(fn) {
  if (typeof fn === 'function') listeners.add(fn);
  return () => listeners.delete(fn);
}

function shouldEvict(resolvedPath) {
  const rel = path.relative(ROOT, resolvedPath).replace(/\\/g, '/');
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  if (rel.startsWith('node_modules/')) return false;
  if (rel === 'config.js' || rel === 'handler.js') return true;
  if (rel.startsWith('commands/') || rel.startsWith('engine/')) return true;
  if (rel.startsWith('utils/')) {
    const base = path.posix.basename(rel);
    return !PRESERVED_UTILS.has(base);
  }
  return false;
}

function reloadRuntime() {
  try {
    require('./telemetry').flushNow();
  } catch { /* ignore */ }
  let hadWatchdog = false;
  try {
    hadWatchdog = Boolean(require('./youtubedl').stopWatchdog());
  } catch { /* ignore */ }

  let evicted = 0;
  for (const key of Object.keys(require.cache)) {
    if (shouldEvict(key)) {
      delete require.cache[key];
      evicted += 1;
    }
  }

  const freshHandler = require(path.join(ROOT, 'handler.js'));
  if (hadWatchdog) {
    try {
      require('./youtubedl').startWatchdog({ everyMinutes: 30 });
    } catch { /* ignore */ }
  }
  for (const fn of listeners) {
    try { fn(freshHandler); } catch { /* ignore */ }
  }
  return { ok: true, evicted, handler: freshHandler };
}

module.exports = {
  onReload,
  reloadRuntime,
};
