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
  description: 'Turn the bot on or off globally',
  usage: '.on | .off',

  async execute(sock, msg, args, extra) {
    // Use the resolved command name from handler.js (works across ephemeral
    // messages, captions, custom prefixes, etc.) instead of raw message text.
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
      return extra.reply(`✅ *${config.botName} is ON*\nAll commands are active.`);
    } else {
      database.setBotState(false);
      await sock.sendMessage(extra.from, { react: { text: '🔴', key: msg.key } });
      return extra.reply(`🔴 *${config.botName} is OFF*\nUse ${config.prefix}on to bring it back.`);
    }
  },
};
