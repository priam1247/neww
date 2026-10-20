// src/commands/viewonce.js — merged from Zafar-bot-main: reveal view-once media.
// WhatsApp transport only (downloads the quoted media through Baileys and
// resends it as a normal image/video/audio so it can be re-opened freely).
import config from '../config.js';

export const help = (P) =>
  `👻 *ViewOnce*\n\n*${P}viewonce* (reply to a view-once message)`;

export async function run(ctx) {
  if (!ctx.downloadMedia || !ctx.sendImage) {
    return ctx.say('❌ .viewonce needs the WhatsApp transport (CLI has no media pipeline).');
  }

  const ctxInfo = ctx.msg?.message?.extendedTextMessage?.contextInfo;
  const quoted = ctxInfo?.quotedMessage;
  if (!quoted) {
    return ctx.say(`🗑️ Reply to a *view-once* message with ${config.prefix}viewonce to reveal it.`);
  }

  // unwrap the view-once container(s)
  const container =
    quoted.viewOnceMessageV2Extension?.message ||
    quoted.viewOnceMessageV2?.message ||
    quoted.viewOnceMessage?.message ||
    null;

  const MEDIA_KEYS = ['imageMessage', 'videoMessage', 'audioMessage'];
  let actualMsg = null, mtype = null;
  if (container) {
    mtype = MEDIA_KEYS.find(k => container[k]) || null;
    if (mtype) actualMsg = container;
  }
  // direct message with the viewOnce flag on the media itself
  if (!actualMsg && (quoted.imageMessage?.viewOnce || quoted.videoMessage?.viewOnce || quoted.audioMessage?.viewOnce)) {
    for (const k of MEDIA_KEYS) {
      if (quoted[k]?.viewOnce) { actualMsg = { [k]: quoted[k] }; mtype = k; break; }
    }
  }
  if (!actualMsg || !mtype) return ctx.say('❌ This is not a view-once message!');

  const media = actualMsg[mtype];
  const buffer = await ctx.downloadMedia({ message: actualMsg });
  if (!buffer?.length) return ctx.say('❌ Could not download that media (it may have expired).');
  const caption = media.caption || '';

  if (/video/.test(mtype)) {
    await ctx.sendVideo(buffer, caption, { mimetype: 'video/mp4' });
  } else if (/image/.test(mtype)) {
    await ctx.sendImage(buffer, caption, { mimetype: 'image/jpeg' });
  } else {
    // keep the original codec: forcing ptt on non-Opus audio breaks playback
    const srcMime = media.mimetype || '';
    const isOpus = /ogg|opus/i.test(srcMime);
    await ctx.sendAudio(buffer, {
      mimetype: isOpus ? 'audio/ogg; codecs=opus' : (srcMime || 'audio/mp4'),
      ptt: isOpus,
    });
  }
}
