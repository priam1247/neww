// src/commands/sticker.js — merged from Zafar-bot-main: image/video → sticker.
// Requires the WhatsApp transport (needs raw Baileys media access); converts
// with ffmpeg when available, embeds pack metadata dependency-free
// (src/media/webpExif.js), and auto-compresses oversized animated stickers.
import config from '../config.js';
import fs from 'node:fs';
import ffmpeg from '../utils/ffmpeg.js';
import { withStickerMetadata } from '../media/webpExif.js';
import { tempPath, removeTemp } from '../media/transfer.js';

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_ANIMATED_STICKER = 1000 * 1024;   // WhatsApp rejects animated stickers over ~1 MB

export const help = (P) =>
  `🖼️ *Sticker*\n\n*${P}sticker* (reply to an image or video)\nffmpeg missing? Only static conversion may fail — videos need it.`;

export async function run(ctx, args) {
  if (!ctx.downloadMedia || !ctx.sendSticker) {
    return ctx.say('❌ .sticker needs the WhatsApp transport (CLI has no media pipeline).');
  }

  // resolve the quoted media message
  const target = ctx.quotedMedia ? ctx.quotedMedia() : null;
  const mediaMsg = target
    ? (target.message?.imageMessage || target.message?.videoMessage || target.message?.documentMessage || target.message?.stickerMessage
      ? target : null)
    : (ctx.msg?.message?.imageMessage || ctx.msg?.message?.videoMessage ? ctx.msg : null);

  if (!mediaMsg) {
    return ctx.say(`📎 Reply to an *image* / *video* with ${config.prefix}sticker (or send media with it as caption).`);
  }

  if (!ffmpeg.works()) {
    return ctx.say('❌ ffmpeg is not installed on this host — stickers need it.\nFix: `apt install ffmpeg` (Termux: `pkg install ffmpeg`).');
  }

  const mediaMessage =
    mediaMsg.message?.imageMessage || mediaMsg.message?.videoMessage ||
    mediaMsg.message?.documentMessage || mediaMsg.message?.stickerMessage;

  const files = [];
  try {
    const mediaBuffer = await ctx.downloadMedia(mediaMsg);
    if (!mediaBuffer?.length) return ctx.say('❌ Failed to download media. Please try again.');
    if (mediaBuffer.length > MAX_FILE_SIZE) {
      return ctx.say(`❌ File too large: ${(mediaBuffer.length / 1024 / 1024).toFixed(2)}MB (max: 50MB)`);
    }

    const tempInput = tempPath('st_in');
    const tempOutput = tempPath('st_out', 'webp');
    const tempOutput2 = tempPath('st_fallback', 'webp');
    files.push(tempInput, tempOutput, tempOutput2);
    fs.writeFileSync(tempInput, mediaBuffer);

    const isAnimated = mediaMessage.mimetype?.includes('gif') || mediaMessage.mimetype?.includes('video') || (mediaMessage.seconds || 0) > 0;
    const scale = 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000';
    const baseArgs = isAnimated
      ? ['-i', tempInput, '-vf', `${scale},fps=15`, '-c:v', 'libwebp', '-preset', 'default', '-loop', '0', '-vsync', '0', '-pix_fmt', 'yuva420p', '-quality', '75', '-compression_level', '6', tempOutput]
      : ['-i', tempInput, '-vf', `${scale},format=rgba`, '-c:v', 'libwebp', '-preset', 'default', '-loop', '0', '-vsync', '0', '-pix_fmt', 'yuva420p', '-quality', '75', '-compression_level', '6', tempOutput];

    await ffmpeg.execFile(ffmpeg.resolve(), ['-y', '-hide_banner', '-loglevel', 'error', ...baseArgs], { timeout: 180_000 });
    let webpBuffer = fs.readFileSync(tempOutput);

    if (isAnimated && webpBuffer.length > MAX_ANIMATED_STICKER) {
      const isLargeFile = mediaBuffer.length / 1024 > 5000;
      const fallbackArgs = isLargeFile
        ? ['-y', '-hide_banner', '-loglevel', 'error', '-i', tempInput, '-t', '2', '-vf', `${scale},fps=8`, '-c:v', 'libwebp', '-preset', 'default', '-loop', '0', '-vsync', '0', '-pix_fmt', 'yuva420p', '-quality', '30', '-compression_level', '6', '-b:v', '100k', tempOutput2]
        : ['-y', '-hide_banner', '-loglevel', 'error', '-i', tempInput, '-t', '3', '-vf', `${scale},fps=12`, '-c:v', 'libwebp', '-preset', 'default', '-loop', '0', '-vsync', '0', '-pix_fmt', 'yuva420p', '-quality', '45', '-compression_level', '6', '-b:v', '150k', tempOutput2];
      await ffmpeg.execFile(ffmpeg.resolve(), fallbackArgs, { timeout: 180_000 });
      if (fs.existsSync(tempOutput2) && fs.statSync(tempOutput2).size > 0) webpBuffer = fs.readFileSync(tempOutput2);
    }

    // embed pack metadata (pure JS — no node-webpmux)
    const finalBuffer = withStickerMetadata(webpBuffer, { packName: config.packName, publisher: config.botName });
    await ctx.sendSticker(finalBuffer);
  } catch (error) {
    if (/ENOENT/.test(error.message || '')) {
      return ctx.say('❌ ffmpeg is not installed on this host — install ffmpeg and try again.');
    }
    return ctx.say('❌ Failed to create sticker. Make sure the media is valid.');
  } finally {
    for (const f of files) removeTemp(f);
  }
}
