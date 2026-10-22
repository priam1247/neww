/**
 * ZaFar Bot — .info / .meta / .id
 *
 *   .info <title>            aggregated metadata for a movie
 *   .info series <title>     … for a TV series
 *
 * Shows what the multi-source metadata layer found and, crucially, which source
 * contributed which id (imdb/tmdb/mal) — the ids the download providers depend
 * on. Use it when .movie/.series says "no source found": if the ids are missing
 * here, the problem is metadata, not providers.
 */

const config = require('../../config');
const engine = require('../../utils/movieEngine');

const TYPE_WORDS = new Set(['movie', 'movies', 'film', 'series', 'tv', 'show', 'anime']);

function parseArgs(args) {
  const list = [...args];
  let type = 'movie';
  if (list.length && TYPE_WORDS.has(String(list[0]).toLowerCase())) {
    const t = String(list.shift()).toLowerCase();
    type = (t === 'series' || t === 'tv' || t === 'show' || t === 'anime') ? 'series' : 'movie';
  }
  return { title: list.join(' ').trim(), type };
}

const ids = (item) => [
  item.imdbId && `imdb:${item.imdbId}`,
  item.tmdbId && `tmdb:${item.tmdbId}`,
  item.tvdbId && `tvdb:${item.tvdbId}`,
  item.malId && `mal:${item.malId}`,
  item.anilistId && `anilist:${item.anilistId}`,
  item.traktId && `trakt:${item.traktId}`,
  item.tvmazeId && `tvmaze:${item.tvmazeId}`,
].filter(Boolean).join(' · ');

function render(item) {
  const lines = [
    `${item.type === 'series' ? '📺' : '🎬'} *${item.title}*${item.year ? ` (${item.year})` : ''}`,
  ];
  if (item.rating) lines.push(`⭐ ${item.rating}${item.votes ? ` (${item.votes} votes)` : ''}`);
  if (item.runtime) lines.push(`⏱ ${item.runtime} min`);
  if (item.seasons) lines.push(`📚 ${item.seasons} season(s)${item.episodes ? ` · ${item.episodes} episodes` : ''}`);
  else if (item.episodes) lines.push(`📚 ${item.episodes} episodes`);
  if (item.genres?.length) lines.push(`🏷 ${item.genres.slice(0, 4).join(', ')}`);
  if (item.anime) lines.push('🍥 anime');
  if (item.overview) lines.push('', `_${String(item.overview).slice(0, 320)}${String(item.overview).length > 320 ? '…' : ''}_`);
  lines.push('', `🔗 ${ids(item) || 'no ids — downloads will fall back to a title search'}`);
  lines.push(`📡 ${(item.sources || [item.source]).join(' · ')}`);
  return lines.join('\n');
}

module.exports = {
  name: 'info',
  aliases: ['meta', 'ids', 'lookup'],
  category: 'general',
  description: 'Metadata + provider ids for a title',
  usage: '.info [series] <title>',

  async execute(sock, msg, args, extra) {
    const { title, type } = parseArgs(args);
    if (!title) {
      return extra.reply(
        `Usage: .info <title>\n` +
        `       .info series <title>\n\n` +
        `Shows the ids (imdb/tmdb/mal) that .movie/.series need, and which ` +
        `metadata source produced them: TMDB · Cinemeta · IMDb · TVMaze · OMDb · Trakt · Jikan · AniList`
      );
    }

    try {
      const hits = await engine.lookup(title, { type, limit: 3 });
      if (!hits.length) {
        return extra.reply(`❌ Nothing found for *${title}* in any metadata source.`);
      }

      const text = render(hits[0]);
      const others = hits.slice(1).filter(h => h.title);
      const more = others.length
        ? `\n\n_Other matches:_ ${others.map(h => `${h.title}${h.year ? ` (${h.year})` : ''}`).join(' · ')}`
        : '';

      const poster = hits[0].poster;
      if (poster) {
        return sock.sendMessage(extra.from, { image: { url: poster }, caption: text + more }, { quoted: msg })
          .catch(() => extra.reply(text + more));
      }
      return extra.reply(text + more);
    } catch (e) {
      console.error('[info] error:', e.message);
      return extra.reply('❌ Could not look up metadata right now. Please try again shortly.');
    }
  },

  _parseArgs: parseArgs,
  _render: render,
};
