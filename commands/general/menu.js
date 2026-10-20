/**
 * ZaFar Bot — Menu
 */

const config = require('../../config');

module.exports = {
  name: 'menu',
  aliases: ['help', 'commands'],
  category: 'general',
  description: 'Show all commands',
  usage: '.menu',

  async execute(sock, msg, args, extra) {
    try {
      // Keep the full JID for mentions: a LID sender is not @s.whatsapp.net,
      // so the old mention never highlighted the user in groups.
      const senderJid = extra.sender || '';
      const user = String(senderJid).split('@')[0].split(':')[0];
      const now  = new Date().toLocaleString('en-GB', {
        timeZone: config.timezone || 'Africa/Blantyre',
        hour: '2-digit', minute: '2-digit', hour12: false,
      });

      let m = `▌ ZaFar Bot by Zafar\n`;
      m    += `▌ 👤 @${user} ┊ 🕒 ${now}\n`;
      m    += `─────────────────────\n`;

      m += `◈ PAPERS\n`;
      m += `└─ .paper [code] [module] [year]\n`;
      m += `└─ .paper browse\n`;
      m += `└─ .countpapers\n`;
      m += `└─ .refreshpapers 👑\n`;

      m += `◈ MEDIA\n`;
      m += `└─ .movie <title> [year] [480-2160]  → film\n`;
      m += `└─ .series <title> s01e03 | s01 1-6 | s01 full\n`;
      m += `└─ .song <name/link> [audio|doc]  → MP3\n`;
      m += `└─ .ytv <name/link> [144-1080]  → MP4\n`;
      m += `└─ .dl <any link> [audio|720]  → any site\n`;
      m += `└─ .tiktok  .x  .pinterest  .spotify\n`;
      m += `└─ _search: reply with a number to pick_\n`;
      m += `└─ .sticker  .viewonce\n`;
      m += `└─ .instagram  .fb\n`;
      m += `└─ .info  .providers  .moviestatus  (movie engine)\n`;
      m += `└─ .tgsticker  .tgpack\n`;

      m += `◈ GENERAL\n`;
      m += `└─ .ping  .menu\n`;

      m += `◈ ADMIN\n`;
      m += `└─ .allow  .disallow  .listusers\n`;
      m += `└─ .on  .off  .restart  .update\n`;
      m += `└─ .cookies  (fix .song/.ytv bot-checks)\n`;
      m += `└─ .ytdl  (YouTube engine: status/fix/proxy)\n`;
      m += `└─ .broadcast`;

      await sock.sendMessage(extra.from, {
        text: m,
        mentions: senderJid ? [senderJid] : [],
      }, { quoted: msg });

    } catch (err) {
      await extra.reply(`❌ ${err.message}`);
    }
  },
};
