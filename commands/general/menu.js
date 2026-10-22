/**
 * ZaFar Bot — Menu
 *
 * One clean, aligned card. Grouped by what the user is trying to do, not by
 * folder layout, and without emoji noise: a command list should be scannable
 * on a phone in a group chat.
 *
 *   .menu          everything
 *   .menu media    only the media section
 */

const config = require('../../config');

const GROUPS = [
  {
    key: 'media',
    title: 'MEDIA',
    rows: [
      ['.movie <title> [year] [720]', 'film → document'],
      ['.series <title> s01e03', 'one episode (or s01 1-6 / s01 full)'],
      ['.song <name or link>', 'audio → MP3 document'],
      ['.ytv <name or link> [720]', 'video → MP4'],
      ['.dl <link> [audio|720]', 'any supported site'],
      ['.tiktok  .x  .pinterest', 'social video grabs'],
      ['.instagram  .fb', 'social video grabs'],
      ['.spotify <url | title>', 'track or album'],
      ['.sticker  .viewonce', 'reply to a message'],
    ],
  },
  {
    key: 'papers',
    title: 'PAPERS',
    rows: [
      ['.paper [code] [module] [year]', 'find a paper'],
      ['.paper browse', 'walk the archive'],
      ['.countpapers', 'how much is there'],
      ['.refreshpapers', 're-index (owner)'],
    ],
  },
  {
    key: 'engine',
    title: 'ENGINE',
    rows: [
      ['.providers', 'source health'],
      ['.moviestatus', 'cache · queue · counters'],
      ['.debrid', 'torrent account check'],
      ['.info <title>', 'what the sources return'],
    ],
  },
  {
    key: 'admin',
    title: 'ADMIN',
    rows: [
      ['.allow  .disallow  .listusers', 'who may use the bot'],
      ['.on  .off', 'enable/disable a chat'],
      ['.cookies  .ytdl', 'YouTube bot-check tools'],
      ['.health', 'runtime and media health'],
      ['.restart  .update  .broadcast', 'maintenance'],
    ],
  },
  {
    key: 'general',
    title: 'GENERAL',
    rows: [
      ['.ping', 'latency'],
      ['.menu [media|papers|engine|admin]', 'this card'],
    ],
  },
];

const timeNow = () => {
  try {
    return new Date().toLocaleString('en-GB', {
      timeZone: config.timezone || 'Africa/Blantyre',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch { return new Date().toISOString().slice(11, 16); }
};

const SECTION_ALIASES = {
  movie: 'media', movies: 'media', song: 'media', ytv: 'media', dl: 'media',
  paper: 'papers', papers: 'papers',
  engine: 'engine', sources: 'engine', status: 'engine',
  admin: 'admin', all: null, help: null,
};

function buildCard(groups, user) {
  const width = 34;
  const line = '─'.repeat(width);
  const out = [];

  out.push(`╭${line}╮`);
  out.push(`│ 🎬 *${config.botName}*`);
  out.push(`│ 👤 ${user || 'user'}  ·  🕒 ${timeNow()}`);
  out.push(`╰${line}╯`);

  for (const g of groups) {
    out.push('');
    out.push(`▸ *${g.title}*`);
    // plain text (not backticks): one monospace run per line would break the
    // columns on WhatsApp, and a wrapped hint reads worse than a second line
    const pad = Math.min(30, Math.max(...g.rows.map(([cmd]) => cmd.length)) + 2);
    for (const [cmd, hint] of g.rows) {
      if (cmd.length >= pad) {
        out.push(`  ${cmd}`);
        out.push(`  ${' '.repeat(2)}${hint}`);
      } else {
        out.push(`  ${cmd}${' '.repeat(pad - cmd.length)}${hint}`);
      }
    }
  }

  out.push('');
  out.push('_prefix . · pick a result by replying with its number · reply cancel to abort_');
  return out.join('\n');
}

module.exports = {
  name: 'menu',
  aliases: ['help', 'commands'],
  category: 'general',
  description: 'Show all commands',
  usage: '.menu [section]',

  async execute(sock, msg, args, extra) {
    try {
      const senderJid = extra.sender || '';
      const user = String(senderJid).split('@')[0].split(':')[0];

      const wanted = String(args[0] || '').toLowerCase();
      const section = wanted in SECTION_ALIASES ? SECTION_ALIASES[wanted] : null;
      const groups = section ? GROUPS.filter(g => g.key === section) : GROUPS;

      await sock.sendMessage(extra.from, {
        text: buildCard(groups.length ? groups : GROUPS, user),
        mentions: senderJid ? [senderJid] : [],
      }, { quoted: msg });
    } catch (err) {
      await extra.reply(`❌ ${err.message}`);
    }
  },

  _buildCard: buildCard,
  _GROUPS: GROUPS,
};
