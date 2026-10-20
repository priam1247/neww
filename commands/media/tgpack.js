/**
 * Telegram Pack - Send a Telegram sticker pack (no link needed)
 *
 *   .tgpack              -> first 5 stickers of this chat's last pack (or a random pack)
 *   .tgpack cat 8        -> first 8 stickers of a "cat" pack
 *   .tgpack <t.me link>  -> first 10 stickers (add a number for more, max 60)
 */

const T = require('../../utils/telegram');

const DEFAULT_COUNT = 5;  // keyword / no-argument default
const LINK_COUNT = 10;    // default when a pack link is given
const MAX_PACK = 60;      // hard cap per command
const DELAY_MS = 800;     // pause between stickers to avoid WhatsApp rate limits

module.exports = {
  name: 'tgpack',
  aliases: ['stickerpack'],
  category: 'media',
  description: 'Send a Telegram sticker pack by keyword, count, or link',
  usage: '.tgpack [keyword or link] [count]',

  async execute(sock, msg, args, extra) {
    const chatId = extra.from;
    try {
      const { pack, num, query, fromLink } = await T.resolvePack(args, msg, chatId, { useRemembered: true });
      const limit = Math.min(MAX_PACK, Math.max(1, num || (fromLink ? LINK_COUNT : DEFAULT_COUNT)));
      const list = pack.stickers.slice(0, limit);
      const status = await extra.status(`📦 *${pack.title}* — sending ${list.length} of ${pack.stickers.length} stickers...`);

      let sent = 0, failed = 0;
      for (const sticker of list) {
        try {
          const buf = await T.buildWhatsAppSticker(sticker, pack.title);
          await sock.sendMessage(chatId, { sticker: buf });
          sent++;
        } catch (e) {
          console.error('tgpack sticker error:', e.message);
          failed++;
        }
        await new Promise(r => setTimeout(r, DELAY_MS));
      }

      let done = `✅ *${pack.title}* — sent ${sent} sticker(s)`;
      if (failed) done += `\n⚠️ ${failed} failed`;
      if (pack.stickers.length > list.length) {
        done += `\nℹ️ Pack has ${pack.stickers.length} stickers (send *.tgpack ${query || ''} ${Math.min(MAX_PACK, pack.stickers.length)}* for more)`;
      }
      await status.update(done);
    } catch (e) {
      console.error('tgpack error:', e.message);
      await extra.reply(T.friendlyError(e));
    }
  }
};
