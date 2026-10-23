const engine = require('../../utils/movieEngine');
const telemetry = require('../../utils/telemetry');

const providersCommand = {
  name: 'providers',
  aliases: ['sources'],
  category: 'general',
  description: 'List download providers',
  usage: '.providers',

  async execute(sock, msg, args, extra) {
    try {
      const rows = await engine.providers();
      if (!rows.length) return extra.reply('No providers loaded.');

      const lines = rows
        .sort((a, b) => b.tier - a.tier || String(a.id).localeCompare(String(b.id)))
        .map((p) => {
          const state = String(p.state || 'live');
          const icon = /live|closed/i.test(state) ? '🟢' : /open/i.test(state) ? '🔴' : '🟡';
          return `${icon} ${p.id}`;
        });

      return extra.reply([`*Providers (${lines.length})*`, ...lines].join('\n'));
    } catch (e) {
      console.error('[providers] error:', e.message);
      return extra.reply('❌ Could not load providers.');
    }
  },
};

const statusCommand = {
  name: 'moviestatus',
  aliases: ['moviestats', 'enginestats'],
  category: 'general',
  description: 'Engine status',
  usage: '.moviestatus',

  async execute(sock, msg, args, extra) {
    try {
      const [stats, q] = await Promise.all([engine.stats(), engine.queueSize()]);
      const minutes = Math.floor((stats.uptimeMs || 0) / 60000);
      const { tempUsage } = require('../../utils/cleanup');
      const { inspectDisk } = require('../../utils/diskSpace');
      const tempMB = tempUsage() / 1048576;
      const d = inspectDisk();
      const t = telemetry.snapshot();

      const text = [
        '📊 *Engine*',
        `Uptime: ${minutes}m`,
        `Queue: ${q.running} active · ${q.queued} waiting`,
        `Disk: ${d.folderUsedMB.toFixed(0)} / ${d.budgetMB} MB`,
        `Temp: ${tempMB.toFixed(1)} MB`,
        `Downloads: ${t.downloadsSuccess} ok · ${t.failedTotal} failed`,
      ].join('\n');

      return extra.reply(text);
    } catch (e) {
      console.error('[moviestatus] error:', e.message);
      return extra.reply('❌ Could not read engine status.');
    }
  },
};

module.exports = [providersCommand, statusCommand];
