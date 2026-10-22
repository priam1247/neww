/**
 * ZaFar Bot — Menu
 *
 * One clean, aligned card. Grouped by what the user is trying to do, honouring
 * configured `config.prefix` and `config.botName`, and hiding admin-only
 * commands from regular users.
 *
 *   .menu          everything permitted for the caller
 *   .menu media    only the media section
 */

const config = require('../../config');
const { safeErrorMessage } = require('../../utils/userErrors');

function buildGroups(prefix = '.', { isOwner = false } = {}) {
  const p = prefix || '.';
  const groups = [
    {
      key: 'media',
      title: 'MEDIA',
      rows: [
        [`${p}movie <title> [year] [720]`, 'film → document'],
        [`${p}series <title> s01e03`, 'episode, s01 1-6, or season'],
        [`${p}song <name or link>`, 'audio → MP3 document'],
        [`${p}ytv <name or link> [720]`, 'video → MP4'],
        [`${p}dl <link> [audio|720]`, 'any supported site'],
        [`${p}tiktok  ${p}x  ${p}pinterest`, 'social video grabs'],
        [`${p}instagram  ${p}fb`, 'social video grabs'],
        [`${p}spotify <url | title>`, 'track → MP3'],
        [`${p}sticker  ${p}viewonce`, 'reply to a message'],
      ],
    },
    {
      key: 'papers',
      title: 'PAPERS',
      rows: [
        [`${p}paper [code] [module] [year]`, 'find past papers'],
        [`${p}paper browse [page]`, 'walk the archive'],
        [`${p}countpapers`, 'how much is there'],
        ...(isOwner ? [[`${p}refreshpapers`, 're-index vault (owner)']] : []),
      ],
    },
    {
      key: 'engine',
      title: 'ENGINE',
      rows: [
        [`${p}providers`, 'source health'],
        [`${p}moviestatus`, 'cache · queue · counters'],
        [`${p}debrid`, 'torrent account check'],
        [`${p}info <title>`, 'what the sources return'],
      ],
    },
  ];

  if (isOwner) {
    groups.push({
      key: 'admin',
      title: 'ADMIN',
      rows: [
        [`${p}allow  ${p}disallow  ${p}listusers`, 'who may use the bot'],
        [`${p}on  ${p}off`, 'enable/disable the bot globally'],
        [`${p}cookies  ${p}ytdl`, 'YouTube bot-check tools'],
        [`${p}restart  ${p}status  ${p}broadcast`, 'maintenance'],
      ],
    });
  }

  const sectionsHint = isOwner ? 'media|papers|engine|admin' : 'media|papers|engine';
  groups.push({
    key: 'general',
    title: 'GENERAL',
    rows: [
      [`${p}ping`, 'latency'],
      [`${p}menu [${sectionsHint}]`, 'this card'],
    ],
  });

  return groups;
}

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

function buildCard(groups, user, { prefix = config.prefix || '.', botName = config.botName || 'ZaFar Bot' } = {}) {
  const width = 34;
  const line = '─'.repeat(width);
  const out = [];

  out.push(`╭${line}╮`);
  out.push(`│ 🎬 *${botName}*`);
  out.push(`│ 👤 ${user || 'user'}  ·  🕒 ${timeNow()}`);
  out.push(`╰${line}╯`);

  for (const g of groups) {
    out.push('');
    out.push(`▸ *${g.title}*`);
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
  out.push(`_prefix ${prefix} · tap a poll option or reply with its number · reply cancel to abort_`);
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
      const isOwner = Boolean(extra?.isOwner);
      const prefix = config.prefix || '.';
      const botName = config.botName || 'ZaFar Bot';
      const senderJid = extra?.sender || '';
      const user = String(senderJid).split('@')[0].split(':')[0];

      const wanted = String(args[0] || '').toLowerCase();
      const section = wanted in SECTION_ALIASES ? SECTION_ALIASES[wanted] : null;
      if (section === 'admin' && !isOwner) {
        return extra.reply(config.messages?.ownerOnly || '❌ Only the bot owner can view admin commands.');
      }

      const allGroups = buildGroups(prefix, { isOwner });
      const groups = section ? allGroups.filter((g) => g.key === section) : allGroups;

      await sock.sendMessage(extra.from, {
        text: buildCard(groups.length ? groups : allGroups, user, { prefix, botName }),
        mentions: senderJid ? [senderJid] : [],
      }, { quoted: msg });
    } catch (err) {
      console.error('[menu] error:', err.message);
      await extra.reply(safeErrorMessage(err, { isOwner: Boolean(extra?.isOwner) }));
    }
  },

  _buildCard: buildCard,
  _buildGroups: buildGroups,
};
