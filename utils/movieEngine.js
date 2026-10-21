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

const ROOT = path.join(__dirname, '..');           // repo root (= the bot)
const ENGINE = path.join(ROOT, 'engine');

let enginePromise = null;
let loaded = null;

const setIfEmpty = (key, value) => {
  if (value === undefined || value === null || value === '') return;
  if (process.env[key] !== undefined) return;
  process.env[key] = String(value);
};

/** The bot's own temp dir (utils/tempManager) — the single place it cleans. */
function hostTempDir() {
  try {
    // eslint-disable-next-line global-require
    return require('./tempManager').getTempDir();
  } catch {
    return path.join(ROOT, 'temp');
  }
}

function applyConfig() {
  const m = config.movies || {};
  const abs = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));
  // Follow the bot: if it keeps temp somewhere else (TMPDIR, mounted disk),
  // the movie files live in a `movies/` subfolder of that same place.
  const movieTemp = m.tempDir && m.tempDir !== 'temp/movies'
    ? abs(m.tempDir)
    : path.join(hostTempDir(), 'movies');

  // keys
  setIfEmpty('TMDB_API_KEY', m.tmdbKey);
  setIfEmpty('OMDB_API_KEY', m.omdbKey);
  setIfEmpty('TRAKT_CLIENT_ID', m.traktClientId);
  setIfEmpty('META_CINEMETA', m.metadata?.cinemeta === false ? '0' : '1');
  setIfEmpty('META_IMDB', m.metadata?.imdb === false ? '0' : '1');
  setIfEmpty('META_TVMAZE', m.metadata?.tvmaze === false ? '0' : '1');
  setIfEmpty('META_ANIME', m.metadata?.anime === false ? '0' : '1');
  setIfEmpty('REALDEBRID_API_KEY', m.realDebridKey);
  setIfEmpty('ALLDEBRID_API_KEY', m.allDebridKey);

  // paths — always inside the bot's own temp folder
  setIfEmpty('TEMP_DIR', movieTemp);
  setIfEmpty('JOB_DIR', movieTemp);
  // bookkeeping stays inside temp/movies/: the bot's own cleanup only deletes
  // loose files in temp/, so nothing of the engine's can be swept away
  setIfEmpty('CACHE_FILE', abs(m.cacheFile || path.join(movieTemp, 'cache.json')));
  setIfEmpty('DATA_DIR', abs(m.dataDir || path.join(movieTemp, 'data')));

  // behaviour
  setIfEmpty('MAX_SEND_MB', m.maxSendMB);
  setIfEmpty('MAX_DOWNLOAD_MB', m.maxDownloadMB);
  setIfEmpty('MIN_FREE_MB', m.minFreeMB);
  setIfEmpty('TORRENT_DIRECT', m.torrentDirect === false ? '0' : '1');
  setIfEmpty('TORRENT_MIN_SEEDS', m.torrentMinSeeds);
  setIfEmpty('TORRENT_METADATA_TIMEOUT_MS', m.torrentMetadataTimeoutMs);
  setIfEmpty('TORRENT_STALL_TIMEOUT_MS', m.torrentStallTimeoutMs);
  setIfEmpty('REGION', m.region || 'US');
  setIfEmpty('CONCURRENCY', m.queueConcurrency);
  setIfEmpty('JOB_TIMEOUT_MS', m.jobTimeoutMs);
  setIfEmpty('DRY_RUN', m.dryRun ? '1' : '');
  setIfEmpty('BOT_NAME', config.botName);
  setIfEmpty('MOVIE_QUIET', '1');                  // engine must not print warnings itself
  setIfEmpty('IMDB_INDEX_FILE', m.imdbIndexFile ? abs(m.imdbIndexFile) : undefined);
  setIfEmpty('QUALITY_FALLBACK', m.qualityFallback === false ? '0' : '1');
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
      .then(async (mod) => {
        loaded = mod;
        // embedded mode: never install the engine's own SIGINT/SIGTERM handlers
        try { await mod.cache.init({ installSignalHandlers: false }); } catch (e) { /* non-fatal */ }
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

  // ── metadata (multi-source: TMDB · Cinemeta · IMDb · TVMaze · OMDb · Trakt · Jikan · AniList)
  async search(title, { type = 'movie', year = null, limit = 8 } = {}) {
    const { metadata } = await load();
    return metadata.search(title, { type, year, limit });
  },
  async searchMovie(title, year) {
    return module.exports.search(title, { type: 'movie', year });
  },
  async searchTv(title, year) {
    return module.exports.search(title, { type: 'series', year });
  },
  async details(item) {
    const { metadata } = await load();
    return metadata.details(item);
  },
  async lookup(title, opts = {}) {
    const { metadata } = await load();
    return metadata.lookup(title, opts);
  },
  async metadataTable() {
    const { metadata } = await load();
    return metadata.table();
  },
  /**
   * Better-known alternatives to an item, used when a download fails.
   * "Infinity Wars" matches a 0-vote entry on TMDB while IMDb knows the film
   * the user meant — saying so beats a bare "no source".
   * @returns {Promise<Array<{title:string, year:string, fame:number}>>}
   */
  async alternatives(items, { chosen = null, limit = 2 } = {}) {
    const fame = (m) => {
      const pop = Number(m.popularity) || 0;
      const rating = Number(m.rating) || 0;
      // IMDb reports a popularity RANK (smaller is bigger); TMDB reports a score
      if (m.source === 'imdb' || pop > 1000) return pop ? 500000 / pop : 0;
      return pop + rating * 3;
    };
    const key = (m) => `${m.imdbId || ''}${m.tmdbId || ''}${m.title || ''}`;
    const chosenKey = chosen ? key(chosen) : null;

    return (items || [])
      .filter(m => m && m.title && key(m) !== chosenKey)
      .map(m => ({ title: m.title, year: m.year || '', type: m.type || null, fame: fame(m) }))
      .filter(m => m.fame >= 8)
      .sort((a, b) => b.fame - a.fame)
      .slice(0, limit);
  },

  /**
   * Subtitle file for a title (MovieBox BFF). Returns null when there is none.
   * @returns {Promise<{file:string, language:string}|null>}
   */
  async subtitles(meta, { season = null, episode = null, lang = 'en', dest = null } = {}) {
    const { subtitles } = await load();
    return subtitles(meta, { season, episode, lang, dest });
  },

  /** verify the configured debrid keys against the provider APIs */
  async debridAccounts() {
    const { debrid } = await load();
    return debrid.probe();
  },
  /** per-provider mirror pools: which DDL domain answered, which is benched */
  async mirrors() {
    const { mirrorReport } = await load();
    try { return mirrorReport(); } catch { return []; }
  },
  async movieDetails(tmdbId) {
    const { tmdb } = await load();
    return tmdb.movieDetails(tmdbId);
  },
  async tvDetails(tmdbId) {
    const { tmdb } = await load();
    return tmdb.tvDetails(tmdbId);
  },
  /** episode guide from TVMaze (keyless) — air dates + "does this episode exist" */
  async episodeGuide(item, season) {
    const { tvmaze } = await load();
    try {
      let show = item?.tvmazeId ? { tvmazeId: item.tvmazeId } : null;
      if (!show && item?.imdbId) show = await tvmaze.byImdb(item.imdbId);
      if (!show && item?.title) {
        const hits = await tvmaze.search(item.title);
        show = hits[0] || null;
      }
      if (!show?.tvmazeId) return null;
      return await tvmaze.season(show.tvmazeId, season);
    } catch { return null; }
  },
  /** anime detection (routes .series through Nyaa + abs numbering) */
  async looksAnime(item) {
    const { metadata } = await load();
    return metadata.looksAnime(item);
  },

  // ── resolve ─────────────────────────────────────────────────────────────
  async resolveMovie(opts) {
    const { resolveMovie } = await load();
    return resolveMovie(opts);
  },
  async identify(opts) {
    const { identify } = await load();
    return identify(opts);
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
  /** boot the engine once, without installing process-wide signal handlers */
  async boot() {
    const { cache } = await load();
    await cache.init({ installSignalHandlers: false });
  },
  async targetFile(...args) {
    const { targetFile } = await load();
    return targetFile(...args);
  },
  async rememberFile(...args) {
    const { rememberFile } = await load();
    return rememberFile(...args);
  },
  /** stream a resolved source to disk (stall guard + resume + retries) */
  /** @returns {Promise<{bytes:number, file:string}>} file = what actually landed on disk */
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
