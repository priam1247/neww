// engine/config.js — movies & series engine configuration.
//
// Embedded in ZaFar Bot: values come from environment variables first (set by
// utils/movieEngine.js from config.js), then from a .env file, then defaults.
// Every path points inside the bot's own ./temp folder so the bot's existing
// cleanup/watchdog never collides with the engine.
import fs from 'node:fs';
import path from 'node:path';

// ── tiny .env loader (no dotenv dependency) ────────────────────────────────
function loadDotEnv(file = '.env') {
  try {
    const p = path.resolve(process.cwd(), file);
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i < 1) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch { /* non-fatal */ }
}
loadDotEnv();

const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const list = (v, d) => (v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : d);

const cfg = {
  // identity
  botName: process.env.BOT_NAME || 'ZaFar Bot',
  region: process.env.REGION || 'US',
  userAgent: process.env.USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',

  // keys — TMDB is required, everything else is optional enrichment
  tmdbKey: process.env.TMDB_API_KEY || '98bb6b66ece431fbea8a0ee9c18ac712',
  omdbKey: process.env.OMDB_API_KEY || '',
  traktClientId: process.env.TRAKT_CLIENT_ID || '',
  realDebridKey: process.env.REALDEBRID_API_KEY || '',
  allDebridKey: process.env.ALLDEBRID_API_KEY || '',
  openSubsKey: process.env.OPENSUBTITLES_API_KEY || '',

  // ── metadata sources ─────────────────────────────────────────────────────
  // Every base URL is overridable so tests can run against a local server.
  tmdbBase: process.env.TMDB_BASE || 'https://api.themoviedb.org/3',
  cinemetaBase: process.env.CINEMETA_BASE || 'https://v3-cinemeta.strem.io',
  tvmazeBase: process.env.TVMAZE_BASE || 'https://api.tvmaze.com',
  omdbBase: process.env.OMDB_BASE || 'https://www.omdbapi.com',
  traktBase: process.env.TRAKT_BASE || 'https://api.trakt.tv',
  jikanBase: process.env.JIKAN_BASE || 'https://api.jikan.moe/v4',
  anilistBase: process.env.ANILIST_BASE || 'https://graphql.anilist.co',
  imdbSuggestBase: process.env.IMDB_SUGGEST_BASE || 'https://v2.sg.media-imdb.com',
  imdbIndexFile: process.env.IMDB_INDEX_FILE || './temp/imdb-index.tsv',

  metadataTimeoutMs: num(process.env.METADATA_TIMEOUT_MS, 8000),

  // per-source switches (anime covers jikan + anilist)
  metadata: {
    cinemeta: bool(process.env.META_CINEMETA, true),
    imdb: bool(process.env.META_IMDB, true),
    tvmaze: bool(process.env.META_TVMAZE, true),
    omdb: bool(process.env.META_OMDB, true),
    trakt: bool(process.env.META_TRAKT, true),
    anime: bool(process.env.META_ANIME, true),
  },

  // debrid is optional: without a key, torrent results are skipped and the
  // cascade runs on the DDL + HLS tiers (which need no account at all).
  skipTorrentWithoutDebrid: bool(process.env.SKIP_TORRENT_WITHOUT_DEBRID, true),

  // storage (all inside the bot's ./temp)
  tempDir: process.env.TEMP_DIR || './temp/movies',
  jobDir: process.env.JOB_DIR || './temp/movies',
  cacheFile: process.env.CACHE_FILE || './temp/movies/cache.json',
  dataDir: process.env.DATA_DIR || './temp/movies/data',

  // limits
  maxSendMB: num(process.env.MAX_SEND_MB, 1500),
  // Hard ceiling for a single download. This is NOT WhatsApp's send limit:
  // anything over maxSendMB is delivered as a Drime link by the bot adapters.
  maxDownloadMB: num(process.env.MAX_DOWNLOAD_MB, 4096),
  minFreeMB: num(process.env.MIN_FREE_MB, 800),
  minSampleMB: num(process.env.MIN_SAMPLE_MB, 30),        // below this = sample/trailer
  cacheMaxMB: num(process.env.CACHE_MAX_MB, 20000),
  cacheTTLHours: num(process.env.CACHE_TTL_HOURS, 72),
  linkTTLHours: num(process.env.LINK_TTL_HOURS, 6),
  metaTTLHours: num(process.env.META_TTL_HOURS, 24),
  negCacheMinutes: num(process.env.NEG_CACHE_MINUTES, 10),
  partialGraceMs: num(process.env.PARTIAL_GRACE_MS, 15 * 60_000),
  downloadStallMs: num(process.env.DOWNLOAD_STALL_MS, 90_000),   // no bytes for 90s → abort
  downloadRetries: num(process.env.DOWNLOAD_RETRIES, 2),

  // ranking floors
  minSeeds: num(process.env.MIN_SEEDS, 2),
  minSeedsOld: num(process.env.MIN_SEEDS_OLD, 0),
  oldYearThreshold: num(process.env.OLD_YEAR_THRESHOLD, 8),
  preferCodec: process.env.PREFER_CODEC || 'x265',
  audioPref: list(process.env.AUDIO_PREF, ['en', 'dual', 'multi']),
  qualities: [480, 720, 1080, 2160],
  sizeWindow: {                       // rejects CAMs and bloated remuxes
    480: [150, 900], 720: [350, 1900], 1080: [650, 4000], 2160: [1800, 14000]
  },

  // quality ladder: if the requested quality has no usable source, step to the
  // neighbours instead of failing (1080 → 720 → 480, and up for old 480-only)
  qualityFallback: bool(process.env.QUALITY_FALLBACK, true),

  // series strategy
  preferEpisodeTorrent: bool(process.env.PREFER_EPISODE_TORRENT, true),
  packOnlyWhenCached: bool(process.env.PACK_ONLY_WHEN_CACHED, true),
  packMinEpisodes: num(process.env.PACK_MIN_EPISODES, 3),

  // perf
  concurrency: num(process.env.CONCURRENCY, 1),
  perUserQueueCap: num(process.env.PER_USER_QUEUE_CAP, 3),
  jobTimeoutMs: num(process.env.JOB_TIMEOUT_MS, 15 * 60_000),
  providerTimeoutMs: num(process.env.PROVIDER_TIMEOUT_MS, 12_000),
  tierTimeoutMs: num(process.env.TIER_TIMEOUT_MS, 15_000),
  verifyTimeoutMs: num(process.env.VERIFY_TIMEOUT_MS, 12_000),
  torrentResolveTimeoutMs: num(process.env.TORRENT_RESOLVE_TIMEOUT_MS, 120_000),
  searchMemoTTLms: num(process.env.SEARCH_MEMO_TTL_MS, 5 * 60_000),
  verifyBytes: num(process.env.VERIFY_BYTES, 2 * 1048576),

  // behaviour
  dryRun: bool(process.env.DRY_RUN, false),          // resolve only, never download
  quiet: bool(process.env.MOVIE_QUIET, true)
};

// ── boot-time validation: fail loudly, not silently at runtime ─────────────
const problems = [];
if (!cfg.tmdbKey) problems.push('TMDB_API_KEY is not set — falling back to Cinemeta/IMDb/TVMaze for titles');
if (!cfg.realDebridKey && !cfg.allDebridKey) {
  problems.push('no debrid key — torrent sources are skipped (DDL + stream tiers still work). Add REALDEBRID_API_KEY or ALLDEBRID_API_KEY for 4K/1080p torrents.');
}
if (problems.length && !cfg.quiet) {
  console.error('⚠️  movie engine configuration:');
  for (const p of problems) console.error(`   • ${p}`);
}

export const hasDebrid = () => Boolean(cfg.realDebridKey || cfg.allDebridKey);

export default Object.freeze(cfg);
