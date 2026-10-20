# ZaFar WhatsApp Bot

A command-driven WhatsApp bot built with Baileys. It supports past-paper lookup, media downloads, stickers, view-once media handling, and owner administration. **The bot responds to commands only; natural-language/AI routing has been removed.**

## Commands

```text
.movie <title> [year] [quality]        Download a movie (480/720/1080/2160)
.series <title> s01e03 [quality]       Download one episode
.series <title> s01 1-6 [quality]      Download an episode range
.series <title> s01 full               Season pack (link when it is huge)
.info <title> [series]                 Metadata + provider ids + which sources answered
.providers                             Movie/series source health (download + metadata)
.moviestatus                           Engine counters, cache and queue
.paper <course-code> [module] [year]   Search and send past papers
.paper browse [course-code]            Browse available courses/modules
.countpapers                           Count papers in the vault
.song <name-or-YouTube-link>           Download audio
.ytv <name-or-YouTube-link> [quality]  Download video
.dl <URL> [audio|video] [quality]      Download supported media from a URL
.tiktok <URL>   .x <URL>   .pinterest <URL>
.spotify <Spotify URL or artist - title>
.instagram <URL>   .fb <Facebook URL>
.sticker (reply to media)   .viewonce (reply to view-once media)
.tgpack / .tgsticker
.menu / .ping
```

Media searches may show numbered choices; reply with the requested number or `cancel`. In chats where the bot is enabled, messages without the configured prefix are ignored. The default prefix is `.`.

Owner/admin commands include `.on`, `.off`, `.restart`, `.update`, `.broadcast`, `.allow`, `.disallow`, `.listusers`, `.cookies`, `.ytdl`, and `.refreshpapers`.

## Setup

```bash
npm ci
npm run ytdlp:install
npm start
```

The bot needs a WhatsApp session. Set `SESSION_ID` or use the pairing flow (`PAIR_NUMBER`); session credentials are stored under the configured session directory and must not be committed. The bot also needs ffmpeg for conversions. Install it on the host if `ffmpeg-static` cannot run there.

Run offline regression tests with:

```bash
npm run selftest
```

The test suite uses a fake yt-dlp executable and mocked WhatsApp/API responses; it does not validate live WhatsApp, YouTube, Drime, or third-party service behavior.

## Movies & series

`.movie` and `.series` are powered by a self-contained engine in `engine/`.
It is written as ES modules (its own `package.json` sets `"type": "module"`), so
the CommonJS bot loads it with a dynamic `import()` through
`utils/movieEngine.js`; `config.js` is the single place to configure it.

### It runs *inside* the bot, not next to it

`utils/movieHost.js` is the adapter that makes the engine use everything this
bot already has, so movies behave exactly like `.dl` / `.song` / `.paper`:

| The bot already has | Movies & series use it for |
|---|---|
| `utils/tempManager` | all staging in `temp/movies/` (never swept by `cleanup.js`) |
| `utils/mediaTransfer` | streamed downloads with size caps + real container sniffing |
| `utils/ffmpeg` | remux/transcode to WhatsApp-playable mp4 (incl. HLS sources) |
| `utils/selections` | the numbered picker (`reply with a number`) |
| reactions | ⏳ → ✅ / ❌ — no chat spam while a movie downloads |
| `.dl` send rule | playable **video** ≤ 50 MB, **document** above |
| Drime Cloud (`.paper`) | permanent link for anything too big for WhatsApp |
| `utils/movieEngine` | fair queue: a 2 GB movie cannot starve `.song` or `.paper` |

If one of those helpers is missing the engine keeps working and only loses that
one capability — `.movie` can never take the rest of the bot down with it.

### Metadata sources (all 8, merged into one item)

A title can come from any of these; results are merged per film, so one title
appears once with **every** id the download providers need. A source that is
down, rate-limited or has no key is skipped — never fatal.

| Source | Needs | Covers | Gives |
|---|---|---|---|
| **TMDB** | free key | movies + TV, all years | tmdb id, imdb id, episode guide, posters |
| **Cinemeta** (Stremio) | nothing | movies + TV | **imdb id + tmdb id**, posters, ratings |
| **IMDb** | nothing | everything | imdb id, title, year (suggestion API) |
| **IMDb bulk dump** | nothing (opt-in) | every title ever made | imdb id, offline, no rate limits |
| **TVMaze** | nothing | TV only | episode count, air dates, niche shows |
| **OMDb** | free key | movies + TV | IMDb rating, runtime, cast |
| **Trakt** | free client id | movies + TV | trending, ids for odd titles |
| **Jikan** (MAL) | nothing | anime | mal id, episode count, alt titles |
| **AniList** | nothing | anime | romaji titles, second index |

What that buys you: `.movie` / `.series` keep working when TMDB is down or has no
match — Cinemeta alone returns both ids, and the torrent indexers only need the
IMDb one. `.info <title>` shows exactly which ids and sources answered.

How a request flows:

```text
.movie / .series
   └─ metadata: TMDB → Cinemeta → IMDb → TVMaze → OMDb → Trakt → Jikan → AniList
        (merged per title; numbered picker when ambiguous)
   └─ engine queue (1 heavy job at a time, fair per chat)
        ├─ tier 1  torrent  knaben · torrentio · yts · eztv · nyaa · apibay · solidtorrents
        ├─ tier 2  ddl      hdhub4u · 4khdhub · moviesdrive → locker resolution → direct file
        └─ tier 3  stream   vidlink · vidsrc · videasy → HLS
   └─ quality ladder: 1080 → 720 → 480 (and up when only 4K exists)
   └─ verification: real size, container magic bytes, ffprobe quality check
   └─ streamed download (resume + stall guard) → document upload → LRU cache
```

Requirements and behaviour:

* **TMDB key** — the primary metadata source (`config.movies.tmdbKey` / `TMDB_API_KEY`).
  Not a hard requirement any more: without it the bot runs on Cinemeta + IMDb +
  TVMaze (`.providers` shows which sources are live).
* **Debrid is optional.** Real-Debrid / All-Debrid unlock the torrent tier (best
  quality). Without a key the torrent tier is skipped automatically and the bot
  uses the free DDL and stream tiers; `.providers` shows exactly what is live.
* Files are staged in `temp/movies/` — inside the bot's own temp dir, in a
  subfolder `cleanup.js` never touches — and are indexed by an LRU that survives
  restarts. A file still downloading is never swept away.
* **Big files are delivered, not refused.** Anything above `DRIME_MOVIES_MB`
  (default: `video.maxMB`, 300 MB) is uploaded to the same Drime Cloud account
  `.paper` uses — documented S3 multipart flow — and the chat gets the file plus
  a permanent link. `DRIME_MOVIES=off` disables it, `=always` uploads every
  title. Upload progress shows in the same status card as the download.
* Episode batches run one episode at a time (`MOVIE_BATCH_LIMIT`, default 10).
* `.movie <title>` shows a numbered list when several films match — the bot
  downloads exactly the one you pick, never "result 1" silently.

Troubleshooting:

```text
.info <title>     ids + which metadata sources answered (diagnose "no source found")
.providers        download sources live/tripped + metadata sources live/disabled
.moviestatus      resolves, tier wins, verification rejects, cache + queue depth
MOVIE_DRY_RUN=1   resolve and print the link without downloading
QUALITY_FALLBACK=0   disable the 1080→720→480 ladder
META_CINEMETA=0 / META_IMDB=0 / META_TVMAZE=0 / META_ANIME=0   switch a source off
```

## Media downloads

The local yt-dlp engine is tried first. If it cannot handle a source, configured remote fallback providers may be used. Downloads have size/time limits, are staged in the ignored `temp/` directory, and are cleaned after each job and periodically.

For YouTube hosting-IP checks, an owner can upload a Netscape-format cookies file with `.cookies set`; use `.cookies status` to inspect availability and `.cookies clear` to remove it. Treat cookies as account credentials. `.ytdl` reports engine status; `.ytdl test <link>`, `.ytdl raw <link>`, `.ytdl update`, `.ytdl repair`, and `.ytdl proxy <url|off>` help diagnose or repair downloads.

## Past papers

Paper search uses the configured Drime Cloud API and a local vault snapshot. Configure `DRIME_API_TOKEN`, `DRIME_BASE_URL`, `DRIME_PAPERS_FOLDER_ID`, `DRIME_PAPERS_FOLDER_HASH`, and optionally `DRIME_WORKSPACE_ID`. `.refreshpapers` forces a vault refresh. `.paper browse` shows the course codes represented in the vault.

## Configuration

Environment variables can override the defaults in `config.js`. Common settings include:

```text
PREFIX OWNER_NUMBER ADMIN_NUMBERS OWNER_NAME BOT_NAME SESSION_NAME SESSION_ID PAIR_NUMBER
DRIME_API_TOKEN DRIME_BASE_URL DRIME_PAPERS_FOLDER_ID DRIME_PAPERS_FOLDER_HASH DRIME_WORKSPACE_ID
TMDB_API_KEY REALDEBRID_API_KEY ALLDEBRID_API_KEY MOVIE_QUALITY MOVIE_MAX_MB MOVIE_BATCH_LIMIT MOVIE_DRY_RUN
OMDB_API_KEY TRAKT_CLIENT_ID IMDB_INDEX_FILE QUALITY_FALLBACK
META_CINEMETA META_IMDB META_TVMAZE META_OMDB META_TRAKT META_ANIME
MOVIE_MAX_DOWNLOAD_MB DRIME_MOVIES DRIME_MOVIES_MB DRIME_MOVIES_FOLDER_ID
GIFTED_API_KEY GIFTED_API_URL TELEGRAM_BOT_TOKEN
YOUTUBE_COOKIES YOUTUBE_COOKIES_FILE YTDLP_PROXY YTDLP_DEADLINE_MS
COBALT_INSTANCES COBALT_USE_DEFAULTS SONG_SEND_AS SONG_MAX_MINUTES SEARCH_PICKER SEARCH_RESULTS
SEARCH_TTL_MINUTES SPOTIFY_CLIENT_ID SPOTIFY_CLIENT_SECRET FFMPEG_PATH MEMORY_LIMIT_MB TZ
```

Do not commit `.env`, WhatsApp session data, cookies, API tokens, runtime settings, or downloaded media. The bot is command-driven: no provider keys, AI settings, AI commands, or AI routing are required.

## License

MIT — Baileys by @whiskeysockets, original bot by ZaFar.
