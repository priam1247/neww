const { readWL, writeWL, cleanNumber, findUserIndex } = require('../../utils/accessControl');
const { canonicalIdentity } = require('../../utils/jid');

async function react(sock, msg, emoji) {
  try { await sock.sendMessage(msg.key.remoteJid, { react: { text: emoji, key: msg.key } }); }
  catch (_) {}
}

function resolveTarget(args, msg) {
  const mentioned = msg?.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  let jid = mentioned?.length ? mentioned[0] : null;
  if (!jid && args[0]) {
    const n = cleanNumber(args[0]);
    if (n) jid = `${n}@s.whatsapp.net`;
  }
  if (!jid) return null;
  const { number, alt } = canonicalIdentity(jid);
  return number ? { number, alt, jid } : null;
}

module.exports = [
  {
    name: 'allow',
    aliases: ['allowuser'],
    category: 'admin',
    description: 'Allow a number',
    usage: '.allow <number>',
    ownerOnly: true,
    async execute(sock, msg, args, extra) {
      const target = resolveTarget(args, msg);
      if (!target) return extra.reply('Usage: .allow <number>');
      const { number, alt, jid } = target;
      const wl = readWL();
      if (findUserIndex(wl.users, jid) !== -1) {
        await react(sock, msg, '⚠️');
        return extra.reply(`⚠️ Already allowed: +${number}`);
      }
      wl.users.push({
        number,
        ...(alt.length ? { alt } : {}),
        addedBy: 'whatsapp',
        enabled: true,
        addedAt: Date.now(),
      });
      writeWL(wl);
      try { require('../../utils/dashboardSync').triggerImmediateSync(); } catch { /* ignore */ }
      await react(sock, msg, '✅');
      return extra.reply(`✅ Allowed +${number}`);
    },
  },
  {
    name: 'disallow',
    aliases: ['disallowuser', 'removeuser'],
    category: 'admin',
    description: 'Disallow a number',
    usage: '.disallow <number>',
    ownerOnly: true,
    async execute(sock, msg, args, extra) {
      const target = resolveTarget(args, msg);
      if (!target) return extra.reply('Usage: .disallow <number>');
      const { number, jid } = target;
      const wl  = readWL();
      const idx = findUserIndex(wl.users, jid);
      if (idx === -1) {
        await react(sock, msg, '⚠️');
        return extra.reply(`⚠️ Not found: +${number}`);
      }
      wl.users.splice(idx, 1);
      writeWL(wl);
      try { require('../../utils/dashboardSync').triggerImmediateSync(); } catch { /* ignore */ }
      await react(sock, msg, '✅');
      return extra.reply(`🗑️ Removed +${number}`);
    },
  },
  {
    name: 'listusers',
    aliases: ['users', 'allowed'],
    category: 'admin',
    description: 'List allowed users',
    usage: '.listusers',
    ownerOnly: true,
    async execute(sock, msg, args, extra) {
      const wl = readWL();
      if (!wl.users.length) return extra.reply('📋 Allowed (0)');
      const lines = wl.users.map((u, i) => `${i + 1}. +${u.number}${u.enabled === false ? ' _(paused)_' : ''}`);
      return extra.reply([`📋 *Allowed (${wl.users.length})*`, ...lines].join('\n'));
    },
  },
];
