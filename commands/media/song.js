/**
 * ZaFar Bot — .song  (YouTube → MP3)
 *
 *   .song <name or link> [audio|doc]     [audio|doc] overrides config.song.sendAs
 *
 * Quiet by design: reactions and one file message; long jobs get a progress card.
 * Highest-quality audio yt-dlp can get (m4a/aac first), converted to MP3 at
 * LAME V0 and sent as a document unless the caller explicitly asks for `audio`.
 *
 * Pipeline (first engine that works wins):
 *   1. yt-dlp   — local, best quality, retries with several YouTube player
 *                 clients, converts to MP3 with ffmpeg (raw stream if no ffmpeg).
 *   2. remote   — Gifted / cobalt providers (only when yt-dlp cannot do it).
 *
 * Everything is streamed to disk: a 2-hour mix never lands in RAM, and the file
 * is deleted right after it is sent.
 *
 * Failure messages describe the *real* reason (bot-check, private, geo-block,
 * missing tools, network …) — "blocked in your region" is only ever printed for
 * a genuine geo-block.
 */

const fs = require('fs');
const path = require('path');
const config = require('../../config');
const YT = require('../../utils/youtubedl');
const settings = require('../../utils/mediaSettings');
const providers = require('../../utils/downloadProviders');
const youtubeSearch = require('../../utils/youtubeSearch');
const selections = require('../../utils/selections');
const jobQueue = require('../../utils/jobQueue');
const {
  downloadToFile, sniffFile, audioToMp3, tagMp3, safeName, fmtMB,
} = require('../../utils/mediaTransfer');
const log = require('../../utils/logger')('song');
const { getTempDir, deleteTempFile, holdTemp } = require('../../utils/tempManager');
const diskSpace = require('../../utils/diskSpace');

const MAX_AUDIO_MB = Number(config.song?.maxMB) || 120;
const MAX_AUDIO_SECONDS = Number(config.song?.maxMinutes ? config.song.maxMinutes * 60 : 3 * 60 * 60);
const ENGINE_TIMEOUT = 8 * 60 * 1000;

const stamp = () => `song_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

// YouTube titles are messy: "Alan Walker - Faded (Official Music Video)".
// Clean them so the document is named like a real music file.
const JUNK = /\s*[([][^)\]]*(official|video|audio|lyric|hd|4k|mv|visuali[sz]er|remaster|explicit)[^)\]]*[)\]]/gi;
const clean = (s) => String(s || '').replace(JUNK, '').replace(/\s{2,}/g, ' ').trim();

function splitArtist(title, uploader) {
  let t = clean(title);
  let a = clean(uploader)
    .replace(/\s*-\s*topic$/i, '')
    .replace(/\s*vevo$/i, '')
    .replace(/^topic$/i, '')
    .trim();

  // "Artist - Song" is the YouTube convention; prefer it over the channel name
  const m = t.match(/^(.{2,60}?)\s+[-–—]\s+(.{2,})$/);
  if (m && !/^\d+$/.test(m[1])) {
    a = clean(m[1]) || a;
    t = clean(m[2]) || t;
  }
  if (a && t.toLowerCase() === a.toLowerCase()) t = clean(title) || t;
  return { title: t || clean(title) || 'song', artist: a };
}

const execute = async (sock, msg, args, extra) => {
    const chatId = extra?.from || msg.key.remoteJid;
    const reply = (text) => sock.sendMessage(chatId, { text }, { quoted: msg });
    const react = (emoji) => sock.sendMessage(chatId, { react: { text: emoji, key: msg.key } }).catch(() => {});

    // ── Parse: trailing send-mode token ─────────────────────────────────────
    args = [...args];
    let sendAs = String(config.song?.sendAs || 'document').toLowerCase();
    const runtimeSendAs = String(settings.get('songSendAs', '') || '').toLowerCase();
    if (runtimeSendAs) sendAs = runtimeSendAs;

    const last = String(args[args.length - 1] || '').toLowerCase();
    if (['audio', 'mp3'].includes(last)) { sendAs = 'audio'; args.pop(); }
    else if (['doc', 'document', 'file'].includes(last)) { sendAs = 'document'; args.pop(); }

    // --first (or a leading !) skips the results list and takes the top hit
    let firstHit = false;
    const flagIdx = args.findIndex(a => /^--?first$/i.test(a));
    if (flagIdx !== -1) { firstHit = true; args.splice(flagIdx, 1); }

    let text = args.join(' ').trim();
    if (text.startsWith('!')) { firstHit = true; text = text.slice(1).trim(); }
    if (!text) return reply(`Usage: .song <song name or YouTube link>\nExample: .song Faded Alan Walker`);

    const id = stamp();
    const outBase = path.join(getTempDir(), id);
    const files = [];
    const attempts = [];
    let progress = null;

    try {
      // ── 1. Resolve to a YouTube URL + metadata ────────────────────────────
      let url = null, title = '', artist = '', duration = 0, thumbnail = '';

      if (YT.isYouTubeUrl(text)) {
        url = YT.normalizeYouTubeUrl(text);
      } else {
        const maxResults = Number(config.search?.maxResults) || 5;
        const results = await youtubeSearch.searchYouTube(text, { limit: maxResults });

        if (!results.length) {
          const engine = YT.resolveCommand() || await YT.ensureInstalled();
          if (!engine) return reply(YT.friendlyError({ code: 'NO_YTDLP' }, { isOwner: Boolean(extra?.isOwner) }));
          return reply('❌ No results found for that search. Try a different spelling, or paste a YouTube link.');
        }

        const pickerOn = settings.get('searchPicker', config.search?.picker === true) !== false;
        if (results.length > 1 && pickerOn && !firstHit) {
          // Let the user choose instead of silently taking the first hit.
          void YT.getInfo(results[0].url).catch(() => {});
          const listText = youtubeSearch.formatResults(results, {
            header: `🔎 *Results for "${text}"*`,
            note: `Reply with a number (1-${results.length}) to download, or *cancel*.\n_Next time, add --first to skip this step._`,
          });
          await selections.sendTextPrompt(sock, msg, extra, {
            text: listText,
            image: results[0].thumbnail || null,
            items: results,
            label: 'song',
            ttlMs: Math.max(1, Number(config.search?.ttlMinutes) || 5) * 60 * 1000,
            run: (sock2, msg2, extra2, item) => execute(sock2, msg2, [item.url], extra2),
          });
          await react('❓');
          return;
        }

        ({ url, title, artist, duration, thumbnail } = {
          url: results[0].url,
          title: results[0].title,
          artist: results[0].author,
          duration: results[0].duration,
          thumbnail: results[0].thumbnail,
        });
      }


      if (!title || !duration) {
        try {
          const info = await YT.getInfo(url, { timeout: 45000 });
          title = title || info.title; artist = artist || info.uploader;
          duration = duration || info.duration; thumbnail = thumbnail || info.thumbnail;
        } catch (e) {
          log.debug(`metadata lookup failed · ${e.message}`);
          attempts.push({ engine: 'metadata', code: YT.classify(e).code });
        }
      }

      const shownTitle = title || 'song';
      const durationText = duration ? ` (${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')})` : '';
      if (duration && duration > MAX_AUDIO_SECONDS) {
        return reply(`❌ That track is ${Math.round(duration / 60)} min — the limit is ${Math.round(MAX_AUDIO_SECONDS / 60)} min.`);
      }

      return await jobQueue.runInLane('light', async () => {
      const releaseHold = holdTemp(id);
      const diskReservation = diskSpace.reserveSpace(getTempDir(), MAX_AUDIO_MB * 2, {
        label: 'song',
        tagDir: getTempDir(),
        tagPrefix: id,
      });
      try {
      await react('📥');

      // ── 3. Engine 1: yt-dlp ───────────────────────────────────────────────
      let file = null;
      let ext = 'mp3';
      let via = 'yt-dlp';

      try {
        const res = await YT.downloadAudio(url, {
          outBase,
          maxMB: MAX_AUDIO_MB,
          maxSeconds: MAX_AUDIO_SECONDS,
          onAttempt: (name, err, info) => {
            log.debug(`yt-dlp profile ${name} failed · ${info.code}`);
            attempts.push({ engine: `yt-dlp:${name}`, code: info.code });
          },
          deadlineMs: Number(config.ytdlp?.deadlineMs) || ENGINE_TIMEOUT,
        });
        file = res.file;
        ext = res.ext;
        files.push(file);
      } catch (ytErr) {
        const info = YT.classify(ytErr);
        attempts.push({ engine: 'yt-dlp', code: info.code });
        log.warn(`yt-dlp failed · ${info.code} · ${info.detail}`);

        // ── 4. Engine 2: remote providers ───────────────────────────────────
        const remoteWorthTrying = ['BOT_CHECK', 'NO_YTDLP', 'NO_FORMATS', 'FFMPEG_MISSING', 'UNKNOWN',
          'NETWORK', 'RATE_LIMIT', 'PO_TOKEN', 'AGE_RESTRICTED', 'GEO_BLOCK', 'BAD_ARGS'];
        const remoteAllowed = settings.get('remoteFallback', true) !== false;

        if (!remoteAllowed || !remoteWorthTrying.includes(info.code)) throw ytErr;

        await react('🔄');
        let remoteHit;
        try {
          remoteHit = await providers.resolveMedia(url, {
            kind: 'audio',
            timeoutMs: 20000,
            onAttempt: (name, err, st) => { if (st.code !== 'OK') attempts.push({ engine: name, code: st.code }); },
          });
        } catch (providerErr) {
          log.warn(`backup sources failed · ${providerErr.message}`);
          ytErr.attempts = attempts;   // report the *real* first failure plus what was tried
          throw ytErr;
        }

        via = remoteHit.provider;
        const dest = `${outBase}_remote.${remoteHit.ext || 'mp3'}`;
        const got = await downloadToFile(remoteHit.url, dest, {
          maxBytes: MAX_AUDIO_MB * 1024 * 1024,
          headers: remoteHit.headers
        });
        files.push(dest);
        file = dest;
        ext = got.sniff.kind === 'audio' ? got.sniff.ext : (remoteHit.ext || 'mp3');
        title = title || remoteHit.title;
      }

      if (!file || !fs.existsSync(file) || fs.statSync(file).size < 10 * 1024) {
        throw Object.assign(new Error('empty audio file'), { code: 'NO_FORMATS' });
      }

      const sniffed = sniffFile(file);
      if (sniffed.kind === 'unknown' || sniffed.ext === 'bin') {
        throw Object.assign(new Error('the source did not return an audio file'), { code: 'BAD_SOURCE' });
      }

      // ── 5. Deliver an MP3, at the best quality this host can produce ──────
      // The source stream is already the highest-quality audio YouTube serves
      // (m4a/AAC ~256k, or opus). We convert that to MP3 at LAME V0 (~245–320
      // kbps, no downsampling) when ffmpeg is available — that is the best MP3
      // that can exist. Without ffmpeg the untouched stream is sent instead of
      // refusing the request (and its real extension is kept, never a fake .mp3).
      let finalFile = file;
      let finalExt = sniffed.ext;
      let mime = sniffed.mime;

      if (finalExt !== 'mp3' && sniffed.kind === 'audio') {
        const mp3 = await audioToMp3(file, `${outBase}_hq.mp3`);
        if (mp3) {
          files.push(mp3);
          finalFile = mp3;
          finalExt = 'mp3';
          mime = 'audio/mpeg';
        } else {
          log.debug(`${sniffed.ext} kept as-is · ffmpeg unavailable for mp3`);
        }
      }

      const named = splitArtist(title, artist || '');
      const finalTitle = safeName(named.title, 'song');
      const finalArtist = safeName(named.artist, '');

      // ID3 tags: a WhatsApp document is shown by filename, but the file the
      // user keeps is read by a player — title/artist must be inside it.
      if (finalExt === 'mp3') {
        const tagged = await tagMp3(finalFile, `${outBase}_tagged.mp3`, {
          title: finalTitle, artist: finalArtist,
        });
        if (tagged) {
          files.push(tagged);
          finalFile = tagged;
        }
      }

      const size = fs.statSync(finalFile).size;
      if (size > MAX_AUDIO_MB * 1024 * 1024) {
        throw Object.assign(new Error('audio file too large'), { code: 'TOO_BIG' });
      }

      // ── 6. Send (streamed from disk, not read into RAM) ───────────────────
      const fileName = `${finalArtist ? `${finalArtist} - ${finalTitle}` : finalTitle}.${finalExt}`;
      const caption = (finalArtist ? `🎵 *${finalTitle}*\n👤 ${finalArtist}` : `🎵 *${finalTitle}*`)
        + `\n📦 ${fmtMB(size)}${via !== 'yt-dlp' ? ` • via ${via}` : ''}`;

      if (sendAs === 'audio') {
        const sent = await sock.sendMessage(chatId, {
          audio: { url: finalFile }, mimetype: mime, ptt: false, fileName,
        }, { quoted: msg });
      } else {
        // 'document' keeps the exact "Title - Artist.mp3" filename.
        const sent = await sock.sendMessage(chatId, {
          document: { url: finalFile }, mimetype: mime, fileName, caption,
        }, { quoted: msg });
      }
      await react('✅');
      } finally {
        diskReservation.release();
        releaseHold();
      }
      }, async () => {
        await react('⏳');
      });
    } catch (err) {
      log.error(`${text || 'song'} · ${YT.classify(err).code} · ${String(err.message).split('\n')[0]}`);
      const isOwner = Boolean(extra?.isOwner);
      if (err.code === 'NOT_ENOUGH_DISK') {
        const { safeErrorMessage } = require('../../utils/userErrors');
        await reply(safeErrorMessage(err, { isOwner }));
      } else {
        const info = YT.classify(err);
        if (err.attempts && err.attempts.length) info.attempts = err.attempts;
        YT.recordFailure({ ...info, url: err.url || null });
        const summary = isOwner ? YT.attemptsSummary(err.attempts || info.attempts) : '';
        const lines = String(YT.friendlyError(err, { isOwner }) + summary).split('\n').filter(Boolean);
        await reply(lines.slice(0, 3).join('\n'));
      }
      await react('❌');
    } finally {
      for (const f of files) deleteTempFile(f);
      // yt-dlp may leave .part / .ytdl files or a differently-named stream.
      try {
        for (const f of fs.readdirSync(getTempDir())) {
          if (f.startsWith(id)) deleteTempFile(path.join(getTempDir(), f));
        }
      } catch { /* ignore */ }
      if (typeof global.gc === 'function') global.gc();
    }
};

module.exports = {
  name: 'song',
  aliases: ['play', 'music', 'yta'],
  category: 'media',
  description: 'Download a song from YouTube as MP3',
  usage: '.song <song name or YouTube link> [audio|doc]',
  execute,
};
