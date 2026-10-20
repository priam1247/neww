/**
 * ZaFar Bot — movie/series engine bridge (CommonJS → ESM)
 *
 * The engine lives in ../engine and is written as ES modules (it has its own
 * package.json with "type":"module"). This bot is CommonJS, so the engine is
 * loaded ONCE with a dynamic import() and then reused.
 *
 * Everything the engine needs is handed over through environment variables
 * before that first import, because the engine reads its config at load time.
 * That keeps the engine self-contained (it can also run standalone) while the
 * bot keeps a single config file.
 */

const path = require('path');
const { pathToFileURL } = require('url');
const config = require('../config');

const ROOT = path.join(__dirname, '..');           // Zafar-bot-main/
const ENGINE = path.join(ROOT, 'engine');

let enginePromise = null;
let loaded = null;

const setIfEmpty = (key, value) => {
  if (value === undefined || value === null || value === '') return;
  if (process.env[key] !== undefined) return;
  process.env[key] = String(value);
};

function applyConfig() {
  const m = config.movies || {};
  const abs = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));

  // keys
  setIfEmpty('TMDB_API_KEY', m.tmdbKey);
  setIfEmpty('REALDEBRID_API_KEY', m.realDebridKey);
  setIfEmpty('ALLDEBRID_API_KEY', m.allDebridKey);

  // paths — always inside the bot's own temp folder
  setIfEmpty('TEMP_DIR', abs(m.tempDir || 'temp/movies'));
  setIfEmpty('JOB_DIR', abs(m.tempDir || 'temp/movies'));
  setIfEmpty('CACHE_FILE', abs(m.cacheFile || 'temp/movie-cache.json'));
  setIfEmpty('DATA_DIR', abs(m.dataDir || 'temp/movie-data'));

  // behaviour
  setIfEmpty('MAX_SEND_MB', m.maxSendMB);
  setIfEmpty('MIN_FREE_MB', m.minFreeMB);
  setIfEmpty('REGION', m.region || 'US');
  setIfEmpty('CONCURRENCY', m.queueConcurrency);
  setIfEmpty('JOB_TIMEOUT_MS', m.jobTimeoutMs);
  setIfEmpty('DRY_RUN', m.dryRun ? '1' : '');
  setIfEmpty('BOT_NAME', config.botName);
  setIfEmpty('MOVIE_QUIET', '1');                  // engine must not print warnings itself
}

/**
 * Load the engine (idempotent, retries after a failure).
 * @returns {Promise<object>} the engine module (`default` = high-level API)
 */
function load() {
  if (!enginePromise) {
    applyConfig();
    const entry = pathToFileURL(path.join(ENGINE, 'media', 'index.js')).href;
    enginePromise = import(entry)
      .then((mod) => {
        loaded = mod;
        return mod;
      })
      .catch((err) => {
        enginePromise = null;                       // allow a later retry
        const e = new Error(`movie engine failed to load: ${err.message}`);
        e.cause = err;
        throw e;
      });
  }
  return enginePromise;
}

/** true when the engine loaded at least once (used by .menu / diagnostics) */
const isLoaded = () => Boolean(loaded);

module.exports = {
  load,
  isLoaded,
  ROOT,
  ENGINE,

  // ── TMDB ────────────────────────────────────────────────────────────────
  async searchMovie(title, year) {
    const { tmdb } = await load();
    return tmdb.searchMovie(title, year);
  },
  async searchTv(title, year) {
    const { tmdb } = await load();
    return tmdb.searchTv(title, year);
  },
  async movieDetails(tmdbId) {
    const { tmdb } = await load();
    return tmdb.movieDetails(tmdbId);
  },
  async tvDetails(tmdbId) {
    const { tmdb } = await load();
    return tmdb.tvDetails(tmdbId);
  },

  // ── resolve ─────────────────────────────────────────────────────────────
  async resolveMovie(opts) {
    const { resolveMovie } = await load();
    return resolveMovie(opts);
  },
  async resolveEpisode(opts) {
    const { resolveEpisode } = await load();
    return resolveEpisode(opts);
  },
  async resolveSeason(opts) {
    const { resolveSeason } = await load();
    return resolveSeason(opts);
  },

  // ── files ───────────────────────────────────────────────────────────────
  async targetFile(...args) {
    const { targetFile } = await load();
    return targetFile(...args);
  },
  async rememberFile(...args) {
    const { rememberFile } = await load();
    return rememberFile(...args);
  },
  /** stream a resolved source to disk (stall guard + resume + retries) */
  async download(res, file, onProgress) {
    await load();
    const { download } = await import(pathToFileURL(path.join(ENGINE, 'media', 'downloader.js')).href);
    return download(res, file, onProgress);
  },

  /** run a job in the engine's fair queue (one heavy job at a time by default) */
  async enqueue(jid, label, fn, opts = {}) {
    const { queue } = await load();
    return queue.add(jid, label, fn, opts);
  },
  async queuePosition(jid) {
    const { queue } = await load();
    return queue.position(jid);
  },

  // ── metadata for commands ───────────────────────────────────────────────
  async providers() {
    const { registry } = await load();
    return registry.table();
  },
  async stats() {
    const { mlog } = await load();
    const { metrics } = await import(pathToFileURL(path.join(ENGINE, 'core', 'metrics.js')).href);
    return metrics.snapshot();
  },
  async cacheStats() {
    const { cache } = await load();
    return cache.stats();
  },
  /** wait for everything currently downloading (used by .movie status) */
  async queueSize() {
    const { queue } = await load();
    return { queued: queue.size, running: queue.busy };
  },
};
