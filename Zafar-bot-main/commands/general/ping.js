/**
 * ZaFar Bot — Ping
 */
module.exports = {
  name: 'ping',
  aliases: ['p'],
  category: 'general',
  description: 'Check bot response time',
  usage: '.ping',

  async execute(sock, msg, args, extra) {
    try {
      const start = Date.now();
      const sent  = await extra.reply('🏓 Pinging...');
      const ms    = Date.now() - start;
      await sock.sendMessage(extra.from, {
        text: `╭─ 🏓 *Pong!*\n│ ⚡ ${ms}ms response\n╰─ ZaFar Bot`,
        edit: sent.key,
      });
    } catch (err) {
      await extra.reply(`❌ ${err.message}`);
    }
  },
};
