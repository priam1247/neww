/**
 * ZaFar Bot — generic media pipeline
 *
 * One implementation of "download a link and send it to WhatsApp", shared by
 * `.dl`, `.tiktok`, `.x`, `.pinterest` and `.spotify`. Everything the YouTube
 * commands learned applies here too:
 *
 *   engine 1 — yt-dlp (site-aware, cookie/proxy aware, streaming to disk)
 *   engine 2 — remote providers (Gifted / cobalt) when yt-dlp cannot do it
 *   then     — sniff the real container and send it the way WhatsApp can play it
 *
 * Supported inputs: any URL yt-dlp understands (~1000 sites) plus whatever the
 * remote providers cover. Images are sent as images (Pinterest, Instagram …).
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const YT = require('./youtubedl');
const settings = require('./mediaSettings');
const providers = require('./downloadProviders');
const jobQueue = require('./jobQueue');
const {
  downloadToFile, sniffFile, audioToMp3, tagMp3, ensureWhatsAppMp4, probeMedia, safeName, fmtMB,
} = require('./mediaTransfer');
const { getTempDir, deleteTempFile, holdTemp } = require('./tempManager');
const diskSpace = require('./diskSpace');

const MAX_VIDEO_MB = Number(config.video?.maxMB) || 2000;
const MAX_AUDIO_MB = Number(config.song?.maxMB) || 120;
const MAX_MINUTES = Number(config.video?.maxMinutes) || 0;   // 0 = any length
const AS_DOC_ABOVE = 50 * 1024 * 1024;
const JOB_DEADLINE = Number(config.ytdlp?.deadlineMs) || 10 * 60 * 1000;
const QUALITIES = [144, 240, 360, 480, 720, 1080];

const bar = (percent) => {
  const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
};

/** Parse "[audio|video] [144-1080]" written in any order (non-destructive). */
function parseOptions(args, defaults = {}) {
  const rest = [...args];
  let kind = defaults.kind || 'video';
  let height = defaults.height || Number(settings.get('videoQuality', 0)) || Number(config.video?.defaultQuality) || 720;

  for (let i = rest.length - 1; i >= 0; i--) {
    const token = String(rest[i] || '').toLowerCase();
    if (['audio', 'mp3', 'song', 'music'].includes(token)) { kind = 'audio'; rest.splice(i, 1); continue; }
    if (['video', 'mp4', 'vid', 'hd'].includes(token)) { kind = 'video'; rest.splice(i, 1); continue; }
    if (['image', 'img', 'photo'].includes(token)) { kind = 'image'; rest.splice(i, 1); continue; }
    if (QUALITIES.includes(Number(token.replace(/p$/, '')))) { height = Number(token.replace(/p$/, '')); rest.splice(i, 1); continue; }
    break; // the first non-option token is the link itself
  }
  return { kind, height, rest };
}

/** Last resort for links yt-dlp does not know: fetch the URL itself if it is a media file. */
async function downloadDirect(url, dest, maxMB, onProgress) {
  if (!/^https?:\/\//i.test(String(url || ''))) return null;
  try {
    const got = await downloadToFile(url, dest, { maxBytes: maxMB * 1024 * 1024, onProgress });
    if (['video', 'audio', 'image'].includes(got?.sniff?.kind)) return dest;
  } catch (e) {
    console.warn('[media] direct download failed:', e.message);
  }
  deleteTempFile(dest);
  return null;
}

/**
 * Download `url` and send it to the chat. Never throws for "unsupported"
 * reasons without explaining them; always cleans up its temp files.
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {'audio'|'video'|'image'} [opts.kind]
 * @param {number} [opts.height]
 * @param {string} [opts.title]  known title (e.g. from Spotify metadata)
 * @param {string} [opts.author]
 * @param {object} [opts.imageFallback]  { url } sent when the source is an image
 * @returns {Promise<{sent:boolean, kind:string, via:string}>}
 */
async function downloadAndSend(sock, msg, extra, {
  url, kind = 'video', height = 720, title = '', author = '', attempts = [],
  lane = null, waited = false,
} = {}) {
  const chatId = extra?.from || msg.key.remoteJid;
  const say = (text) => sock.sendMessage(chatId, { text }, { quoted: msg });
  const react = (emoji) => sock.sendMessage(chatId, { react: { text: emoji, key: msg.key } }).catch(() => {});

  if (lane) {
    let queued = false;
    return jobQueue.runInLane(lane, () => downloadAndSend(sock, msg, extra, {
      url, kind, height, title, author, attempts, waited: queued,
    }), async () => {
      queued = true;
      await react('⏳');
    });
  }

  const stamp = `${kind === 'audio' ? 'aud' : 'dl'}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const outBase = path.join(getTempDir(), stamp);
  const files = [];
  const release = holdTemp(stamp);
  let diskReservation = null;

  try {
    if (!waited) await react('⏳');
    diskReservation = diskSpace.reserveMediaSpace(getTempDir(), config.media || {}, {
      label: `media:${kind}`,
      tagDir: getTempDir(),
      tagPrefix: stamp,
    });

    // Best-effort metadata (the download attempt reports the real problems).
    if (!title) {
      try {
        const info = await YT.getInfo(url, { timeout: 45000 });
        title = info.title; author = author || info.uploader;
        if (kind === 'video' && MAX_MINUTES && info.duration && info.duration > MAX_MINUTES * 60) {
          await react('❌');
          return say(`❌ That is ${Math.round(info.duration / 60)} min long — the limit is ${MAX_MINUTES} min.`);
        }
      } catch (e) {
        console.warn('[media] metadata failed:', e.message);
      }
    }

    const deadlineAt = Date.now() + JOB_DEADLINE;
    let file = null;
    let via = 'yt-dlp';

    // ── Engine 1: yt-dlp ───────────────────────────────────────────────────
    try {
      const onAttempt = (name, err, info) => {
        console.log(`[media] yt-dlp profile "${name}" failed (${info.code})`);
        attempts.push({ engine: `yt-dlp:${name}`, code: info.code });
      };
      if (kind === 'audio') {
        const res = await YT.downloadAudio(url, {
          outBase, maxMB: MAX_AUDIO_MB, onAttempt,
          deadlineMs: Math.max(20000, deadlineAt - Date.now()),
        });
        file = res.file;
      } else {
        const res = await YT.downloadVideo(url, {
          height, outBase, maxMB: MAX_VIDEO_MB, maxSeconds: MAX_MINUTES * 60,
          onAttempt, deadlineMs: Math.max(20000, deadlineAt - Date.now()),
        });
        file = res.file;
      }
      files.push(file);
    } catch (ytErr) {
      const info = YT.classify(ytErr);
      attempts.push({ engine: 'yt-dlp', code: info.code });
      console.warn(`[media] yt-dlp failed (${info.code}): ${info.detail}`);

      const direct = ['UNSUPPORTED_URL', 'NO_FORMATS', 'UNKNOWN'].includes(info.code)
        ? await downloadDirect(url, `${outBase}_direct.bin`, kind === 'audio' ? MAX_AUDIO_MB : MAX_VIDEO_MB,
          undefined)
        : null;
      if (direct) {
        files.push(direct);
        file = direct;
        via = 'direct link';
      } else {
        const remoteWorthTrying = ['BOT_CHECK', 'NO_YTDLP', 'NO_FORMATS', 'FFMPEG_MISSING', 'UNKNOWN',
          'NETWORK', 'RATE_LIMIT', 'PO_TOKEN', 'AGE_RESTRICTED', 'GEO_BLOCK', 'BAD_ARGS'];
        const remoteAllowed = settings.get('remoteFallback', true) !== false;

        if (!remoteAllowed || !remoteWorthTrying.includes(info.code)) {
          ytErr.attempts = attempts;
          throw ytErr;
        }

        await react('🔄');
        let remoteHit;
        try {
          remoteHit = await providers.resolveMedia(url, {
            kind, quality: height, timeoutMs: 20000,
            onAttempt: (name, err, st) => { if (st.code !== 'OK') attempts.push({ engine: name, code: st.code }); },
          });
        } catch (providerErr) {
          console.warn('[media] backup sources failed:', providerErr.message);
          ytErr.attempts = attempts;
          throw ytErr;
        }

        via = remoteHit.provider;
        const dest = path.join(getTempDir(), `${stamp}_remote.${remoteHit.ext || (kind === 'audio' ? 'mp3' : 'mp4')}`);
        const got = await downloadToFile(remoteHit.url, dest, {
          maxBytes: (kind === 'audio' ? MAX_AUDIO_MB : MAX_VIDEO_MB) * 1024 * 1024,
          headers: remoteHit.headers,
        });
        files.push(dest);
        file = dest;
        title = title || remoteHit.title;
        console.log(`[media] downloaded via ${via} (${got.sniff.kind}/${got.sniff.ext})`);
      }
    }

    if (!file || !fs.existsSync(file) || fs.statSync(file).size < 10 * 1024) {
      throw Object.assign(new Error('downloaded file is empty'), { code: 'NO_FORMATS' });
    }

    const sniffed = sniffFile(file);
    if (sniffed.kind !== 'image') {
      diskSpace.requireMediaCopySpace(getTempDir(), fs.statSync(file).size / 1048576, config.media || {});
    }
    const viaText = via !== 'yt-dlp' ? ` • via ${via}` : '';

    // ── Images (Pinterest pins, Instagram photos …) ────────────────────────
    if (sniffed.kind === 'image') {
      const size = fs.statSync(file).size;
      if (size > MAX_VIDEO_MB * 1024 * 1024) throw Object.assign(new Error('image too large'), { code: 'TOO_BIG' });
      const sent = await sock.sendMessage(chatId, {
        image: { url: file },
        mimetype: sniffed.mime,
        caption: `🖼️ *${safeName(title, 'image')}*${author ? `\n👤 ${author}` : ''}\n📦 ${fmtMB(size)}${viaText}`,
      }, { quoted: msg });
      await react('✅');
      return { sent: true, kind: 'image', via };
    }

    // ── Audio ──────────────────────────────────────────────────────────────
    if (kind === 'audio' || sniffed.kind === 'audio') {
      let finalFile = file;
      let ext = sniffed.ext;
      let mime = sniffed.mime;

      if (ext !== 'mp3') {
        const mp3 = await audioToMp3(file, `${outBase}_wa.mp3`);
        if (mp3) { files.push(mp3); finalFile = mp3; ext = 'mp3'; mime = 'audio/mpeg'; }
      }
      // Tag before sending: a document keeps its name, but the file the user
      // saves should still show the song title and artist in any player.
      if (ext === 'mp3') {
        const tagged = await tagMp3(finalFile, `${outBase}_tagged.mp3`, { title: safeName(title, ''), artist: author });
        if (tagged) { files.push(tagged); finalFile = tagged; }
      }

      const size = fs.statSync(finalFile).size;
      if (size > MAX_AUDIO_MB * 1024 * 1024) throw Object.assign(new Error('audio too large'), { code: 'TOO_BIG' });

      const name = safeName(title, 'audio');
      const fileName = `${name}.${ext}`;
      const caption = `🎵 *${name}*${author ? `\n👤 ${author}` : ''}\n📦 ${fmtMB(size)}${viaText}`;

      // Documents by default — the filename is where the artist/song name live.
      if (String(config.song?.sendAs || 'document').toLowerCase() === 'audio') {
        const sent = await sock.sendMessage(chatId, { audio: { url: finalFile }, mimetype: mime, ptt: false, fileName }, { quoted: msg });
      } else {
        const sent = await sock.sendMessage(chatId, { document: { url: finalFile }, mimetype: mime, fileName, caption }, { quoted: msg });
      }
      await react('✅');
      return { sent: true, kind: 'audio', via };
    }

    // ── Video ──────────────────────────────────────────────────────────────
    const ready = await ensureWhatsAppMp4(file, path.join(getTempDir(), `${stamp}_wa.mp4`));
    files.push(ready);
    if (ready !== file) deleteTempFile(file);   // a 2 GB source must not sit on disk twice

    // A silent video is worse than an error: verify the audio track survived the
    // download and the remux before anything is sent.
    const audioCheck = await probeMedia(ready);
    if (audioCheck.probed && !audioCheck.hasAudio) {
      throw Object.assign(new Error('the downloaded video has no audio track'), { code: 'NO_AUDIO' });
    }

    const size = fs.statSync(ready).size;
    if (size > MAX_VIDEO_MB * 1024 * 1024) throw Object.assign(new Error('video too large'), { code: 'TOO_BIG' });

    const name = safeName(title, 'video');
    const caption = `🎬 *${title || name}*${author ? `\n👤 ${author}` : ''}\n📦 ${fmtMB(size)} • ${height}p${viaText}`;

    if (size > AS_DOC_ABOVE) {
      const sent = await sock.sendMessage(chatId, { document: { url: ready }, mimetype: 'video/mp4', fileName: `${name}.mp4`, caption }, { quoted: msg });
    } else {
      const sent = await sock.sendMessage(chatId, { video: { url: ready }, mimetype: 'video/mp4', caption }, { quoted: msg });
    }
    await react('✅');
    return { sent: true, kind: 'video', via };
  } catch (err) {
    const info = YT.classify(err);
    const merged = attempts.length ? attempts : (err.attempts || info.attempts);
    // One short line, never a wall of engine detail.
    if (info.code === 'TOO_BIG') {
      await say(`❌ Too big (video ${MAX_VIDEO_MB} MB / audio ${MAX_AUDIO_MB} MB) — try a lower quality or a shorter clip.`);
    } else if (info.code === 'NO_AUDIO') {
      await say('❌ That video has no audio track — I did not send it silently. Try another link.');
    } else if (err.code === 'NOT_ENOUGH_DISK') {
      const { safeErrorMessage } = require('./userErrors');
      await say(safeErrorMessage(err, { isOwner: Boolean(extra?.isOwner) }));
    } else {
      const isOwner = Boolean(extra?.isOwner);
      const tail = isOwner ? YT.attemptsSummary(merged) : '';
      const lines = String(YT.friendlyError(err, { isOwner }) + tail).split('\n').filter(Boolean);
      await say(lines.slice(0, 3).join('\n'));
    }
    await react('❌');
    // The user has already been told what happened — report it, don't throw
    // (callers would only end up printing the same thing twice).
    return { sent: false, kind, via: 'none', code: info.code, error: err };
  } finally {
    diskReservation?.release?.();
    release();
    for (const f of files) deleteTempFile(f);
    try {
      for (const f of fs.readdirSync(getTempDir())) {
        if (f.startsWith(stamp)) deleteTempFile(path.join(getTempDir(), f));
      }
    } catch { /* ignore */ }
    if (typeof global.gc === 'function') global.gc();
  }
}

module.exports = { downloadAndSend, parseOptions, QUALITIES, MAX_VIDEO_MB, MAX_AUDIO_MB };
