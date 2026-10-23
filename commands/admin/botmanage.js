const config = require('../../config');
const { panelRestart } = require('../../utils/panelClient');
const telemetry = require('../../utils/telemetry');

const BOT_START = Date.now();
let restarting = false;

function uptime(ms) {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60),
        h = Math.floor(m / 60),   d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

async function react(sock, msg, emoji) {
  try { await sock.sendMessage(msg.key.remoteJid, { react: { text: emoji, key: msg.key } }); }
  catch (_) {}
}

module.exports = [
  {
    name: 'status',
    aliases: ['update', 'botstatus'],
    category: 'admin',
    description: 'Server stats',
    usage: '.status',
    ownerOnly: true,
    async execute(sock, msg, args, extra) {
      await react(sock, msg, '🔄');
      const mem = process.memoryUsage();
      const { inspectDisk } = require('../../utils/diskSpace');
      const disk = inspectDisk();
      const t = telemetry.snapshot();

      const text = [
        `🟢 *${config.botName}*`,
        `⏱ Uptime: ${uptime(Date.now() - BOT_START)}`,
        `⚡ Commands: ${t.commandsTotal}`,
        `📥 Downloads: ${t.downloadsSuccess} ok · ${t.failedTotal} failed`,
        `💾 RAM: ${(mem.rss / 1048576).toFixed(0)} MB`,
        `💿 Disk: ${disk.folderUsedMB.toFixed(0)} / ${disk.budgetMB} MB`,
      ].join('\n');

      await react(sock, msg, '✅');
      return extra.reply(text);
    },
  },

  {
    name: 'restart',
    aliases: ['reboot'],
    category: 'admin',
    description: 'Restart bot',
    usage: '.restart',
    ownerOnly: true,
    async execute(sock, msg, args, extra) {
      if (restarting) return extra.reply('⏳ Restart in progress.');
      restarting = true;
      await react(sock, msg, '🔄');
      await extra.reply('🔄 Restarting…');

      const result = await panelRestart();
      if (result.ok) {
        setTimeout(() => { restarting = false; }, 60000).unref();
        return;
      }

      const { reloadRuntime } = require('../../utils/hotReload');
      try { reloadRuntime(); } catch (_) {}

      await extra.reply('♻️ Reloaded code & reconnecting…');
      setTimeout(() => {
        restarting = false;
        try { sock.end(new Error('restart requested')); } catch (_) {}
      }, 1000);
    },
  },

  {
    name: 'broadcast',
    aliases: ['bc', 'announce'],
    category: 'admin',
    description: 'Broadcast to groups',
    usage: '.broadcast <message>',
    ownerOnly: true,
    async execute(sock, msg, args, extra) {
      if (args.length < 1) return extra.reply(`Usage: ${config.prefix}broadcast <message>`);
      const message = args.join(' ');
      await react(sock, msg, '📢');

      let chats = {};
      try { chats = await sock.groupFetchAllParticipating(); } catch (_) {}

      const ids = Object.keys(chats);
      let sent = 0, failed = 0;
      const text = `📢 *${config.botName}*\n${message}`;

      for (const jid of ids) {
        try {
          await sock.sendMessage(jid, { text });
          sent++;
          await new Promise(r => setTimeout(r, 500));
        } catch (_) { failed++; }
      }

      await react(sock, msg, '✅');
      return extra.reply(`📢 Sent: ${sent} · Failed: ${failed}`);
    },
  },
];
