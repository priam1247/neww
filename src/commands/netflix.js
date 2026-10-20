// src/commands/netflix.js — /netflix [movies|tv] [page] — TMDB-backed catalog.
import config from '../config.js';
import { netflixCatalog } from '../media/tmdb.js';

export const help = (P) => `🍿 *${P}netflix [movies|tv] [page]* — Netflix catalog (${config.region})`;

export async function run(ctx, args) {
  const P = config.prefix;
  if (!args.length || args[0] === 'help') return ctx.say(help(P));

  const type = /tv|series|show/i.test(args[0] || '') ? 'tv' : 'movie';
  const page = parseInt(args.find(a => /^\d+$/.test(a)), 10) || 1;

  try {
    const list = await netflixCatalog(type, page);
    if (!list.length) return ctx.say('❌ Nothing found for this region/page.');

    const lines = [
      `🍿 *Netflix ${type === 'movie' ? 'Movies' : 'Series'}* — page ${page} (${config.region})`,
      '',
      ...list.slice(0, 20).map((x, i) => `*${i + 1}.* ${x.title} (${x.year || '?'}${x.rating ? ` ★${x.rating}` : ''})`),
      '',
      `_${P}movie <title> or ${P}series <title> s01e01_`
    ];
    return ctx.say(lines.join('\n'));
  } catch (e) {
    return ctx.say(`❌ ${e.message}`);
  }
}
