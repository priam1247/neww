/**
 * Telegram Sticker - Send one Telegram sticker (no link needed)
 *
 *   .tgsticker              -> random sticker
 *   .tgsticker 3            -> sticker #3 from this chat's last pack
 *   .tgsticker cat          -> random sticker from a "cat" pack
 *   .tgsticker meme 5       -> sticker #5 from a "meme" pack
 *   .tgsticker <t.me link>  -> from that pack (or reply to a message with the link)
 */

const T = require('../../utils/telegram');

module.exports = {
  name: 'tgsticker',
  aliases: ['tgs', 'stickersearch'],
  category: 'media',
  description: 'Get a Telegram sticker by keyword, number, or pack link',
  usage: '.tgsticker [keyword or link] [number]',

  async execute(sock, msg, args, extra) {
    const chatId = extra.from;
    try {
      const { pack, num } = await T.resolvePack(args, msg, chatId, { useRemembered: true });
      const index = num !== null
        ? Math.max(1, Math.min(pack.stickers.length, num)) - 1
        : Math.floor(Math.random() * pack.stickers.length);
      const buf = await T.buildWhatsAppSticker(pack.stickers[index], pack.title);
      await sock.sendMessage(chatId, { sticker: buf }, { quoted: msg });
    } catch (e) {
      console.error('tgsticker error:', e.message);
      await extra.reply(T.friendlyError(e));
    }
  }
};
