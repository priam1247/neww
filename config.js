/**
 * ZaFar Bot — Global Configuration
 *
 * Every value can be overridden with an environment variable (shown in the
 * comments), which keeps tokens out of git on hosts that have an env panel.
 * The hard-coded values stay as defaults so Katabump-style panels (no env
 * panel) keep working exactly as before.
 */

// ── .env loader (no dependency) ────────────────────────────────────────────
// The engine has its own loader, but the bot's config is read first, so a key
// placed in .env (e.g. REALDEBRID_API_KEY) has to be picked up here too.
// .env is git-ignored on purpose: never commit real keys.
(function loadDotEnv(file = '.env') {
  try {
    const fs = require('fs');
    const path = require('path');
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
})();

const env = process.env;
const list = (raw, fallback) => String(raw || fallback).split(',').map(s => s.trim()).filter(Boolean);
// WhatsApp documents cap at 2 GB: that is the download ceiling too.
const movieCapDefault = Math.min(2000, Number(env.VIDEO_MAX_MB || 2000));

module.exports = {
  ownerNumber: list(env.OWNER_NUMBER, '265894016453'),
  // Bot admins: full owner-level access, no need to .allow them
  adminNumbers: list(env.ADMIN_NUMBERS, '265997564836,265986741036,265894016451'),
  ownerName: list(env.OWNER_NAME, 'ZaFar'),

  botName: env.BOT_NAME || 'ZaFar Bot',
  prefix: env.PREFIX || '.',
  cooldownMs: Math.max(0, Number(env.COMMAND_COOLDOWN_MS ?? 2000)),
  sessionName: env.SESSION_NAME || 'session',
  // Katabump has no environment-variable panel — set the real value here.
  // ZaFarBot! session string from your pairing/auth step.
  sessionID: env.SESSION_ID || '',

  packname: env.PACK_NAME || 'ZaFar Bot',

  // Gifted API (optional fallback downloader). Set GIFTED_API_KEY in .env.
  giftedApi: {
    baseUrl: env.GIFTED_API_URL || 'https://api.gifted.co.ke',
    apiKey: env.GIFTED_API_KEY || '',
  },

  // ─── yt-dlp / YouTube (used by .song and .ytv) ────────────────────────────
  // Hosting IPs are what trigger YouTube's "confirm you're not a bot" wall.
  // Cookies fix it: export a cookies.txt from a logged-in browser and drop it
  // in the bot folder (or paste its contents / base64 into `cookies`, or set
  // YOUTUBE_COOKIES in the environment).
  ytdlp: {
    cookiesFile: env.YOUTUBE_COOKIES_FILE || '', // path to cookies.txt
    cookies: env.YOUTUBE_COOKIES || '',          // raw Netscape text, base64, or JSON export
    proxy: env.YTDLP_PROXY || '',                // e.g. http://user:pass@host:port
    ipv4: true,                                  // force IPv4 (IPv6 egress is often blocked)
    noCheckCertificates: true,                   // many free hosts ship an outdated CA bundle
    updateOnBotCheck: true,                      // self-update yt-dlp once per run after a bot-check
    fragments: Number(env.YTDLP_FRAGMENTS || 4),
    autoUpdateHours: Number(env.YTDLP_AUTO_UPDATE_HOURS ?? 24),
    // Total time one .song/.ytv job may spend trying player clients before it
    // gives up (prevents a hopeless download from hanging for an hour).
    deadlineMs: Number(env.YTDLP_DEADLINE_MS || 45 * 60 * 1000),
  },

  // ─── Spotify (.spotify) ──────────────────────────────────────────────────
  // Optional. Without credentials the bot uses Spotify's public oEmbed endpoint
  // for the track title/artist (no key needed); with them it gets the album and
  // duration as well. Create an app at developer.spotify.com → Dashboard.
  spotify: {
    clientId: env.SPOTIFY_CLIENT_ID || '',
    clientSecret: env.SPOTIFY_CLIENT_SECRET || '',
  },

  // ─── Remote downloader fallbacks (used only when yt-dlp cannot do it) ────
  // Cobalt (github.com/imputnet/cobalt) instances. Community instances come and
  // go: override with COBALT_INSTANCES="https://a,https://b" (or from WhatsApp
  // with `.ytdl engine` for a status view). Set useDefaultInstances:false to
  // rely only on the ones you configure.
  cobalt: {
    instances: String(env.COBALT_INSTANCES || '').split(',').map(s => s.trim()).filter(Boolean),
    useDefaultInstances: env.COBALT_USE_DEFAULTS === 'false' ? false : true,
  },

  // ─── Search picker (.song / .ytv with a search phrase) ───────────────────
  // When a query is not a link, the bot lists the top results and lets the user
  // reply with a number instead of silently downloading the first hit.
  search: {
    // Off by default: .song/.ytv take the top (official) hit and only reply
    // with the file. SEARCH_PICKER=true restores the numbered list.
    picker: /^(1|true|yes)$/i.test(String(env.SEARCH_PICKER || '')),
    maxResults: Math.max(1, Math.min(10, Number(env.SEARCH_RESULTS || 5))),
    ttlMinutes: Math.max(1, Number(env.SEARCH_TTL_MINUTES || 5)),
  },

  // ─── Media limits (.song / .ytv) ──────────────────────────────────────────
  song: {
    maxMB: 120,
    maxMinutes: Number(env.SONG_MAX_MINUTES || 180),
    // 'document' keeps the "Title - Artist.mp3" filename (old behaviour);
    // 'audio' sends a normal in-chat playable audio message.
    sendAs: env.SONG_SEND_AS || 'document',
  },
  video: {
    defaultQuality: 720,
    // WhatsApp documents top out at 2 GB; anything over 50 MB goes as a document.
    maxMB: Number(env.VIDEO_MAX_MB || 2000),
    maxMinutes: Number(env.VIDEO_MAX_MINUTES || 0),   // 0 = no length limit
  },
  media: {
    diskMinFreeMB: Number(env.MEDIA_DISK_MIN_FREE_MB ?? 1200),
    diskCopyMultiplier: Number(env.MEDIA_DISK_COPY_MULTIPLIER ?? 1.2),
    diskCopyOverheadMB: Number(env.MEDIA_DISK_COPY_OVERHEAD_MB ?? 300),
  },
  // ─── Disk guard (bot folder quota vs shared host disk) ───────────────────
  // Counts the bot's own folder against ~9 GB by default (for a 10 GB plan)
  // instead of trusting statfs, which often reports the whole host node.
  disk: {
    budgetMB: Number(env.DISK_BUDGET_MB ?? 9000),
    tempMaxMB: Number(env.TEMP_MAX_MB ?? 2048),
  },
  // ─── Download concurrency ────────────────────────────────────────────────
  // light  = link/YouTube downloads: 20 at a time (QUEUE_LIGHT)
  // heavy  = movie/episode jobs: 2 at a time (QUEUE_HEAVY, tuned for 10 GB disk)
  queue: {
    light: Math.max(1, Math.floor(Number(env.QUEUE_LIGHT) || 20)),
    heavy: Math.max(1, Math.floor(Number(env.QUEUE_HEAVY) || 2)),
    minFreeMB: Math.max(0, Number(env.QUEUE_MIN_FREE_MB || 220)),
  },

  messages: {
    error: '❌ Something went wrong.',
    ownerOnly: '👑 This command is only for the bot owner.',
  },

  timezone: env.TZ || 'Africa/Blantyre',

  // Set PAIR_NUMBER (full WhatsApp number, digits only, country code first,
  // e.g. 265991234567) to log in with a pairing code instead of scanning a
  // QR — or leave empty to pair interactively from the web dashboard.
  pairNumber: env.PAIR_NUMBER || '',

  // ─── Dashboard control API ───────────────────────────────────────────────
  // The web dashboard (Cloudflare Pages app) links to this bot with a URL and
  // a shared token. The bot then serves /admin/api/{status,users,pair} from
  // this port, and optionally pulls the member whitelist from the dashboard.
  //
  //   ADMIN_DASHBOARD_TOKEN  same value saved in the dashboard's Admin Console
  //   ADMIN_API_PORT         port to listen on inside the panel (default 3000)
  //   DASHBOARD_URL          dashboard origin, enables whitelist pull sync
  admin: {
    token: env.ADMIN_DASHBOARD_TOKEN || '',
    syncToken: env.BOT_SYNC_TOKEN || env.ADMIN_DASHBOARD_TOKEN || '',
    apiEnabled: !/^(0|false|no|off)$/i.test(String(env.ADMIN_API_ENABLED ?? 'true')),
    // Pterodactyl hands the container a port (SERVER_PORT / PORT); on other
    // hosts ADMIN_API_PORT (or ADMIN_PORT) is the one to set. 3000 is last resort.
    port: Number(env.ADMIN_API_PORT || env.ADMIN_PORT || env.SERVER_PORT || env.PORT || 3000),
    dashboardUrl: (env.DASHBOARD_URL || '').replace(/\/+$/, ''),
    corsOrigins: String(env.ADMIN_CORS_ORIGINS || '')
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean),
    syncMinutes: Number(env.DASHBOARD_SYNC_MINUTES || 5),
    syncIntervalMs: Number(env.DASHBOARD_SYNC_INTERVAL_MS || 10_000),
  },

  // ─── Movies & series (.movie / .series) ──────────────────────────────────
  // The engine needs a free TMDB key (themoviedb.org) for titles/posters.
  // Torrent sources use debrid when configured, otherwise download directly.
  movies: {
    // ── metadata sources ──────────────────────────────────────────────────
    // TMDB is the primary source (free key). Everything below it is a fallback
    // and none of them is required: the engine uses whatever answers.
    tmdbKey: env.TMDB_API_KEY || '',
    omdbKey: env.OMDB_API_KEY || '',                 // optional: ratings/runtime
    traktClientId: env.TRAKT_CLIENT_ID || '',        // optional: trending/ids
    metadata: {
      cinemeta: env.META_CINEMETA !== '0',           // keyless (Stremio)
      imdb: env.META_IMDB !== '0',                   // keyless suggestions / bulk index
      tvmaze: env.META_TVMAZE !== '0',               // keyless episode guides
      omdb: env.META_OMDB !== '0',
      trakt: env.META_TRAKT !== '0',
      anime: env.META_ANIME !== '0',                 // Jikan + AniList
    },
    imdbIndexFile: env.IMDB_INDEX_FILE || 'temp/imdb-index.tsv',   // optional bulk dump index

    // ── debrid (unlocks the torrent tier) ─────────────────────────────────
    // DEBRID_API_KEY is accepted as a generic alias (Real-Debrid by default)
    realDebridKey: env.REALDEBRID_API_KEY || env.DEBRID_API_KEY || '',
    allDebridKey: env.ALLDEBRID_API_KEY || '',
    torrentDirect: !/^(0|false|no|off)$/i.test(String(env.TORRENT_DIRECT ?? 'true')),
    torrentMinSeeds: Number(env.TORRENT_MIN_SEEDS || 3),
    torrentMetadataTimeoutMs: Number(env.TORRENT_METADATA_TIMEOUT_MS || 90_000),
    torrentStallTimeoutMs: Number(env.TORRENT_STALL_TIMEOUT_MS || 180_000),

    // 1080 → 720 → 480 instead of failing when a quality has no source
    qualityFallback: env.QUALITY_FALLBACK !== '0',

    defaultQuality: Number(env.MOVIE_QUALITY || 720),
    // WhatsApp send ceiling (used by the engine's own ranking) …
    maxSendMB: Number(env.MOVIE_MAX_MB || movieCapDefault),
    // … and the download cap. Above maxSendMB files are still sent: the bot
    // puts anything bigger than drimeThresholdMB on Drime and posts the link.
    maxDownloadMB: Number(env.MOVIE_MAX_DOWNLOAD_MB || movieCapDefault),
    minFreeMB: Number(env.MOVIE_MIN_FREE_MB || 800),  // refuse a download below this
    diskSizeMultiplier: Number(env.MOVIE_DISK_SIZE_MULTIPLIER ?? 1.5),
    diskOverheadMB: Number(env.MOVIE_DISK_OVERHEAD_MB ?? 400),
    unknownSizeMB: Number(env.MOVIE_DISK_UNKNOWN_SIZE_MB ?? 2000),

    region: env.REGION || 'US',
    episodeBatchLimit: Number(env.MOVIE_BATCH_LIMIT || 10),
    // attach the English subtitle (.srt) that MovieBox serves with the stream
    subtitles: env.MOVIE_SUBTITLES !== '0',
    subtitleLang: env.MOVIE_SUBTITLE_LANG || 'en',

    // ── disk hygiene ─────────────────────────────────────────────────────
    // Nothing is cached: a delivered movie/episode is DELETED as soon as
    // WhatsApp has taken it (the file, its temp copy and its subtitle).

    // engine storage — stays inside the bot's ./temp folder
    tempDir: env.MOVIE_TEMP_DIR || 'temp/movies',
    dataDir: env.MOVIE_DATA_DIR || 'temp/movies/data',

    // movies from different chats download in parallel (1–2 for a 10 GB plan)
    queueConcurrency: Math.max(1, Number(env.MOVIE_CONCURRENCY || 2)),
    jobTimeoutMs: Number(env.MOVIE_JOB_TIMEOUT_MS || 60 * 60 * 1000),
    dryRun: env.MOVIE_DRY_RUN === '1',                // resolve only, send the link

    // Legacy switch for deployments that disable direct torrent downloads.
    skipTorrentWithoutDebrid: env.SKIP_TORRENT_WITHOUT_DEBRID !== 'false',
  },

  // ─── Drime Cloud Storage (drime.cloud) ───────────────────────────────────
  // Replaces the old Google Drive + Service Account setup. Get an access
  // token from Drime Cloud → Account Settings → Developers.
  drime: {
    // Set DRIME_API_TOKEN in .env or panel Startup Variables (never commit keys).
    // Get it from Drime Cloud → Account Settings → Developers.
    apiToken: env.DRIME_API_TOKEN || '',
    baseUrl: env.DRIME_BASE_URL || 'https://app.drime.cloud/api/v1',
    // Folder ID (numeric) of the folder in your Drime workspace that
    // contains the past-papers vault — from GET /drive/file-entries.
    papersFolderId: Number(env.DRIME_PAPERS_FOLDER_ID || 841342462),
    // Folder hash (from the folder's Drime URL) — required for windowed
    // listing of large vaults. Stays valid unless the folder is recreated.
    papersFolderHash: env.DRIME_PAPERS_FOLDER_HASH || 'ODQxMzQyNDYyfA',
    // 0 = personal workspace. Set to a workspace ID if papers live in a
    // shared Drime workspace instead.
    workspaceId: Number(env.DRIME_WORKSPACE_ID || 0),
  },
};
