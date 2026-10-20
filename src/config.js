// src/config.js — env loading (zero-dep .env parser), validation, frozen export.
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

// Owner's number — pairing-code login + admin commands work out of the box.
// Override with PAIR_NUMBER / OWNER_NUMBER; set PAIR_NUMBER=0 to fall back to QR.
const OWNER_DEFAULT = '265894016453';
const rawPair = process.env.PAIR_NUMBER ?? OWNER_DEFAULT;
const pairDisabled = /^(0|off|none|disabled?)$/i.test(String(rawPair).trim());

const cfg = {
  // identity
  botName: process.env.BOT_NAME || 'ZaFarBot 3.3',
  prefix: process.env.PREFIX || '/',
  region: process.env.REGION || 'US',
  ownerJid: process.env.BOT_OWNER_JID || '',
  userAgent: process.env.USER_AGENT || 'ZaFarBot/3.3 (+https://github.com/zafar3)',

  // identity (merged from Zafar-bot-main): owner/admin by phone number — works
  // even when WhatsApp only shows a LID for the sender.
  ownerNumber: (process.env.OWNER_NUMBER || OWNER_DEFAULT).replace(/[^0-9]/g, ''),
  adminNumbers: list(process.env.ADMIN_NUMBERS, []),
  accessMode: (process.env.ACCESS_MODE || 'open').toLowerCase(),   // open | whitelist
  packName: process.env.PACK_NAME || process.env.BOT_NAME || 'ZaFarBot 3.3',
  timezone: process.env.TZ || 'Africa/Blantyre',

  // WhatsApp login
  sessionId: process.env.SESSION_ID || '',       // "ZaFarBot!<gzip+b64>" bootstrap
  pairNumber: pairDisabled ? '' : String(rawPair).replace(/[^0-9]/g, ''),
  messageAgeLimitMs: num(process.env.MESSAGE_AGE_LIMIT_MS, 5 * 60_000),

  // keys
  tmdbKey: process.env.TMDB_API_KEY || '98bb6b66ece431fbea8a0ee9c18ac712',   // owner's v3 key baked in; env still overrides
  // TorBox removed in 3.3: its API needs a Pro plan. RealDebrid/AllDebrid only.
  realDebridKey: process.env.REALDEBRID_API_KEY || '',
  allDebridKey: process.env.ALLDEBRID_API_KEY || '',
  openSubsKey: process.env.OPENSUBTITLES_API_KEY || '',

  // merged: remote downloader fallbacks (.song/.ytv/.dl backup engines)
  giftedApiUrl: process.env.GIFTED_API_URL || 'https://api.gifted.co.ke',
  giftedApiKey: process.env.GIFTED_API_KEY || '',
  cobaltInstances: list(process.env.COBALT_INSTANCES, []),
  cobaltUseDefaults: bool(process.env.COBALT_USE_DEFAULTS, true),
  spotifyClientId: process.env.SPOTIFY_CLIENT_ID || '',
  spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',

  // merged: yt-dlp engine
  ytdlpDeadlineMs: num(process.env.YTDLP_DEADLINE_MS, 10 * 60_000),
  ytdlpUpdateOnBotCheck: bool(process.env.YTDLP_UPDATE_ON_BOT_CHECK, true),
  youtubeCookies: process.env.YOUTUBE_COOKIES || '',
  youtubeCookiesFile: process.env.YOUTUBE_COOKIES_FILE || '',
  ytdlpProxy: process.env.YTDLP_PROXY || '',

  // merged: media limits
  songMaxMB: num(process.env.SONG_MAX_MB, 120),
  songMaxMinutes: num(process.env.SONG_MAX_MINUTES, 180),
  songSendAs: (process.env.SONG_SEND_AS || 'document').toLowerCase(),
  videoMaxMB: num(process.env.VIDEO_MAX_MB, 300),
  videoMaxMinutes: num(process.env.VIDEO_MAX_MINUTES, 60),
  videoDefaultQuality: num(process.env.VIDEO_DEFAULT_QUALITY, 720),
  searchPicker: bool(process.env.SEARCH_PICKER, true),
  searchResults: num(process.env.SEARCH_RESULTS, 5),
  searchTtlMinutes: num(process.env.SEARCH_TTL_MINUTES, 5),

  // merged: Drime Cloud past-paper vault (.paper)
  drimeApiToken: process.env.DRIME_API_TOKEN || '',
  drimeBaseUrl: process.env.DRIME_BASE_URL || 'https://app.drime.cloud/api/v1',
  drimePapersFolderId: num(process.env.DRIME_PAPERS_FOLDER_ID, 0),
  drimePapersFolderHash: process.env.DRIME_PAPERS_FOLDER_HASH || '',
  drimeWorkspaceId: num(process.env.DRIME_WORKSPACE_ID, 0),

  // merged: Telegram sticker packs (.tgpack/.tgsticker)
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',

  // storage
  tempDir: process.env.TEMP_DIR || './temp/media',
  jobDir: process.env.JOB_DIR || './temp/jobs',           // yt-dlp/ffmpeg staging
  dataDir: process.env.DATA_DIR || './data',              // store.json (whitelist/state/settings)
  cacheFile: process.env.CACHE_FILE || './temp/cache-store.json',
  maxSendMB: num(process.env.MAX_SEND_MB, 2800),
  minFreeMB: num(process.env.MIN_FREE_MB, 3000),
  cacheMaxMB: num(process.env.CACHE_MAX_MB, 20000),
  cacheTTLHours: num(process.env.CACHE_TTL_HOURS, 72),
  linkTTLHours: num(process.env.LINK_TTL_HOURS, 6),
  metaTTLHours: num(process.env.META_TTL_HOURS, 24),
  negCacheMinutes: num(process.env.NEG_CACHE_MINUTES, 30),

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

  // series strategy
  preferEpisodeTorrent: bool(process.env.PREFER_EPISODE_TORRENT, true),
  packOnlyWhenCached: bool(process.env.PACK_ONLY_WHEN_CACHED, true),
  packMinEpisodes: num(process.env.PACK_MIN_EPISODES, 3),

  // perf
  concurrency: num(process.env.CONCURRENCY, 1),
  perUserQueueCap: num(process.env.PER_USER_QUEUE_CAP, 3),
  jobTimeoutMs: num(process.env.JOB_TIMEOUT_MS, 15 * 60_000),
  providerTimeoutMs: num(process.env.PROVIDER_TIMEOUT_MS, 12_000),
  tier0TimeoutMs: num(process.env.TIER0_TIMEOUT_MS, 6_000),
  tierTimeoutMs: num(process.env.TIER_TIMEOUT_MS, 15_000),
  tier0ProbeCount: num(process.env.TIER0_PROBE_COUNT, 12),
  searchMemoTTLms: num(process.env.SEARCH_MEMO_TTL_MS, 5 * 60_000),
  verifyBytes: num(process.env.VERIFY_BYTES, 2 * 1048576),

  // behaviour
  dryRun: bool(process.env.DRY_RUN, false)          // resolve only, never download
};

// ── boot-time validation: fail loudly, not silently at runtime ─────────────
const problems = [];
if (!cfg.tmdbKey) problems.push('TMDB_API_KEY is not set — metadata lookups will fail (get a free key at themoviedb.org)');
const debridCount = [cfg.realDebridKey, cfg.allDebridKey].filter(Boolean).length;
if (debridCount === 0) problems.push('no debrid key set — torrent sources will not resolve (set REALDEBRID_API_KEY or ALLDEBRID_API_KEY)');
if (problems.length) {
  console.error('⚠️  configuration warnings:');
  for (const p of problems) console.error(`   • ${p}`);
}

// extra derived state (mutable at runtime, not part of config freeze)
export const runtime = {
  booted: false,
  online: undefined          // set by smoke probe, null = unknown
};

export default Object.freeze(cfg);
