// src/commands/tgsticker.js — merged from Zafar-bot-main: Telegram sticker packs.
//   .tgpack <name|link|keyword> [n]   — send pack stickers as documents
//   .tgsticker [keyword] [n]          — send one WhatsApp-ready sticker
// Needs TELEGRAM_BOT_TOKEN. Static + video stickers convert locally;
// animated .tgs gets an honest "unsupported" (needs a native lottie runtime).
import config from '../config.js';
import tg, { friendlyError } from '../media/telegram.js';

export const help = (P) =>
  `🐨 *Telegram stickers*\n\n*${P}tgpack <name|link|keyword> [n]* — stickers as files\n*${P}tgsticker [keyword] [n]* — one WhatsApp sticker\n_Requires TELEGRAM_BOT_TOKEN in .env_`;

async function pickStickers(ctx, args) {
  const { pack, num } = await tg.resolvePack(args);
  const n = num || 1;
  const picked = pack.stickers.slice(0, Math.min(n, 10));
  return { pack, picked };
}

export async function runTgSticker(ctx, args) {
  if (!config.telegramBotToken) return ctx.say(friendlyError(new Error('NO_TOKEN')));
  const status = ctx.status ? ctx.status('🐨 Fetching sticker…') : null;
  try {
    const { pack, picked } = await pickStickers(ctx, args);
    let sent = 0, skipped = 0;
    for (const sticker of picked) {
      try {
        const buf = await tg.buildWhatsAppSticker(sticker, pack.title);
        if (!ctx.sendSticker) { await ctx.sendDoc(buf, `🐨 ${pack.title}`); }
        else await ctx.sendSticker(buf);
        sent++;
      } catch (e) {
        if (/tgs|lottie/i.test(e.message)) skipped++;
        else throw e;
      }
    }
    const done = `✅ ${sent ? `${sent} sticker(s) from *${pack.title}*` : ''}${skipped ? `\n⏭️ ${skipped} animated .tgs skipped (needs a lottie runtime)` : ''}`;
    return status ? status.final(done || 'Nothing sent') : ctx.say(done);
  } catch (e) {
    const msg = friendlyError(e);
    return status ? status.final(msg) : ctx.say(msg);
  }
}

export async function runTgPack(ctx, args) {
  if (!config.telegramBotToken) return ctx.say(friendlyError(new Error('NO_TOKEN')));
  const status = ctx.status ? ctx.status('📦 Fetching pack…') : null;
  try {
    const { pack, picked } = await pickStickers(ctx, args);
    let sent = 0;
    for (const sticker of picked) {
      try {
        const { buf } = await tg.downloadStickerFile(sticker);
        await ctx.sendDoc(buf, `🐨 ${pack.title} — sticker ${++sent}`);
      } catch (e) {
        if (!/tgs|lottie/i.test(e.message)) throw e;
      }
    }
    const done = sent ? `📦 Sent ${sent} file(s) from *${pack.title}*` : '⚠️ Nothing sendable in that pack (animated .tgs needs a lottie runtime).';
    return status ? status.final(done) : ctx.say(done);
  } catch (e) {
    const msg = friendlyError(e);
    return status ? status.final(msg) : ctx.say(msg);
  }
}

export async function run(ctx, args) {
  return runTgSticker(ctx, args);
}
