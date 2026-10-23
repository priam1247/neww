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

function render(item) {
  const lines = [
    `${item.type === 'series' ? '📺' : '🎬'} *${item.title}*${item.year ? ` (${item.year})` : ''}`,
  ];
  if (item.rating) lines.push(`⭐ ${item.rating}`);
  if (item.runtime) lines.push(`⏱ ${item.runtime} min`);
  if (item.seasons) lines.push(`📚 ${item.seasons} season(s)${item.episodes ? ` · ${item.episodes} ep` : ''}`);
  else if (item.episodes) lines.push(`📚 ${item.episodes} ep`);
  if (item.genres?.length) lines.push(`🏷 ${item.genres.slice(0, 4).join(', ')}`);
  if (item.overview) lines.push('', `_${String(item.overview).slice(0, 240)}${String(item.overview).length > 240 ? '…' : ''}_`);
  return lines.join('\n');
}

module.exports = {
  name: 'info',
  aliases: ['meta', 'ids', 'lookup'],
  category: 'general',
  description: 'Title metadata',
  usage: '.info [series] <title>',

  async execute(sock, msg, args, extra) {
    const { title, type } = parseArgs(args);
    if (!title) return extra.reply('Usage: .info [series] <title>');

    try {
      const hits = await engine.lookup(title, { type, limit: 3 });
      if (!hits.length) return extra.reply(`❌ Not found: *${title}*`);

      const text = render(hits[0]);
      const poster = hits[0].poster;
      if (poster) {
        return sock.sendMessage(extra.from, { image: { url: poster }, caption: text }, { quoted: msg })
          .catch(() => extra.reply(text));
      }
      return extra.reply(text);
    } catch (e) {
      console.error('[info] error:', e.message);
      return extra.reply('❌ Lookup failed.');
    }
  },
};
