# ZaFarBot 3.3 (merged, panel-hardened)

A WhatsApp media bot that resolves movies and series through a **tiered provider cascade**, verifies files before downloading, and streams them to your chat. Rebuilt from the ground up as a challenge against the ZaFarBot 2.0 source drop — then **merged with the classic Zafar-bot** (song/ytv/dl, stickers, Telegram packs, past papers) into one clean codebase.

**Self-bot by design.** Commands typed on the linked phone itself (`fromMe`) are executed — the bot's own replies are recognised and never re-processed, so it can't answer itself.

**Session auto-repair.** A burst of "Bad MAC" decrypt errors after re-pairing is usually just old queued messages replaying — skipped silently. But if *fresh* messages keep failing to decrypt with zero successes, the stored keys are corrupted: the bot wipes `./session` and re-pairs by itself (capped at 2 attempts, then it tells you the one manual step).

**Engine + CLI: zero npm dependencies.** The media engine runs on stock Node 18+. The WhatsApp adapter (Baileys) ships as a **regular dependency** and is triple-protected on panels: the egg's `npm install` installs it (it's not optional anymore), `start.sh` preflights it, and the bot **self-installs it at boot** if both somehow miss — then degrades to CLI mode instead of dying. yt-dlp is auto-installed on first use of the music/video commands.

---

## What the merge added (Zafar-bot → 3.3)

| Feature | Where it lives now | Notes |
|---|---|---|
| `.song` / `.ytv` | `providers/local/ytdlp.js` + `media/pipeline.js` | full yt-dlp engine ported to ESM: binary auto-install, capability probing, player-client escalation under a deadline, cookies/proxy, honest error classification |
| `.dl` + `.tiktok` `.x` `.pinterest` `.instagram` `.fb` | `commands/dl.js` | one pipeline for ~1000 sites; cobalt + Gifted remote fallbacks |
| `.spotify` | `providers/local/spotify.js` | oEmbed metadata (no key needed) → YouTube match → MP3 |
| `.sticker` | `commands/sticker.js` | ffmpeg conversion + **dependency-free** webp EXIF pack metadata (`media/webpExif.js` replaces node-webpmux) |
| `.viewonce` | `commands/viewonce.js` | reveal view-once media |
| `.tgpack` / `.tgsticker` | `media/telegram.js` | Telegram sticker packs; animated `.tgs` gets an honest "unsupported" (needs native lottie) |
| `.paper` / `.countpapers` / `.refreshpapers` | `media/papers.js` | Drime Cloud past-paper vault: windowed walks, delta sync, persistent snapshot, "did you mean" typo suggestions |
| `.allow` `.disallow` `.listusers` `.on` `.off` `.mode` | `bot/access.js` + `commands/admin.js` | whitelist access control + kill-switch, persisted in one atomic JSON store |
| `.cookies` / `.ytdl` | `commands/admin.js` | YouTube cookie management + engine repair from the chat |
| Numbered pickers | `bot/selections.js` | reply "2" to pick — sender-isolated, TTL, cancel; also wired into the movie/series flow |
| Session string + pairing code | `bot/wa.js` | `SESSION_ID="ZaFarBot!…"` bootstrap and `PAIR_NUMBER` login alongside the QR flow |
| Message hygiene | `bot/wa.js` | container unwrapping (viewOnce/ephemeral/edited), dedup, 5-min age gate, single-flight restarts, suppressed socket noise |
| Ops hardening | `core/watchdog.js` | ENOSPC-safe process guards, temp sweeper, memory watchdog with heap/cgroup auto-detection |
| `.broadcast` `.restart` `.ping` `.menu` | `commands/admin.js` / `extra.js` | owner ops + chat niceties |

---

## What changed vs 2.0 — and why it matters

| # | 2.0 problem | 3.0 fix |
|---|---|---|
| 1 | **Tier 0 was dead code** — `probeCache()` exported but never called; no provider registered at tier 0 | Virtual `debridcache` provider wired into the cascade (3.0–3.2). **Retired in 3.3 together with TorBox** — its API needs a Pro plan; RealDebrid/AllDebrid resolve in the normal cascade |
| 2 | **Language regex bug** — `'\bHINDI\b'` in a JS string is backspace chars (0x08), so Hindi/Tamil/Korean… detection never matched | Real `\b` regexes; regression-tested |
| 3 | **extract.js truncated mid-function** in the shipped source (packer unpacker cut off) | Complete Dean Edwards unpacker + base64/hex/JS/meta-refresh URL sniffers, unit-tested |
| 4 | **Caches died on restart** — meta/links/negative caches in bare Maps; downloaded files became untracked orphans | Atomic JSON snapshots, boot restore, orphan sweep, LRU eviction — restart-safe |
| 5 | **Crude provider backoff** — a Map with a timer | Real circuit breaker: closed → open → half-open with probe limiting, per-provider EMA latency, trust scoring |
| 6 | **Queue fairness bug** — the per-user cap counter reset on every dispatch, so one chat could still monopolise | Consecutive-slot streak per user; others get served within `perUserQueueCap` jobs — tested |
| 7 | **Hanging job stalled the whole queue** — `await job()` never settled | Jobs race their timeout; the queue keeps draining — tested |
| 8 | **ffprobe hard dependency** in verification | ffprobe when available; magic-byte container sniffing (mp4/mkv/webm/avi/ts) as fallback |
| 9 | **`videasy` provider referenced but missing** — boot crash for anyone importing the media index | Implemented + `apibay` (TPB) and `solidtorrents` indexers added → **14 providers** |
| 10 | **cheerio hard dependency** for DDL scrapers | Zero-dep regex DOM helpers (`anchors`, entity decoding) with shared cookie jar |
| 11 | **Series command season parsing** — self-contradictory expressions (series.js:91–94) | Structured `parseSeriesRequest()` with its own test file |
| 12 | **No observability** — bare console.log | Leveled structured logging, event bus, metrics with `/stats` dashboard |
| 13 | **No tests at all** | **143 tests**: parser, ranker, cache persistence, queue, breaker, packer, HTTP layer, magic bytes, session-heal decisions, config defaults + live network smoke tests that auto-skip offline |
| 14 | **Config failed silently at runtime** | Boot-time validation with actionable warnings; every value env-tunable |

## Architecture

```
WhatsApp (Baileys)  ─┐
CLI (dev)           ─┤→ handler → commands ─→ media engine
                                            │
                    ┌───────────────────────┘
                    ▼
        resolver ── tier cascade, deadline-hedged
        ├── t1  torrent       knaben · torrentio · yts · eztv · nyaa · apibay · solidtorrents
        ├── t2  ddl           hdhub4u · 4khdhub · moviesdrive
        └── t3  hls           vidlink · vidsrc · videasy
                    │
        ranker      scoring: quality, source ladder, log-seeds, size window, trust×
        verify      HEAD size + ffprobe height (±240p) + magic bytes
        debrid      realdebrid → alldebrid (first success wins; TorBox removed — Pro-only API)
        download    streamed to disk, resume-aware, low-disk guard
        cache       meta 24h · links 6h · negative 30m · disk LRU 20GB/72h — persistent
```

## Quick start

```bash
# 1. configure
cp .env.example .env
#    TMDB_API_KEY is pre-filled with the owner's key (free at themoviedb.org)
#    set at least one debrid key: REALDEBRID_API_KEY or ALLDEBRID_API_KEY

# 2. run tests
npm test                 # full suite (skips live tests when offline)
npm run test:offline     # units only

# 3a. WhatsApp
npm install              # installs the full tree (baileys included, lockfile-pinned)
npm start                # pairing code prints for the default PAIR_NUMBER — or scan
                         # a QR (PAIR_NUMBER=0), or set SESSION_ID="ZaFarBot!..."
                         # (generate one: npm run session:gen)
#    the owner/admin number is preconfigured (OWNER_NUMBER, default = pair number)

# 3b. or try the engine without WhatsApp
node cli.js providers                     # health table
node cli.js movie "inception 2010" 1080   # full resolve + download to ./temp/media
node cli.js series "breaking bad" s01e01 720
npm run demo                              # offline ranking demo
```

## Commands

### Movies & series (4-tier cascade)
| Command | What it does |
|---|---|
| `/movie <title> [year] [quality]` | download a movie (480/720/1080/2160) |
| `/series <title> s01e03 [quality]` | single episode — the default path |
| `/series <title> s01 range 1-6` | batch episodes, queued fairly |
| `/series <title> s01 full` | season pack link (debrid-cached packs) |
| `/netflix [mmovies\|tv] [page]` | Netflix catalog for your region |
| `/subs <title> s01e03 [lang]` | subtitles (OpenSubtitles, optional key) |
| `/providers` | live health: wins, fails, trust, latency, breaker state |
| `/stats` | engine metrics dashboard |
| `/cache` | cache usage (`/cache wipe` — owner only) |

### Music & video (yt-dlp + cobalt, merged)
| Command | What it does |
|---|---|
| `/song <name-or-link> [audio\|doc]` | YouTube → MP3 (search shows a numbered list; `--first` skips) |
| `/ytv <name-or-link> [144-1080]` | YouTube → MP4 with automatic quality fallback |
| `/dl <link> [audio\|video] [quality]` | any of ~1000 sites |
| `/tiktok /x /pinterest /instagram /fb <link>` | site shortcuts |
| `/spotify <link or "artist - title">` | track metadata → matching MP3 |

### Tools & papers (merged)
| Command | What it does |
|---|---|
| `/sticker` (reply to media) | image/video → WhatsApp sticker |
| `/viewonce` (reply) | reveal view-once media |
| `/tgpack /tgsticker [name\|keyword]` | Telegram sticker packs (TELEGRAM_BOT_TOKEN) |
| `/paper <code> [module] [year]` | past-paper vault search (DRIME_* env) |
| `/paper browse [code]` · `/countpapers` | explore the vault |

### Admin (owner only)
| Command | What it does |
|---|---|
| `/allow <n>` `/disallow <n>` `/listusers` | whitelist management (ACCESS_MODE=whitelist gates strangers) |
| `/on` `/off` `/mode open\|whitelist` | kill-switch + access mode |
| `/cookies set\|test\|clear` | YouTube cookies (cures bot-checks) |
| `/ytdl status\|update\|repair\|proxy\|engine\|fallback` | downloader engine diagnostics |
| `/broadcast <msg>` `/restart` `/botinfo` | ops |

## Design notes

- **Fail fast, rank smart.** Providers that produce junk get tripped by the breaker automatically; survivors earn trust (0.5–1.6×) that multiplies their candidates' scores.
- **Never trust the label.** A "1080p" candidate that ffprobe measures at 480p gets rejected, not downloaded.
- **Honest errors.** The yt-dlp engine classifies failures (bot-check vs geo-block vs private vs DRM…) — "blocked in your region" is only ever printed for a real geo-block.
- **Respect the disk.** Streaming downloads with backpressure, resume support, free-space checks, and an ENOSPC process guard that sweeps temp instead of crashing.
- **One job at a time by default** (`CONCURRENCY=1`) — WhatsApp document uploads are the bottleneck; raise it if you host for many chats.
- **`DRY_RUN=1`** resolves and prints links without downloading — handy for CI.
- **No key sprawl.** Everything merged degrades gracefully: no Drime token → `.paper` explains itself; no Telegram token → `.tgpack` explains itself; no yt-dlp → auto-install or an actionable message.

## Docker

```bash
docker compose up -d     # see docker-compose.yml; mounts ./session and ./temp
```

## Deploying on Pterodactyl (and similar panels)

Panel eggs run `npm install --omit=dev` **only when `node_modules` is missing** — a stale
tree from an earlier deploy never gets fixed. 3.3 defends in depth: Baileys is a regular
`dependencies` entry (never silently skipped), `package-lock.json` pins the tree, the bot
self-installs the adapter at boot, and a missing adapter degrades to CLI mode instead of
crashing the server.

### Recommended setup (once)

1. Upload the zip contents to `/home/container` (so `index.js`, `start.sh`,
   `package.json`, `package-lock.json` sit at the container root).
2. Set the egg's **Startup** variables:
   - `JS_FILE=index.js` (default — works out of the box)
   - `TMDB_API_KEY` (preconfigured), `REALDEBRID_API_KEY` or `ALLDEBRID_API_KEY`,
     `OWNER_NUMBER` (preconfigured)
   - optionally `RESTART_LOOP=1` if the egg's crash detection stays disabled
3. Change the startup command to `bash /home/container/start.sh` — or leave the default;
   both work (start.sh adds preflight + install retries + optional supervisor).

### If it was already half-deployed (band-aid)

Set once on the Startup tab, start, watch npm resolve the tree, then set back to `0`:

```
FORCE_INSTALL = 1
NODE_PACKAGES = @whiskeysockets/baileys
```

`NODE_PACKAGES` installs unconditionally (before the gated install); `FORCE_INSTALL=1`
rebuilds the whole `--omit=dev` tree. Afterwards reset `NODE_PACKAGES=0` — `node_modules`
lives on the persistent volume, so you stop paying for a reinstall every boot.

### Verify, don't assume

After the first successful boot:

```bash
npm ls @whiskeysockets/baileys     # resolved version, no "missing" / "UNMET"
node -e "require.resolve('@whiskeysockets/baileys'); console.log('OK')"
```

The boot log also prints `adapter: @whiskeysockets/baileys <version>` once loaded.

### Login (pick one)

- **Pairing code (default):** the console prints a code for `PAIR_NUMBER` (265894016453).
  Phone: WhatsApp → Linked Devices → Link a device → "Link with phone number instead".
  Set `PAIR_NUMBER=0` to get a QR instead.
- **Session string (zero interaction):** on any machine run `npm run session:gen`
  (optionally with your number as the argument), pair once, and set the printed
  `SESSION_ID=ZaFarBot!…` as an egg variable. The bot writes `creds.json` on first boot
  and never overwrites an existing session.

The session persists in `./session` — it survives restarts; delete it to re-pair.

### "Bad MAC" / failed to decrypt (session repair)

A burst of `Failed to decrypt message… Bad MAC` / `Session error` lines right after
linking is **old queued messages replaying** — WhatsApp hands the new device messages
that were encrypted for the previous session's keys. Those specific messages can never
decrypt; every Baileys bot skips them and keeps working. 3.3 additionally silences the
console spam (libsignal prints it outside the logger) and folds it into one summary line.

If the console never quiets down **and** the bot answers nothing, the stored keys are
corrupted. 3.3 auto-heals: sustained fresh-message failures with zero decodes →
it wipes `./session`, restarts, and prints a fresh pairing code (up to 2 attempts;
after that it prints the manual fix).

Manual fix (any version):

1. Panel → File Manager → delete the `session` folder → restart → pair once, **or**
2. set `RESET_SESSION=1` once → restart → a fresh pairing code prints → link →
   remove the variable again.

> Commands typed on the linked phone are self-bot messages (`fromMe`) — 3.3 handles
> them and replies in the same chat. The two `npm warn install-scripts` lines during
> install (baileys preinstall / protobufjs postinstall) are panel hardening and harmless.

### If `npm install` itself keeps failing

| Symptom in console | Likely cause | Fix |
|---|---|---|
| `npm error code EALLOWGIT` / "git have been disabled" | npm 12 blocks git deps by default; Baileys needs its libsignal fork from git | ship the included `.npmrc` (`allow-git=all`) — it is read by every npm run in the project; for a manual quick fix create `.npmrc` in `/home/container` with `allow-git=all`, then restart |
| npm dies instantly / ENOSPC | volume full (`df -h /home/container`) | free space: `du -sh node_modules .npm-cache temp`, delete old media |
| `node-gyp` / `make` errors | image lacks build tooling | Baileys is pure JS — this means a stray native dep; `rm -rf node_modules package-lock.json` and retry with the shipped lockfile |
| half-written modules after a crash | corrupted cache/tree | `rm -rf node_modules .npm-cache && npm cache clean --force` then restart (start.sh refills everything) |
| wrong Node ABI warnings | egg Node ≠ project engines | project needs Node ≥ 18.17 (you're on v22 — fine) |

### Restart policy

"Aborting automatic restart, crash detection is disabled" is an egg setting, not a bug:
enable crash detection on the egg (so non-zero exits restart), **or** run with
`RESTART_LOOP=1` via start.sh (built-in supervisor). Pick one — not both.

Minimum viable panel setup: upload files → set `TMDB_API_KEY` → start → enter the
pairing code on your phone → send `/menu` to the bot.

## License

MIT — for personal use. Respect the source sites' terms and your local laws.
