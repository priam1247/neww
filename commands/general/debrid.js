const config = require('../../config');
const engine = require('../../utils/movieEngine');

const debridCommand = {
  name: 'debrid',
  aliases: ['rd', 'debridstatus'],
  category: 'general',
  description: 'Debrid status',
  usage: '.debrid',

  async execute(sock, msg, args, extra) {
    const movies = config.movies || {};
    const hasKey = Boolean(movies.realDebridKey || movies.allDebridKey);

    if (!hasKey) {
      return extra.reply('⚪ No debrid configured.');
    }

    try {
      const rows = await engine.debridAccounts();
      if (!rows.length) return extra.reply('⚪ No active debrid.');

      const lines = rows.map((r) => {
        if (!r.ok) return `🔴 *${r.provider}* — ${r.error}`;
        return `🟢 *${r.provider}* — ${r.username || 'active'} (${r.premium ? 'premium' : 'free'})`;
      });

      return extra.reply(lines.join('\n'));
    } catch (e) {
      console.error('[debrid] error:', e.message);
      return extra.reply('❌ Could not check debrid status.');
    }
  },
};

module.exports = debridCommand;
