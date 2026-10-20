/**
 * ZaFar Bot — Bot Management
 */

const config = require('../../config');
const os     = require('os');

const BOT_START = Date.now();

function uptime(ms) {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60),
        h = Math.floor(m / 60),   d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function mb(bytes) { return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }

async function react(sock, msg, emoji) {
  try { await sock.sendMessage(msg.key.remoteJid, { react: { text: emoji, key: msg.key } }); }
  catch (_) {}
}

module.exports = [

  {
    name: 'update',
    aliases: ['status', 'botstatus'],
    category: 'admin',
    description: 'Show bot stats',
    usage: '.update',
    ownerOnly: true,
    async execute(sock, msg, args, extra) {
      await react(sock, msg, '🔄');
      const mem  = process.memoryUsage();
      const now  = new Date().toLocaleString('en-GB', { timeZone: config.timezone });
      const { loadCommands } = require('../../utils/commandLoader');
      const cmds = loadCommands();
      // The map holds one entry per name *and* alias — count real commands.
      const uniqueCmds = new Set(cmds.values()).size;
      let botVersion = '';
      try { botVersion = require('../../package.json').version; } catch (_) { /* ignore */ }

      const t =
        `╭─ *${config.botName} — Stats*\n` +
        `│ 🟢 Online\n` +
        `│ ⏱️ Uptime: ${uptime(Date.now() - BOT_START)}\n` +
        `│ 📦 Commands: ${uniqueCmds}\n` +
        (botVersion ? `│ 🏷️ Version: ${botVersion}\n` : '') +
        `│ 💾 RAM: ${mb(mem.rss)}\n` +
        `│ 🕒 ${now}\n` +
        `│ 🖥️ Node: ${process.version}\n` +
        `│ ⚙️ Prefix: \`${config.prefix}\`\n` +
        `╰─ *${config.botName}*`;

      await react(sock, msg, '✅');
      return extra.reply(t);
    },
  },

  {
    name: 'restart',
    aliases: ['reboot'],
    category: 'admin',
    description: 'Restart the bot',
    usage: '.restart',
    ownerOnly: true,
    async execute(sock, msg, args, extra) {
      await react(sock, msg, '🔄');
      await extra.reply(`╭─ 🔄 *Restarting...*\n│ Back in a few seconds.\n╰─ ${config.botName}`);
      setTimeout(() => process.exit(0), 2000);
    },
  },

  {
    name: 'broadcast',
    aliases: ['bc', 'announce'],
    category: 'admin',
    description: 'Broadcast a message to all groups',
    usage: '.broadcast <message>',
    ownerOnly: true,
    async execute(sock, msg, args, extra) {
      if (args.length < 1) return extra.reply('❓ Usage: .broadcast <message>');
      const message = args.join(' ');
      await react(sock, msg, '📢');

      let chats = {};
      try { chats = await sock.groupFetchAllParticipating(); } catch (_) {}

      const ids = Object.keys(chats);
      let sent = 0, failed = 0;
      const text = `╭─ 📢 *${config.botName}*\n│\n│ ${message}\n╰─ ${config.botName}`;

      for (const jid of ids) {
        try {
          await sock.sendMessage(jid, { text });
          sent++;
          await new Promise(r => setTimeout(r, 500));
        } catch (_) { failed++; }
      }

      await react(sock, msg, '✅');
      return extra.reply(
        `╭─ 📢 *Broadcast Done*\n│ ✅ Sent: ${sent}\n│ ❌ Failed: ${failed}\n╰─ ${config.botName}`
      );
    },
  },

];
