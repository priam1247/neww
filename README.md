# ZaFar WhatsApp Bot & Control Room

A command-driven WhatsApp bot built on Baileys v7 with an integrated Past-Paper Vault, streaming media & movie/series downloader, 9 GB folder-quota disk guard, and a standalone Next.js 16 Control Room (`dashboard/`). **The bot responds to prefixed commands only — natural-language/AI routing and edited-message re-execution are disabled.**

## Commands

```text
.movie <title> [year] [quality]        Download a movie (480/720/1080/2160) with poll picker
.series <title> s01e03 [quality]       Download one episode (supports titles like "9-1-1", "Full House")
.series <title> s01 1-6 [quality]      Download an episode range
.series <title> s01 full               Season pack (Drime link when oversized)
.info <title> [series]                 Metadata + provider IDs + active catalogs
.providers / .moviestatus              Source circuit-breakers, queue depth, and disk usage
.paper <course-code> [module] [year]   Search & send past papers (capped per query, 3-day dedupe)
.paper browse [letter|code] [page]     Paginated course/module directory
.countpapers [course-code]             Count papers in the vault
.song <name-or-YouTube-link>           ID3-tagged MP3 via yt-dlp + Cobalt/Gifted fallbacks
.ytv <name-or-YouTube-link> [quality]  Download YouTube MP4 with silent-audio verification
.dl <URL> [audio|video] [quality]      Universal downloader (~1,000 sites, streamed to disk)
.tiktok <URL>  .x <URL>  .pinterest <URL>  .instagram <URL>  .fb <URL>
.spotify <Spotify URL or artist - title>
.sticker (reply to media)              512x512 WebP sticker
.viewonce (reply to view-once media)   Unwrap view-once photo/video/audio (open to allowed users)
.menu / .ping
```

Interactive title and quality choices use **WhatsApp Polls** (with automatic numbered-reply fallback `1`, `2`, … or `cancel`), scoped strictly to the sender and quoted prompt.

## Background link jobs

A bare link (nothing else in the message) from an allowed user in a direct chat is queued and answered with `⚙️ Queued #<id>`. Results up to `INLINE_LIMIT` return as normal WhatsApp media; larger files are uploaded with `rclone` and returned as a share link. Jobs are stored in `database/jobs.sqlite` (built-in `node:sqlite`) and resume after a restart — two run at once, one per provider.

```text
URL_JOBS=1                 set 0 to disable
INLINE_LIMIT=104857600     bytes that still go inline (100 MB)
MEDIA_DIR=temp             staging folder for downloads
RCLONE_REMOTE=gdrive       remote name from secrets/rclone.conf
RCLONE_PATH=bot/uploads    folder inside that remote
```

DRM-protected services (Netflix, Disney+, Apple TV+, Apple Music, Deezer) are refused with a short reason instead of being queued.

Owner/admin commands (hidden from non-owners in `.menu` and error hints):
`.status` (alias `.update`), `.restart`, `.broadcast`, `.on`, `.off`, `.allow`, `.disallow`, `.listusers`, `.cookies`, `.ytdl` (`status` | `update` | `repair` | `proxy` | `test`), and `.refreshpapers`.

## Repository Layout

```text
index.js            Entry point (WhatsApp socket, backoff reconnect, built-in /admin/api server)
handler.js          Command dispatch, per-user cooldown, poll/reply selection routing, error sanitizer
config.js           Central configuration (all secrets read from env vars)
commands/           Command modules (admin/, general/, media/)
utils/              Atomic jsonStore, diskSpace/diskGuard, selections, mediaPipeline, adminApi, etc.
engine/             ESM movie/series resolver & downloader (loaded via utils/movieEngine.js)
database/           Git-ignored runtime JSON state & vault_snapshot.json (backed up with .bak)
scripts/            install-ytdlp.sh and offline regression suite (scripts/selftest.js)
dashboard/          Standalone Next.js 16 web portal (deploy with Root Directory = dashboard)
Procfile            Process start command (`node --expose-gc index.js`, matching `npm start`)
```

## Quick Start

```bash
cp .env.example .env   # fill in DRIME_API_TOKEN, ADMIN_DASHBOARD_TOKEN, etc.
npm ci
npm run ytdlp:install
npm run selftest       # offline test suite (must pass before deploy)
npm start              # runs: node --expose-gc index.js
```

## Disk Budget & Concurrency (10 GB Panel Plan)

Shared container panels often report the entire host node's free space via `statfs`. ZaFar Bot protects against `ENOSPC` crashes with two layers (`utils/diskSpace.js` + `utils/diskGuard.js`):

1. **Bot-Folder Quota (`DISK_BUDGET_MB=9000`)**: Tracks actual bytes inside the bot directory (including `session/`, `database/`, `node_modules/`, and `temp/`) plus **per-job byte reservations** so concurrent downloads can never over-commit a 10 GB plan.
2. **Comparison Logging & Status**: Startup, periodic warnings, and `.status` print both `bot folder: X / 9000 MB` and `host statfs free: Y MB` so operators can compare against the panel's disk meter.
3. **Zero Caching & Boot Sweep**:
   - `QUEUE_LIGHT=20` (short social/music links) and `QUEUE_HEAVY=2` / `MOVIE_CONCURRENCY=2` (movies & episodes).
   - Every delivered media/movie file is deleted immediately after WhatsApp accepts it; `utils/cleanup.js` sweeps leftover `.part`/`.ytdl` partials on boot and caps `temp/` at `TEMP_MAX_MB` (`2048` MB default).
   - Direct torrent support (`webtorrent` optional dependency) remains enabled when `TORRENT_DIRECT=true`.

## Deploying to XS Systems / Pterodactyl Panel

### 1. Secret Rotation Order (Zero Downtime)
1. **Env First**: Add `DRIME_API_TOKEN`, `TMDB_API_KEY`, `GIFTED_API_KEY`, `ADMIN_DASHBOARD_TOKEN`, `PANEL_URL`, `PANEL_SERVER_ID`, and `PANEL_API_KEY` in the panel's **Startup Variables** (or `.env` on disk).
2. **Code Second**: Merge/push to `main`. `.github/workflows/deploy-panel.yml` runs `npm ci && npm run selftest` + builds `dashboard/` **before** uploading via SFTP.
3. **Revoke Old Keys Last**: Once `.status`, `.paper`, and `.movie` are verified on the live bot, revoke/regenerate any previously hardcoded keys in Drime Cloud, TMDB, Gifted, and the panel.

### 2. Dedicated Restricted Panel Subuser (Recommended for SFTP & `PANEL_API_KEY`)
Never put your master panel account password or an unrestricted account API key into GitHub Actions or `.env`:
1. In the panel, open your server → **Users (Subusers) → New User** and invite a dedicated service email (e.g. `bot-deploy@yourdomain.com`).
2. Grant **only** these permissions:
   - **Control**: `control.console` (read), `control.restart` (for `.restart` and post-deploy restart)
   - **File**: `file.create`, `file.read`, `file.read-content`, `file.update`, `file.sftp` *(leave `file.delete` unchecked if you want SFTP physically unable to delete `session/` or `database/`)*
3. Log in once as that subuser:
   - Copy its **SFTP Username & Password** into GitHub Secrets `PANEL_SFTP_USER` / `PANEL_SFTP_PASS`.
   - Generate a Client API Key (`ptlc_…`) under **Account → API Credentials** and set it as `PANEL_API_KEY` (both in GitHub Secrets for CI restart and in panel Startup Variables for the `.restart` WhatsApp command).

### 3. Manual Panel File Cleanup After Upgrading
Because `.github/workflows/deploy-panel.yml` runs `lftp mirror -R` **without `--delete`** (so `session/`, `.env`, and `database/*.json` — especially `database/vault_snapshot.json` — are never wiped), delete these obsolete files once in the panel's **Files** tab after deploying:

- `admin-server.js` *(replaced by `utils/adminApi.js` inside `index.js`)*
- `utils/heapPlan.js` *(heap re-exec removed; `Procfile` & `npm start` pass `--expose-gc` directly)*
- `utils/memoryWatchdog.js` *(replaced by `utils/diskSpace.js` + `utils/diskGuard.js`)*
- `commands/media/instagram.js` *(merged into streaming `commands/media/shortcuts.js`)*
- `commands/media/facebook.js` *(merged into streaming `commands/media/shortcuts.js`)*
- `engine/core/locker.js` *(unused stub removed)*

> **Do NOT delete** `session/`, `.env`, or `database/*.json` (`whitelist.json`, `botstate.json`, `media_settings.json`, `paper_log.json`, `vault_snapshot.json`) on the panel! Keeping `database/vault_snapshot.json` avoids walking ~10,900 Drime files on cold boot.

## Linking the Web Dashboard (`dashboard/`)

See [`dashboard/README.md`](./dashboard/README.md) for full Vercel / self-hosted portal instructions.

- **Architecture**: `dashboard/` is a standalone Next.js 16 app using **Local-First Cloudflare D1 + `bcryptjs`** authentication (no external Koyeb auth dependency), login rate limiting (`429` + `Retry-After`), mandatory `JWT_SECRET_KEY` in production, and a 3-second fast-fail bot status proxy.
- **Bot Bridge**: Set `ADMIN_DASHBOARD_TOKEN` and `ADMIN_API_PORT` on the bot. Expose the port over HTTPS via **Cloudflare Tunnel** (`cloudflared tunnel --url http://127.0.0.1:3000` or a named Zero Trust tunnel) and save the `https://` URL + token inside `/admin` → **Bot & Numbers**.
- **CORS**: `utils/adminApi.js` no longer sends `Access-Control-Allow-Origin: *`. Server-to-server requests from `dashboard/` need no CORS headers; if you explicitly allow a browser origin, set `ADMIN_CORS_ORIGINS=https://your-portal.vercel.app`.

## License

MIT — Baileys by @whiskeysockets, ZaFar Bot & Control Room.
