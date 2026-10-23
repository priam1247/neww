const engine = require('../../utils/movieEngine');
const telemetry = require('../../utils/telemetry');

const RELIABILITY_ORDER = [
  'moviebox',
  'vixsrc',
  'vidlink',
  'videasy',
  'vidsrc',
  'vaplayer',
  'yts',
  'torrentio',
  'eztv',
  'nyaa',
  'knaben',
  'solidtorrents',
  'torrentscsv',
  'apibay',
];

const rankOf = (id) => {
  const idx = RELIABILITY_ORDER.indexOf(String(id || '').toLowerCase());
  return idx === -1 ? 999 : idx;
};

const stateScore = (state) => {
  const s = String(state || 'live').toLowerCase();
  if (s === 'live' || s === 'closed') return 0;
  if (s.includes('half')) return 1;
  if (s.startsWith('open')) return 2;
  return 1;
};

const providersCommand = {
  name: 'providers',
  aliases: ['sources'],
  category: 'general',
  description: 'List download providers by reliability',
  usage: '.providers',

  async execute(sock, msg, args, extra) {
    try {
      const rows = await engine.providers();
      if (!rows.length) return extra.reply('No providers loaded.');

      const sorted = [...rows].sort((a, b) => {
        const healthDiff = stateScore(a.state) - stateScore(b.state);
        if (healthDiff !== 0) return healthDiff;
        const rDiff = rankOf(a.id) - rankOf(b.id);
        if (rDiff !== 0) return rDiff;
        return Number(b.trust || 1) - Number(a.trust || 1);
      });

      const lines = sorted.map((p, idx) => {
        const state = String(p.state || 'live');
        const icon = /live|closed/i.test(state) ? '🟢' : /open/i.test(state) ? '🔴' : '🟡';
        return `${idx + 1}. ${icon} ${p.id}`;
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
