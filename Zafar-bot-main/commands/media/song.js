/**
 * ZaFar Bot — .song  (YouTube → MP3)
 *
 *   .song <name or link> [audio|doc]     [audio|doc] overrides config.song.sendAs
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
const {
  downloadToFile, sniffFile, audioToMp3, safeName, fmtMB,
} = require('../../utils/mediaTransfer');
const { getTempDir, deleteTempFile } = require('../../utils/tempManager');

const MAX_AUDIO_MB = Number(config.song?.maxMB) || 120;
const MAX_AUDIO_SECONDS = Number(config.song?.maxMinutes ? config.song.maxMinutes * 60 : 3 * 60 * 60);
const ENGINE_TIMEOUT = 8 * 60 * 1000;

const stamp = () => `song_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

/** Throttled "edit this message with progress" helper. */
function progressCard(sock, chatId, msg, initialText) {
  let key = null;
  let lastEdit = 0;
  let lastText = initialText;
  let disabled = false;

  const send = sock.sendMessage(chatId, { text: initialText }, { quoted: msg })
    .then((sent) => { key = sent?.key || null; return sent; })
    .catch(() => { disabled = true; return null; });

  return {
    ready: send,
    /** @param {string} text @param {{force?:boolean}} [opts] */
    async update(text, { force = false } = {}) {
      if (disabled || !key || text === lastText) return;
      const now = Date.now();
      if (!force && now - lastEdit < 4000) return;
      lastEdit = now;
      lastText = text;
      try { await sock.sendMessage(chatId, { text, edit: key }); }
      catch { disabled = true; }
    },
    async final(text) {
      if (disabled || !key) {
        try { await sock.sendMessage(chatId, { text }, { quoted: msg }); } catch { /* ignore */ }
        return;
      }
      try { await sock.sendMessage(chatId, { text, edit: key }); }
      catch { try { await sock.sendMessage(chatId, { text }, { quoted: msg }); } catch { /* ignore */ } }
    },
  };
}

const bar = (percent) => {
  const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
};

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

    try {
      await react('📥');

      // ── 1. Resolve to a YouTube URL + metadata ────────────────────────────
      let url = null, title = '', artist = '', duration = 0, thumbnail = '';

      if (YT.isYouTubeUrl(text)) {
        url = YT.normalizeYouTubeUrl(text);
        try {
          const info = await YT.getInfo(url, { timeout: 45000 });
          title = info.title; artist = info.uploader; duration = info.duration; thumbnail = info.thumbnail;
        } catch (e) {
          // Metadata failing is not fatal — the download attempt gives the real error.
          console.warn('[song] metadata lookup failed:', e.message);
          attempts.push({ engine: 'metadata', code: YT.classify(e).code });
        }
      } else {
        const maxResults = Number(config.search?.maxResults) || 5;
        const results = await youtubeSearch.searchYouTube(text, { limit: maxResults });

        if (!results.length) {
          const engine = YT.resolveCommand() || await YT.ensureInstalled();
          if (!engine) return reply(YT.friendlyError({ code: 'NO_YTDLP' }));
          return reply('❌ No results found for that search. Try a different spelling, or paste a YouTube link.');
        }

        const pickerOn = config.search?.picker !== false && settings.get('searchPicker', true) !== false;
        if (results.length > 1 && pickerOn && !firstHit) {
          // Let the user choose instead of silently taking the first hit.
          const listText = youtubeSearch.formatResults(results, {
            header: `🔎 *Results for "${text}"*`,
            note: `Reply with a number (1-${results.length}) to download, or *cancel*.\n_Next time, add --first to skip this step._`,
          });
          if (results[0].thumbnail) {
            await sock.sendMessage(chatId, { image: { url: results[0].thumbnail }, caption: listText }, { quoted: msg })
              .catch(() => reply(listText));
          } else {
            await reply(listText);
          }

          selections.offer({
            chatId,
            sender: extra?.sender || msg.key.participant || chatId,
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

      const shownTitle = title || 'song';
      const durationText = duration ? ` (${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')})` : '';
      if (duration && duration > MAX_AUDIO_SECONDS) {
        return reply(`❌ That track is ${Math.round(duration / 60)} min — the limit is ${Math.round(MAX_AUDIO_SECONDS / 60)} min.`);
      }

      // ── 2. Status card (editable, shows live progress) ────────────────────
      const card = progressCard(sock, chatId, msg, `🎵 *${shownTitle}*${durationText}\n⏳ Fetching audio…`);
      if (thumbnail) card.ready.catch(() => {});

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
            console.log(`[song] yt-dlp profile "${name}" failed (${info.code})`);
            attempts.push({ engine: `yt-dlp:${name}`, code: info.code });
          },
          onProgress: (p) => card.update(`🎵 *${shownTitle}*${durationText}\n${bar(p.percent)} ${p.percent}%`),
          deadlineMs: Number(config.ytdlp?.deadlineMs) || ENGINE_TIMEOUT,
        });
        file = res.file;
        ext = res.ext;
        files.push(file);
        card.update(`🎵 *${shownTitle}*${durationText}\n✅ Downloaded — preparing…`, { force: true });
      } catch (ytErr) {
        const info = YT.classify(ytErr);
        attempts.push({ engine: 'yt-dlp', code: info.code });
        console.warn(`[song] yt-dlp failed (${info.code}): ${info.detail}`);

        // ── 4. Engine 2: remote providers ───────────────────────────────────
        const remoteWorthTrying = ['BOT_CHECK', 'NO_YTDLP', 'NO_FORMATS', 'FFMPEG_MISSING', 'UNKNOWN',
          'NETWORK', 'RATE_LIMIT', 'PO_TOKEN', 'AGE_RESTRICTED', 'GEO_BLOCK', 'BAD_ARGS'];
        const remoteAllowed = settings.get('remoteFallback', true) !== false;

        if (!remoteAllowed || !remoteWorthTrying.includes(info.code)) throw ytErr;

        await card.update('🔄 Local engine failed — trying a backup source…', { force: true });
        let remoteHit;
        try {
          remoteHit = await providers.resolveMedia(url, {
            kind: 'audio',
            timeoutMs: 20000,
            onAttempt: (name, err, st) => { if (st.code !== 'OK') attempts.push({ engine: name, code: st.code }); },
          });
        } catch (providerErr) {
          console.warn('[song] backup sources failed:', providerErr.message);
          ytErr.attempts = attempts;   // report the *real* first failure plus what was tried
          throw ytErr;
        }

        via = remoteHit.provider;
        const dest = `${outBase}_remote.${remoteHit.ext || 'mp3'}`;
        const got = await downloadToFile(remoteHit.url, dest, {
          maxBytes: MAX_AUDIO_MB * 1024 * 1024,
          headers: remoteHit.headers,
          onProgress: (p) => card.update(`🎵 *${shownTitle}* (${via})\n${bar(p.percent)} ${p.percent}%`),
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

      // ── 5. Guarantee a real MP3 when we can ───────────────────────────────
      let finalFile = file;
      let finalExt = sniffed.ext;
      let mime = sniffed.mime;

      if (finalExt !== 'mp3') {
        const mp3 = await audioToMp3(file, `${outBase}_wa.mp3`);
        if (mp3) {
          files.push(mp3);
          finalFile = mp3;
          finalExt = 'mp3';
          mime = 'audio/mpeg';
        }
      }

      const size = fs.statSync(finalFile).size;
      if (size > MAX_AUDIO_MB * 1024 * 1024) {
        throw Object.assign(new Error('audio file too large'), { code: 'TOO_BIG' });
      }

      // ── 6. Send (streamed from disk, not read into RAM) ───────────────────
      const finalTitle = safeName(title, 'song');
      const finalArtist = safeName(artist, '');
      const fileName = `${finalArtist ? `${finalTitle} - ${finalArtist}` : finalTitle}.${finalExt}`;
      const caption = (finalArtist ? `🎵 *${finalTitle}*\n👤 ${finalArtist}` : `🎵 *${finalTitle}*`)
        + `\n📦 ${fmtMB(size)}${via !== 'yt-dlp' ? ` • via ${via}` : ''}`;

      if (sendAs === 'audio') {
        await sock.sendMessage(chatId, {
          audio: { url: finalFile }, mimetype: mime, ptt: false, fileName,
        }, { quoted: msg });
      } else {
        // 'document' keeps the exact "Title - Artist.mp3" filename.
        await sock.sendMessage(chatId, {
          document: { url: finalFile }, mimetype: mime, fileName, caption,
        }, { quoted: msg });
      }
      await card.update(`✅ *${finalTitle}*${finalArtist ? ` — ${finalArtist}` : ''}\n📦 ${fmtMB(size)}${via !== 'yt-dlp' ? ` • via ${via}` : ''}`, { force: true });

      await react('✅');
    } catch (err) {
      console.error('[song] error:', err.message);
      const info = YT.classify(err);
      if (err.attempts && err.attempts.length) info.attempts = err.attempts;
      YT.recordFailure({ ...info, url: err.url || null });
      const summary = YT.attemptsSummary(err.attempts || info.attempts);
      await reply(YT.friendlyError(err) + summary);
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
