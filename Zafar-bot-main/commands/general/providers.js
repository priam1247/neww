/**
 * ZaFar Bot — .providers / .moviestatus
 *
 *   .providers     source health for movies & series (wins, fails, breaker state)
 *   .moviestatus   engine counters + cache usage + queue depth
 *
 * Both are read-only and useful when a download fails: they show whether a
 * source is down (breaker open) or whether nothing is configured at all.
 */

const config = require('../../config');
const engine = require('../../utils/movieEngine');

const TIER_NAME = { 1: 'torrent', 2: 'ddl', 3: 'stream' };

const providersCommand = {
  name: 'providers',
  aliases: ['sources', 'health'],
  category: 'general',
  description: 'Movie/series source health',
  usage: '.providers',

  async execute(sock, msg, args, extra) {
    try {
      const rows = await engine.providers();
      if (!rows.length) return extra.reply('No sources registered — the engine did not load.');

      const m = config.movies || {};
      const debrid = [
        m.realDebridKey ? 'Real-Debrid' : null,
        m.allDebridKey ? 'AllDebrid' : null,
      ].filter(Boolean);

      const lines = rows
        .sort((a, b) => a.tier - b.tier || String(a.id).localeCompare(String(b.id)))
        .map(p => {
          const state = String(p.state || '?');
          const icon = /live|closed/i.test(state) ? '🟢' : /open/i.test(state) ? '🔴' : '🟡';
          return `${icon} *${p.id}* · t${p.tier} ${TIER_NAME[p.tier] || ''} · trust ${p.trust} · ${p.wins}w/${p.fails}f · ${p.latency}`;
        });

      const text = [
        `📡 *Sources* (${rows.length})`,
        '',
        ...lines,
        '',
        `🔑 TMDB: ${m.tmdbKey ? 'set' : 'MISSING'}`,
        `🔑 debrid: ${debrid.length ? debrid.join(', ') : 'none — torrents skipped, free sources only'}`,
      ].join('\n');

      return extra.reply(text);
    } catch (e) {
      return extra.reply(`❌ ${String(e.message || '').split('\n')[0]}`);
    }
  },
};

const statusCommand = {
  name: 'moviestatus',
  aliases: ['moviestats', 'enginestats'],
  category: 'general',
  description: 'Movie engine counters, cache and queue',
  usage: '.moviestatus',

  async execute(sock, msg, args, extra) {
    try {
      const [stats, cache, q] = await Promise.all([
        engine.stats(), engine.cacheStats(), engine.queueSize(),
      ]);

      const c = stats.counters || {};
      const g = (k) => c[k] || 0;
      const minutes = Math.floor((stats.uptimeMs || 0) / 60000);

      const text = [
        '📊 *Movie engine*',
        '```',
        `uptime      ${minutes}m`,
        `queue       ${q.running} running / ${q.queued} waiting`,
        `searches    ${g('search.ok')} ok / ${g('search.empty')} empty`,
        `resolves    ${g('resolve.ok')} ok / ${g('resolve.fail')} fail`,
        `tier wins   t1 ${g('tier.1')} · t2 ${g('tier.2')} · t3 ${g('tier.3')}`,
        `verify      ${g('verify.ok')} ok / ${g('verify.fail')} reject`,
        `cache hits  disk ${g('cache.disk')} · link ${g('cache.link')} · meta ${g('cache.meta')}`,
        `cache files ${cache.files} (${(cache.bytes / 1073741824).toFixed(2)} GB) · active ${cache.active}`,
        `downloads   ${(g('download.bytes') / 1073741824).toFixed(2)} GB`,
        '```',
      ].join('\n');

      return extra.reply(text);
    } catch (e) {
      return extra.reply(`❌ ${String(e.message || '').split('\n')[0]}`);
    }
  },
};

module.exports = [providersCommand, statusCommand];
