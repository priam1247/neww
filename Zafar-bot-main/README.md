# ZaFar WhatsApp Bot

A command-driven WhatsApp bot built with Baileys. It supports past-paper lookup, media downloads, stickers, view-once media handling, and owner administration. **The bot responds to commands only; natural-language/AI routing has been removed.**

## Commands

```text
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
GIFTED_API_KEY GIFTED_API_URL TELEGRAM_BOT_TOKEN
YOUTUBE_COOKIES YOUTUBE_COOKIES_FILE YTDLP_PROXY YTDLP_DEADLINE_MS
COBALT_INSTANCES COBALT_USE_DEFAULTS SONG_SEND_AS SONG_MAX_MINUTES SEARCH_PICKER SEARCH_RESULTS
SEARCH_TTL_MINUTES SPOTIFY_CLIENT_ID SPOTIFY_CLIENT_SECRET FFMPEG_PATH MEMORY_LIMIT_MB TZ
```

Do not commit `.env`, WhatsApp session data, cookies, API tokens, runtime settings, or downloaded media. The bot is command-driven: no provider keys, AI settings, AI commands, or AI routing are required.

## License

MIT — Baileys by @whiskeysockets, original bot by ZaFar.
