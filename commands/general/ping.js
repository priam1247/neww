/**
 * ZaFar Bot — Ping
 */
const config = require('../../config');

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
        text: `🏓 *Pong!* · ${ms}ms`,
        edit: sent.key,
      });
    } catch (err) {
      console.error('[ping] error:', err.message);
      await extra.reply('❌ Could not measure latency right now.');
    }
  },
};
