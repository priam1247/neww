/**
 * ZaFar Bot — .on / .off
 */

const database = require('../../database');
const config   = require('../../config');

module.exports = {
  name: 'on',
  aliases: ['off'],
  ownerOnly: true,
  category: 'admin',
  description: 'Turn the bot on or off',
  usage: '.on | .off',

  async execute(sock, msg, args, extra) {
    const body = (
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text || ''
    ).trim().toLowerCase();

    const turningOn = body.startsWith(`${config.prefix}on`);

    if (turningOn) {
      database.setBotState(true);
      await sock.sendMessage(extra.from, { react: { text: '✅', key: msg.key } });
      return extra.reply(`✅ *${config.botName} is ON*\nAll commands are active.`);
    } else {
      database.setBotState(false);
      await sock.sendMessage(extra.from, { react: { text: '🔴', key: msg.key } });
      return extra.reply(`🔴 *${config.botName} is OFF*\nUse .on to bring it back.`);
    }
  },
};
