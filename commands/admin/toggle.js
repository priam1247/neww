const database = require('../../database');
const config   = require('../../config');

module.exports = {
  name: 'on',
  aliases: ['off'],
  ownerOnly: true,
  category: 'admin',
  description: 'Enable or disable the bot globally',
  usage: '.on | .off',

  async execute(sock, msg, args, extra) {
    const invoked = String(extra?.commandName || '').trim().toLowerCase();
    const turningOn = invoked
      ? invoked === 'on'
      : (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '')
          .trim()
          .toLowerCase()
          .startsWith(`${config.prefix}on`);

    if (turningOn) {
      database.setBotState(true);
      await sock.sendMessage(extra.from, { react: { text: '✅', key: msg.key } });
      return extra.reply('🟢 Bot ON');
    } else {
      database.setBotState(false);
      await sock.sendMessage(extra.from, { react: { text: '🔴', key: msg.key } });
      return extra.reply('🔴 Bot OFF');
    }
  },
};
