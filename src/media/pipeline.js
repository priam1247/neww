// src/media/pipeline.js — merged from Zafar-bot-main: one implementation of
// "download a link and send it to the chat", shared by .dl, .song, .ytv,
// .spotify and the site shortcuts. Engine 1 is the local yt-dlp engine;
// engine 2 is the remote provider set (cobalt/gifted); files are streamed to
// disk, sniffed from magic bytes, converted when needed, and cleaned up.
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import { log } from '../core/log.js';
import { metrics } from '../core/metrics.js';
import YT from '../providers/local/ytdlp.js';
import * as remote from '../providers/local/remote.js';
import {
  downloadToFile, sniffFile, audioToMp3, ensureWhatsAppMp4, safeName, fmtMB,
  tempPath, removeTemp, sweepJobs, bar,
} from './transfer.js';
import { freeBytes } from '../utils/disk.js';

const plog = log.child('pipeline');
const QUALITIES = [144, 240, 360, 480, 720, 1080];

/** Parse "[audio|video] [144-1080]" written in any order (non-destructive). */
export function parseOptions(args, defaults = {}) {
  const rest = [...args];
  let kind = defaults.kind || 'video';
  let height = defaults.height || config.videoDefaultQuality;
  for (let i = rest.length - 1; i >= 0; i--) {
    const token = String(rest[i] || '').toLowerCase();
    if (['audio', 'mp3', 'song', 'music'].includes(token)) { kind = 'audio'; rest.splice(i, 1); continue; }
    if (['video', 'mp4', 'vid', 'hd'].includes(token)) { kind = 'video'; rest.splice(i, 1); continue; }
    if (QUALITIES.includes(Number(token.replace(/p$/, '')))) { height = Number(token.replace(/p$/, '')); rest.splice(i, 1); continue; }
    break;   // first non-option token is the link itself
  }
  return { kind, height, rest };
}

/** Download `url` and send it. Never throws without explaining; cleans up. */
export async function downloadAndSend(ctx, {
  url, kind = 'video', height = 720, title = '', author = '', attempts = [], sendAs = null,
} = {}) {
  const say = (t) => ctx.say(t);
  const card = ctx.status ? ctx.status(`${kind === 'audio' ? '🎵' : '🎬'} Downloading…`) : null;
  const update = (t, opts = {}) => card ? card.update(t, opts) : Promise.resolve();
  const final = (t) => card ? card.final(t) : say(t);
  const stamp = `${kind === 'audio' ? 'aud' : 'dl'}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const outBase = path.join(path.dirname(tempPath('x')), stamp);
  const files = [];
  let via = 'yt-dlp';

  const MAX_VIDEO_MB = config.videoMaxMB;
  const MAX_AUDIO_MB = config.songMaxMB;
  const MAX_MINUTES = config.videoMaxMinutes;
  const AS_DOC_ABOVE = 50 * 1024 * 1024;

  try {
    // low-disk guard before starting a heavy job
    const free = await freeBytes(config.jobDir).catch(() => Infinity);
    if (free < config.minFreeMB * 1024 * 1024) {
      sweepJobs({});
      throw Object.assign(new Error('not enough free disk space for a download right now'), { code: 'NETWORK' });
    }

    // best-effort metadata (the download attempt reports the real problems)
    if (!title) {
      try {
        const info = await YT.getInfo(url, { timeout: 45_000 });
        title = info.title; author = author || info.uploader;
        if (kind === 'video' && info.duration && info.duration > MAX_MINUTES * 60) {
          return final(`❌ That is ${Math.round(info.duration / 60)} min long — the limit is ${MAX_MINUTES} min.`);
        }
      } catch (e) { plog.warn('metadata failed:', e.message); }
    }

    const label = kind === 'audio' ? '🎵' : '🎬';
    const shownTitle = title || 'media';
    await update(`${label} *${shownTitle}*\n⏳ Downloading…`, { force: true });

    const deadlineAt = Date.now() + config.ytdlpDeadlineMs;
    let file = null;

    // ── Engine 1: yt-dlp ───────────────────────────────────────────────────
    try {
      const onAttempt = (name, err, info) => {
        plog.info(`yt-dlp profile "${name}" failed (${info.code})`);
        attempts.push({ engine: `yt-dlp:${name}`, code: info.code });
      };
      const onProgress = (p) => update(`${label} *${shownTitle}*\n${bar(p.percent)} ${p.percent}%`);
      if (kind === 'audio') {
        const res = await YT.downloadAudio(url, {
          outBase, maxMB: MAX_AUDIO_MB, onAttempt, onProgress,
          deadlineMs: Math.max(20_000, deadlineAt - Date.now()),
        });
        file = res.file;
      } else {
        const res = await YT.downloadVideo(url, {
          height, outBase, maxMB: MAX_VIDEO_MB, maxSeconds: MAX_MINUTES * 60,
          onAttempt, onProgress, deadlineMs: Math.max(20_000, deadlineAt - Date.now()),
        });
        file = res.file;
      }
      files.push(file);
      await update(`${label} *${shownTitle}*\n✅ Downloaded — preparing…`, { force: true });
    } catch (ytErr) {
      const info = YT.classify(ytErr);
      attempts.push({ engine: 'yt-dlp', code: info.code });
      plog.warn(`yt-dlp failed (${info.code}): ${info.detail}`);

      if (!remote.remoteWorthTrying(info.code)) { ytErr.attempts = attempts; throw ytErr; }
      await update('🔄 Local engine failed — trying a backup source…', { force: true });
      let remoteHit;
      try {
        remoteHit = await remote.resolveMedia(url, {
          kind, quality: height, timeoutMs: 20_000,
          onAttempt: (name, err, st) => { if (st.code !== 'OK') attempts.push({ engine: name, code: st.code }); },
        });
      } catch (providerErr) {
        plog.warn('backup sources failed:', providerErr.message);
        ytErr.attempts = attempts;
        throw ytErr;
      }
      via = remoteHit.provider;
      const dest = `${outBase}_remote.${remoteHit.ext || (kind === 'audio' ? 'mp3' : 'mp4')}`;
      const got = await downloadToFile(remoteHit.url, dest, {
        maxBytes: (kind === 'audio' ? MAX_AUDIO_MB : MAX_VIDEO_MB) * 1024 * 1024,
        headers: remoteHit.headers,
        onProgress: (p) => update(`${label} *${shownTitle}* (${via})\n${bar(p.percent)} ${p.percent}%`),
      });
      files.push(dest);
      file = dest;
      title = title || remoteHit.title;
      plog.info(`downloaded via ${via} (${got.sniff.kind}/${got.sniff.ext})`);
    }

    if (!file || !fs.existsSync(file) || fs.statSync(file).size < 10 * 1024) {
      throw Object.assign(new Error('downloaded file is empty'), { code: 'NO_FORMATS' });
    }

    const sniffed = sniffFile(file);
    const viaText = via !== 'yt-dlp' ? ` • via ${via}` : '';

    // ── Images (Pinterest pins, Instagram photos …) ────────────────────────
    if (sniffed.kind === 'image') {
      const size = fs.statSync(file).size;
      if (size > MAX_VIDEO_MB * 1024 * 1024) throw Object.assign(new Error('image too large'), { code: 'TOO_BIG' });
      await update(`🖼️ *${shownTitle}*\n📤 Sending image…`, { force: true });
      await ctx.sendImage(file, `🖼️ *${safeName(title, 'image')}*${author ? `\n👤 ${author}` : ''}\n📦 ${fmtMB(size)}${viaText}`);
      await update('✅ Image sent', { force: true });
      return { sent: true, kind: 'image', via };
    }

    // ── Audio ──────────────────────────────────────────────────────────────
    if (kind === 'audio' || sniffed.kind === 'audio') {
      let finalFile = file, ext = sniffed.ext, mime = sniffed.mime;
      if (ext !== 'mp3') {
        const mp3 = await audioToMp3(file, `${outBase}_wa.mp3`);
        if (mp3) { files.push(mp3); finalFile = mp3; ext = 'mp3'; mime = 'audio/mpeg'; }
      }
      const size = fs.statSync(finalFile).size;
      if (size > MAX_AUDIO_MB * 1024 * 1024) throw Object.assign(new Error('audio too large'), { code: 'TOO_BIG' });
      const name = safeName(title, 'audio');
      await update(`✅ *${name}* sent`, { force: true });
      const sendAsAudio = String(sendAs || config.songSendAs).toLowerCase() === 'audio';
      await ctx.sendAudio(finalFile, { mimetype: mime, fileName: `${name}.${ext}`, sendAsAudio,
        caption: sendAsAudio ? undefined : `🎵 *${name}*${author ? `\n👤 ${author}` : ''}\n📦 ${fmtMB(size)}${viaText}` });
      metrics.bump('media.sent', { kind: 'audio' });
      return { sent: true, kind: 'audio', via };
    }

    // ── Video ──────────────────────────────────────────────────────────────
    await update(`🎬 *${shownTitle}*\n🎛️ Converting for WhatsApp…`, { force: true });
    const ready = await ensureWhatsAppMp4(file, `${outBase}_wa.mp4`);
    files.push(ready);
    const size = fs.statSync(ready).size;
    if (size > MAX_VIDEO_MB * 1024 * 1024) throw Object.assign(new Error('video too large'), { code: 'TOO_BIG' });
    const name = safeName(title, 'video');
    const caption = `🎬 *${title || name}*${author ? `\n👤 ${author}` : ''}\n📦 ${fmtMB(size)} • ${height}p${viaText}`;
    if (size > AS_DOC_ABOVE) {
      await ctx.sendDoc(ready, caption);
    } else {
      await ctx.sendVideo(ready, caption);
    }
    await update(`✅ *${name}* sent\n📦 ${fmtMB(size)}${viaText}`, { force: true });
    metrics.bump('media.sent', { kind: 'video' });
    return { sent: true, kind: 'video', via };
  } catch (err) {
    const info = YT.classify(err);
    const merged = attempts.length ? attempts : (err.attempts || info.attempts);
    if (info.code === 'TOO_BIG') {
      await final(`❌ The file is bigger than this bot allows (video ${config.videoMaxMB} MB / audio ${config.songMaxMB} MB).\nTry a lower quality or a shorter clip.`);
    } else {
      await final(YT.friendlyError(err) + YT.attemptsSummary(merged));
    }
    metrics.bump('media.error', { code: info.code });
    return { sent: false, kind, via: 'none', code: info.code, error: err };
  } finally {
    for (const f of files) removeTemp(f);
  }
}
