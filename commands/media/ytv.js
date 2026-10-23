/**
 * ZaFar Bot — .ytv  (YouTube → MP4)
 *
 *   .ytv <link or search words> [144|240|360|480|720|1080]
 *
 * Search phrases show a numbered list (reply with a number to download, or
 * *cancel*); add --first to take the top hit immediately.
 *
 * Engine 1: yt-dlp — auto-updating, several YouTube player-client profiles,
 *           cookie/proxy aware, streamed to disk (RAM stays flat).
 * Engine 2: remote providers (Gifted / cobalt) when the host IP is refused.
 *
 * Quiet by design: reactions only (⏳ → ✅ / ❌), one short line only on failure.
 *
 * Upgrades over the old build:
 *   • automatic quality fallback when the requested size is too big,
 *   • one shared deadline so a hopeless job cannot hang for an hour,
 *   • the real failure reason instead of "blocked in your region".
 */

const fs = require('fs');
const path = require('path');
const config = require('../../config');
const YT = require('../../utils/youtubedl');
const ytInnertube = require('../../utils/ytInnertube');
const settings = require('../../utils/mediaSettings');
const providers = require('../../utils/downloadProviders');
const youtubeSearch = require('../../utils/youtubeSearch');
const selections = require('../../utils/selections');
const jobQueue = require('../../utils/jobQueue');
const {
  downloadToFile, ensureWhatsAppMp4, probeMedia, safeName, fmtMB,
} = require('../../utils/mediaTransfer');
const { getTempDir, deleteTempFile } = require('../../utils/tempManager');
const diskSpace = require('../../utils/diskSpace');
const log = require('../../utils/logger')('ytv');

// ─── LIMITS (config.video, see config.js) ────────────────────────────────────
const MAX_VIDEO_MB   = Number(config.video?.maxMB) || 2000;   // disk holds the file + Baileys' encrypted copy
const MAX_MINUTES    = Number(config.video?.maxMinutes) || 0;  // 0 = any length
const AS_DOC_ABOVE   = 50 * 1024 * 1024;    // above this, send as a document
const DEFAULT_HEIGHT = Number(config.video?.defaultQuality) || 720;
const QUALITIES      = [144, 240, 360, 480, 720, 1080].sort((a, b) => a - b);
const JOB_DEADLINE   = Number(config.ytdlp?.deadlineMs) || 10 * 60 * 1000;

const bar = (percent) => {
  const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
};

function sweep(prefix) {
  try {
    const dir = getTempDir();
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(prefix)) deleteTempFile(path.join(dir, f));
    }
  } catch { /* ignore */ }
}

const execute = async (sock, msg, args, extra) => {
  const chatId = extra?.from || msg.key.remoteJid;
  const say = (text) => sock.sendMessage(chatId, { text }, { quoted: msg });
  const react = (emoji) => sock.sendMessage(chatId, { react: { text: emoji, key: msg.key } }).catch(() => {});

  args = [...args];
  let height = Number(settings.get('videoQuality', 0)) || DEFAULT_HEIGHT;
  const last = String(args[args.length - 1] || '').toLowerCase().replace(/p$/, '');
  if (QUALITIES.includes(Number(last))) { height = Number(last); args.pop(); }
  const requestedHeight = height;

  // --first (or a leading !) skips the results list and takes the top hit
  let firstHit = false;
  const flagIdx = args.findIndex(a => /^--?first$/i.test(a));
  if (flagIdx !== -1) { firstHit = true; args.splice(flagIdx, 1); }

  let query = args.join(' ').trim();
  if (query.startsWith('!')) { firstHit = true; query = query.slice(1).trim(); }

  if (!query) {
    return say(`Usage: .ytv <name or link> [360|480|720|1080]`);
  }

  const attempts = [];
  let title = '', author = '', duration = 0, thumbnail = '';

  if (!YT.isYouTubeUrl(query)) {
    const maxResults = Number(config.search?.maxResults) || 5;
    const results = await youtubeSearch.searchYouTube(query, { limit: maxResults });

    if (!results.length) {
      const engine = YT.resolveCommand() || await YT.ensureInstalled();
      if (!engine) return say(YT.friendlyError({ code: 'NO_YTDLP' }, { isOwner: Boolean(extra?.isOwner) }));
      return say('❌ No results found.');
    }

    const pickerOn = config.search?.picker !== false && settings.get('searchPicker', true) !== false;
    if (results.length > 1 && pickerOn && !firstHit) {
      void YT.getInfo(results[0].url).catch(() => {});
      const listText = youtubeSearch.formatResults(results, {
        header: `🔎 *${query}*`,
        note: `Reply *1–${results.length}* (${height}p) or *cancel*.`,
      });
      await selections.sendTextPrompt(sock, msg, extra, {
        text: listText,
        image: results[0].thumbnail || null,
        items: results,
        label: 'ytv',
        ttlMs: Math.max(1, Number(config.search?.ttlMinutes) || 5) * 60 * 1000,
        run: (sock2, msg2, extra2, item) => execute(sock2, msg2, [item.url, String(height)], extra2),
      });
      await react('❓');
      return;
    }

    ({ url: query, title, author, duration, thumbnail } = {
      url: results[0].url,
      title: results[0].title,
      author: results[0].author,
      duration: results[0].duration,
      thumbnail: results[0].thumbnail,
    });
  } else {
    query = YT.normalizeYouTubeUrl(query);
  }

  // ── Metadata (best effort) ───────────────────────────────────────────────
  if (!title || !duration) {
    try {
      const i = await YT.getInfo(query, { timeout: 35000 });
      title = title || i.title; duration = duration || i.duration;
      author = author || i.uploader; thumbnail = thumbnail || i.thumbnail;
    } catch {
      try {
        const itMeta = await ytInnertube.getVideoInfo(query);
        title = title || itMeta.title; duration = duration || itMeta.duration;
        author = author || itMeta.uploader; thumbnail = thumbnail || itMeta.thumbnail;
      } catch { /* the download attempt reports the real reason */ }
    }
  }
  if (MAX_MINUTES && duration && duration > MAX_MINUTES * 60) {
    return say(`❌ Video is ${Math.round(duration / 60)} min — the limit is ${MAX_MINUTES} min.`);
  }

  let waited = false;
  return await jobQueue.runInLane('light', async () => {
    const stamp = `ytv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const outBase = path.join(getTempDir(), stamp);
    const release = require('../../utils/tempManager').holdTemp(stamp);
    let diskReservation = null;

    try {
    if (!waited) await react('⏳');
    diskReservation = diskSpace.reserveMediaSpace(getTempDir(), config.media || {}, {
      label: 'ytv',
      tagDir: getTempDir(),
      tagPrefix: stamp,
    });

    // ── Download: yt-dlp first, with automatic quality fallback ────────────
    let file = null;
    let via = 'yt-dlp';
    const deadlineAt = Date.now() + JOB_DEADLINE;
    const candidates = [height, ...QUALITIES.filter(q => q < height).reverse()].slice(0, 3);
    let ytErr = null;

    for (let i = 0; i < candidates.length && !file; i++) {
      const q = candidates[i];
      if (i > 0) { sweep(stamp); await react('📉'); }
      try {
        const res = await YT.downloadVideo(query, {
          height: q,
          outBase,
          maxMB: MAX_VIDEO_MB,
          maxSeconds: MAX_MINUTES * 60,
          deadlineMs: Math.max(20000, deadlineAt - Date.now()),
          onAttempt: (name, err, info) => {
            log.debug(`yt-dlp profile ${name} failed · ${info.code}`);
            attempts.push({ engine: `yt-dlp:${name}`, code: info.code });
          }
        });
        file = res.file;
        height = q;
      } catch (e) {
        const info = YT.classify(e);
        attempts.push({ engine: `yt-dlp:${q}p`, code: info.code });
        log.warn(`yt-dlp failed at ${q}p · ${info.code} · ${info.detail}`);
        ytErr = e;
        // Only a size/format problem is worth a lower quality; bot/proxy checks cascade immediately.
        if (!['TOO_BIG', 'NO_FORMATS'].includes(info.code)) break;
        if (Date.now() > deadlineAt - 20000) break;
      }
    }

    // ── Engine 2 (Innertube + PoToken/SABR) & Engine 3 (yt1d/remote) ───────
    if (!file) {
      const info = ytErr ? YT.classify(ytErr) : { code: 'UNKNOWN' };
      const fallbackWorthTrying = ['BOT_CHECK', 'NO_YTDLP', 'NO_FORMATS', 'FFMPEG_MISSING', 'UNKNOWN',
        'NETWORK', 'RATE_LIMIT', 'PO_TOKEN', 'AGE_RESTRICTED', 'GEO_BLOCK', 'BAD_ARGS', 'TOO_BIG', 'PROXY_ERROR'];

      if (ytErr && !fallbackWorthTrying.includes(info.code)) throw ytErr;

      await react('🔄');

      if (ytInnertube.isEnabled()) {
        try {
          const itRes = await ytInnertube.downloadVideo(query, {
            height: requestedHeight,
            outBase,
            maxMB: MAX_VIDEO_MB,
            timeoutMs: 180000,
            onAttempt: (name, err) => {
              attempts.push({ engine: name, code: err?.code || 'FAILED' });
            },
          });
          file = itRes.file;
          height = requestedHeight;
          via = itRes.authenticated ? 'innertube (oauth)' : 'innertube';
          title = title || itRes.metadata?.title || '';
          author = author || itRes.metadata?.author || '';
        } catch (itErr) {
          log.warn(`innertube video failed · ${itErr.message}`);
          attempts.push({ engine: 'innertube', code: itErr.code || 'FAILED' });
        }
      }
    }

    if (!file) {
      const remoteAllowed = settings.get('remoteFallback', true) !== false;
      if (!remoteAllowed) {
        if (ytErr) throw ytErr;
        throw Object.assign(new Error('remote fallbacks are disabled'), { code: 'FALLBACK_DISABLED', attempts });
      }

      let remoteHit = null;
      try {
        remoteHit = await providers.resolveMedia(query, {
          kind: 'video',
          quality: requestedHeight,
          timeoutMs: 75000,
          onAttempt: (name, err, st) => { if (st.code !== 'OK') attempts.push({ engine: name, code: st.code }); },
        });
      } catch (providerErr) {
        log.warn(`backup sources failed · ${providerErr.message}`);
        if (ytErr) throw ytErr;
        throw Object.assign(new Error('all download engines failed'), { code: 'NO_PROVIDERS', attempts });
      }

      via = remoteHit.provider;
      height = requestedHeight;
      const dest = path.join(getTempDir(), `${stamp}_remote.${remoteHit.ext || 'mp4'}`);
      const got = await downloadToFile(remoteHit.url, dest, {
        maxBytes: MAX_VIDEO_MB * 1024 * 1024,
        headers: remoteHit.headers
      });
      file = dest;
      title = title || remoteHit.title;
      log.info(`via ${via} · ${got.sniff.kind}/${got.sniff.ext}`);
    }

    if (!file || !fs.existsSync(file) || fs.statSync(file).size < 10 * 1024) {
      throw Object.assign(new Error('downloaded file is empty'), { code: 'NO_FORMATS' });
    }
    if (fs.statSync(file).size > MAX_VIDEO_MB * 1024 * 1024) {
      throw Object.assign(new Error('video too large'), { code: 'TOO_BIG' });
    }

    diskSpace.requireMediaCopySpace(getTempDir(), fs.statSync(file).size / 1048576, config.media || {});
    // ── Make it playable in WhatsApp (no-op without ffmpeg) ────────────────
    const ready = await ensureWhatsAppMp4(file, path.join(getTempDir(), `${stamp}_wa.mp4`));
    // Never deliver a silent video: check the audio track survived.
    const audioCheck = await probeMedia(ready);
    if (audioCheck.probed && !audioCheck.hasAudio) {
      throw Object.assign(new Error('the downloaded video has no audio track'), { code: 'NO_AUDIO' });
    }
    const size = fs.statSync(ready).size;
    const name = safeName(title, 'video');
    const caption = `🎬 *${title || name}*${author ? `\n👤 ${author}` : ''}\n📦 ${fmtMB(size)} • ${height}p${via !== 'yt-dlp' ? ` • via ${via}` : ''}`;

    // Send from disk — Baileys streams it, no big Buffer in RAM.
    if (size > AS_DOC_ABOVE) {
      const sent = await sock.sendMessage(chatId, { document: { url: ready }, mimetype: 'video/mp4', fileName: `${name}.mp4`, caption }, { quoted: msg });
    } else {
      const sent = await sock.sendMessage(chatId, { video: { url: ready }, mimetype: 'video/mp4', caption }, { quoted: msg });
    }
    await react('✅');
    require('../../utils/telemetry').recordDownloadSuccess('video');
  } catch (err) {
    require('../../utils/telemetry').recordFailure('ytv');
    log.error(`${title || query || 'video'} · ${YT.classify(err).code} · ${String(err.message).split('\n')[0]}`);
    const info = YT.classify(err);
    const merged = attempts.length ? attempts : (err.attempts || info.attempts);
    // one short line on failure, never a wall of engine detail
    if (err.code === 'TOO_BIG') {
      await say(`❌ Too large even at the lowest quality — try \`${config.prefix}ytv <link> 360\` or a shorter video.`);
    } else if (err.code === 'NOT_ENOUGH_DISK') {
      const { safeErrorMessage } = require('../../utils/userErrors');
      await say(safeErrorMessage(err, { isOwner: Boolean(extra?.isOwner) }));
    } else {
      const isOwner = Boolean(extra?.isOwner);
      const tail = isOwner ? YT.attemptsSummary(merged) : '';
      const lines = String(YT.friendlyError(err, { isOwner }) + tail).split('\n').filter(Boolean);
      await say(lines.slice(0, 3).join('\n'));
    }
    await react('❌');
  } finally {
    diskReservation?.release?.();
    release();
    sweep(stamp);
    if (typeof global.gc === 'function') global.gc();
  }
  }, async () => {
    waited = true;
    await react('⏳');
  });
};

module.exports = {
  name: 'ytv',
  aliases: ['ytvideo', 'ytmp4', 'video', 'playvid'],
  category: 'media',
  description: 'Download a YouTube video',
  usage: '.ytv <YouTube link or name> [360|480|720|1080]',
  execute,
};
