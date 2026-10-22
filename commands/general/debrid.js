/**
 * ZaFar Bot — .debrid
 *
 *   .debrid        verify the debrid key(s) and show the account
 *
 * A key that exists but is rejected is worse than no key: torrents are then
 * attempted and every candidate fails with a vague error. This asks the
 * provider directly (`/user` for Real-Debrid and AllDebrid) and reports the
 * plan, so "torrents are not working" has an obvious answer.
 */

const config = require('../../config');
const engine = require('../../utils/movieEngine');
const log = require('../../utils/logger')('debrid');

const mask = (key) => (key ? `${key.slice(0, 4)}…${key.slice(-4)} (${key.length} chars)` : 'not set');

const debridCommand = {
  name: 'debrid',
  aliases: ['rd', 'debridstatus'],
  category: 'general',
  description: 'Check the debrid account used for torrent sources',
  usage: '.debrid',

  async execute(sock, msg, args, extra) {
    const movies = config.movies || {};
    const configured = [
      movies.realDebridKey ? `Real-Debrid · ${mask(movies.realDebridKey)}` : null,
      movies.allDebridKey ? `AllDebrid · ${mask(movies.allDebridKey)}` : null,
    ].filter(Boolean);

    if (!configured.length) {
      return extra.reply(
        '🔑 *No debrid key configured*\n\n' +
        'Add `REALDEBRID_API_KEY` (or `ALLDEBRID_API_KEY`) to `.env` on the host, then restart.\n' +
        'Free DDL/stream sources still work without it.'
      );
    }

    try {
      const rows = await engine.debridAccounts();
      if (!rows.length) return extra.reply('🔑 key present but the engine sees no active debrid — restart the bot.');

      for (const r of rows) {
        if (r.ok) log.info(`${r.provider} · ${r.username || 'account'} · ${r.premium ? 'premium' : 'free'}` + (r.expiration ? ` until ${String(r.expiration).slice(0, 10)}` : ''));
        else log.warn(`${r.provider} · ${r.error}`);
      }

      const lines = rows.map(r => {
        if (!r.ok) {
          const hint = /BAD_TOKEN/.test(r.error) ? ' → token rejected, generate a new one'
            : /EXPIRED/.test(r.error) ? ' → account expired'
              : '';
          return `🔴 *${r.provider}* — ${r.error}${hint}`;
        }
        return `🟢 *${r.provider}* — ${r.username || 'account'} · ${r.premium ? 'premium' : 'free'}` +
          (r.expiration ? ` · until ${String(r.expiration).slice(0, 10)}` : '') +
          (r.points ? ` · ${r.points} points` : '');
      });

      const ok = rows.some(r => r.ok && r.premium);
      return extra.reply(
        `${lines.join('\n')}\n\n` +
        (ok
          ? '✅ Torrent tier is live — .movie/.series can now use cached 1080p/4K torrents.'
          : config.movies?.torrentDirect !== false
            ? '✅ Torrent sources download directly without a debrid key.'
            : '⚠️ Torrent candidates will be skipped until a premium key validates.')
      );
    } catch (e) {
      console.error('[debrid] error:', e.message);
      return extra.reply('❌ Could not check torrent/debrid account status right now.');
    }
  },
};

module.exports = debridCommand;
