/**
 * ZaFar Bot — Bot Management
 */

const config = require('../../config');

const BOT_START = Date.now();

function uptime(ms) {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60),
        h = Math.floor(m / 60),   d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

// ─── Real restart (panel API) ─────────────────────────────────────────────────
// A plain process.exit() only STOPS the server on hosts where crash detection is
// disabled, so the restart is requested from the panel itself via utils/panelClient.js.
//   PANEL_API_KEY    client key (Panel → Account → API Keys, "hydro_…" / "ptlc_…") REQUIRED
//   PANEL_SERVER_ID  short server id (auto-discovered via /api/client if omitted)  optional
//   PANEL_URL        panel HTTPS address                                           optional
const { panelRestart } = require('../../utils/panelClient');
let restarting = false;

function mb(bytes) { return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }

async function react(sock, msg, emoji) {
  try { await sock.sendMessage(msg.key.remoteJid, { react: { text: emoji, key: msg.key } }); }
  catch (_) {}
}

module.exports = [

  {
    name: 'status',
    aliases: ['update', 'botstatus'],
    category: 'admin',
    description: 'Show bot stats',
    usage: '.status',
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
      const { inspectDisk } = require('../../utils/diskSpace');
      const disk = inspectDisk();
      const diskLine = `│ 💿 Folder: ${disk.folderUsedMB.toFixed(0)} / ${disk.budgetMB} MB` +
        (disk.reservedMB > 0 ? ` (+${disk.reservedMB.toFixed(0)} MB reserved)` : '') + '\n';
      const statfsLine = disk.statfsFreeMB != null
        ? `│ 🗄️ statfs: ${(disk.statfsFreeMB / 1024).toFixed(1)} GB free` +
          (disk.statfsSeesHostNode ? ' (host node)' : '') + '\n'
        : '';

      const t =
        `╭─ *${config.botName} — Stats*\n` +
        `│ 🟢 Online\n` +
        `│ ⏱️ Uptime: ${uptime(Date.now() - BOT_START)}\n` +
        `│ 📦 Commands: ${uniqueCmds}\n` +
        (botVersion ? `│ 🏷️ Version: ${botVersion}\n` : '') +
        `│ 💾 RAM: ${mb(mem.rss)}\n` +
        diskLine +
        statfsLine +
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
      if (restarting) return extra.reply('⏳ A restart is already in progress.');
      restarting = true;
      await react(sock, msg, '🔄');
      await extra.reply(`╭─ 🔄 *Restarting...*\n│ Back in a few seconds.\n╰─ ${config.botName}`);

      const result = await panelRestart();
      if (result.ok) {   // the panel stops this process and starts it again
        setTimeout(() => { restarting = false; }, 60000).unref();
        return;
      }

      // Panel restart unavailable: reconnect WhatsApp instead (code is NOT reloaded).
      await extra.reply(
        `╭─ ⚠️ *Full restart unavailable*\n│ ${result.reason}\n│ Reconnecting WhatsApp only.\n╰─ ${config.botName}`
      );
      setTimeout(() => {
        restarting = false;
        try { sock.end(new Error('restart requested')); } catch (_) { /* already closed */ }
      }, 1500);
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
      if (args.length < 1) return extra.reply(`❓ Usage: ${config.prefix}broadcast <message>`);
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
