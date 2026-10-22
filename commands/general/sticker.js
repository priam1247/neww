/**
 * Sticker Command
 * Image/video → WhatsApp sticker (auto-compressed) with pack metadata.
 *
 * Uses the shared ffmpeg resolver: the old build hard-required the
 * `ffmpeg-static` package, which does not run on Termux/Android and is not
 * installed on some hosts — making .sticker fail while the rest of the bot
 * worked fine.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const crypto = require('crypto');
const webp = require('node-webpmux');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const config = require('../../config');
const getFfmpeg = require('../../utils/ffmpeg');
const { getTempDir, deleteTempFile } = require('../../utils/tempManager');

// Max file size: 50MB
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_ANIMATED_STICKER = 1000 * 1024; // WhatsApp rejects animated stickers over ~1 MB

const runFfmpeg = (args) => new Promise((resolve, reject) => {
  execFile(getFfmpeg(), args, { maxBuffer: 8 * 1024 * 1024, timeout: 180000 }, (err, _stdout, stderr) => {
    if (err) {
      err.message = `${err.message}${stderr ? ` — ${String(stderr).trim().split('\n').pop()}` : ''}`;
      return reject(err);
    }
    resolve();
  });
});

module.exports = {
  name: 'sticker',
  aliases: ['s', 'stiker', 'stc'],
  description: 'Convert image or video to sticker (auto compression)',
  usage: '.sticker (reply to media)',
  category: 'general',

  async execute(sock, msg, args, extra) {
    const chatId = extra.from;
    let targetMessage = msg;

    const ctxInfo = msg.message?.extendedTextMessage?.contextInfo
      || msg.message?.imageMessage?.contextInfo
      || msg.message?.videoMessage?.contextInfo;
    if (ctxInfo?.quotedMessage) {
      targetMessage = {
        key: {
          remoteJid: chatId,
          id: ctxInfo.stanzaId,
          participant: ctxInfo.participant,
        },
        message: ctxInfo.quotedMessage,
      };
    }

    const mediaMessage =
      targetMessage.message?.imageMessage ||
      targetMessage.message?.videoMessage ||
      targetMessage.message?.documentMessage ||
      targetMessage.message?.stickerMessage;

    if (!mediaMessage) {
      return extra.reply('📎 Reply to an *image* / *video* with .sticker or send media with .sticker as caption.');
    }

    const tempDir = getTempDir();
    const timestamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const tempInput = path.join(tempDir, `in_${timestamp}`);
    const tempOutput = path.join(tempDir, `out_${timestamp}.webp`);
    const tempOutput2 = path.join(tempDir, `out_fallback_${timestamp}.webp`);
    const tempFiles = [tempInput, tempOutput, tempOutput2];

    try {
      const mediaBuffer = await downloadMediaMessage(
        targetMessage,
        'buffer',
        {},
        { logger: undefined, reuploadRequest: sock.updateMediaMessage },
      );

      if (!mediaBuffer || !mediaBuffer.length) {
        return extra.reply('❌ Failed to download media. Please try again.');
      }
      if (mediaBuffer.length > MAX_FILE_SIZE) {
        return extra.reply(`❌ File too large: ${(mediaBuffer.length / 1024 / 1024).toFixed(2)}MB (max: ${MAX_FILE_SIZE / 1024 / 1024}MB)`);
      }

      fs.writeFileSync(tempInput, mediaBuffer);

      const isAnimated =
        mediaMessage.mimetype?.includes('gif') ||
        mediaMessage.mimetype?.includes('video') ||
        (mediaMessage.seconds || 0) > 0;

      const scale = 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000';
      const baseArgs = isAnimated
        ? ['-i', tempInput, '-vf', `${scale},fps=15`, '-c:v', 'libwebp', '-preset', 'default', '-loop', '0', '-vsync', '0', '-pix_fmt', 'yuva420p', '-quality', '75', '-compression_level', '6', tempOutput]
        : ['-i', tempInput, '-vf', `${scale},format=rgba`, '-c:v', 'libwebp', '-preset', 'default', '-loop', '0', '-vsync', '0', '-pix_fmt', 'yuva420p', '-quality', '75', '-compression_level', '6', tempOutput];

      await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', ...baseArgs]);

      let webpBuffer = fs.readFileSync(tempOutput);

      if (isAnimated && webpBuffer.length > MAX_ANIMATED_STICKER) {
        const isLargeFile = mediaBuffer.length / 1024 > 5000;
        const fallbackArgs = isLargeFile
          ? ['-y', '-hide_banner', '-loglevel', 'error', '-i', tempInput, '-t', '2', '-vf', `${scale},fps=8`, '-c:v', 'libwebp', '-preset', 'default', '-loop', '0', '-vsync', '0', '-pix_fmt', 'yuva420p', '-quality', '30', '-compression_level', '6', '-b:v', '100k', tempOutput2]
          : ['-y', '-hide_banner', '-loglevel', 'error', '-i', tempInput, '-t', '3', '-vf', `${scale},fps=12`, '-c:v', 'libwebp', '-preset', 'default', '-loop', '0', '-vsync', '0', '-pix_fmt', 'yuva420p', '-quality', '45', '-compression_level', '6', '-b:v', '150k', tempOutput2];

        await runFfmpeg(fallbackArgs);
        if (fs.existsSync(tempOutput2) && fs.statSync(tempOutput2).size > 0) {
          webpBuffer = fs.readFileSync(tempOutput2);
        }
      }

      // Embed pack metadata so WhatsApp shows the pack name
      const img = new webp.Image();
      await img.load(webpBuffer);

      const json = {
        'sticker-pack-id': crypto.randomBytes(32).toString('hex'),
        'sticker-pack-name': config.packname || 'Made by',
        emojis: ['📖'],
      };

      const exifAttr = Buffer.from([
        0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
        0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
      ]);

      const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
      const exif = Buffer.concat([exifAttr, jsonBuffer]);
      exif.writeUIntLE(jsonBuffer.length, 14, 4);

      img.exif = exif;
      const finalBuffer = await img.save(null);

      await sock.sendMessage(extra.from, { sticker: finalBuffer }, { quoted: msg });
    } catch (error) {
      console.error('Sticker command error:', error);
      await extra.reply(
        error.code === 'NO_FFMPEG' || /ENOENT/.test(error.message || '')
          ? '❌ ffmpeg is not installed on this host — run `npm install` or install ffmpeg (Termux: `pkg install ffmpeg`).'
          : '❌ Failed to create sticker. Make sure the media is valid.'
      );
    } finally {
      tempFiles.forEach(file => deleteTempFile(file));
    }
  },
};
