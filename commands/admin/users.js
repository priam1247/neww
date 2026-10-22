/**
 * ZaFar Bot — Access Control (Owner only)
 */

const { readWL, writeWL, cleanNumber, findUserIndex } = require('../../utils/accessControl');
const { canonicalIdentity } = require('../../utils/jid');
const config = require('../../config');

async function react(sock, msg, emoji) {
  try { await sock.sendMessage(msg.key.remoteJid, { react: { text: emoji, key: msg.key } }); }
  catch (_) {}
}

// Mentions in groups come as LIDs: store the phone number when known, LID as alias
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
    description: 'Allow a number to use the bot',
    usage: '.allow <number>',
    ownerOnly: true,
    async execute(sock, msg, args, extra) {
      const target = resolveTarget(args, msg);
      if (!target) return extra.reply('❓ Usage: .allow <number>');
      const { number, alt, jid } = target;
      const wl = readWL();
      if (findUserIndex(wl.users, jid) !== -1) {
        await react(sock, msg, '⚠️');
        return extra.reply(`╭─ ⚠️ *Already Allowed*\n│ +${number}\n╰─ ${config.botName}`);
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
      return extra.reply(`╭─ ✅ *User Added*\n│ +${number}\n╰─ ${config.botName}`);
    },
  },
  {
    name: 'disallow',
    aliases: ['disallowuser', 'removeuser'],
    category: 'admin',
    description: 'Remove a number from the allowed list',
    usage: '.disallow <number>',
    ownerOnly: true,
    async execute(sock, msg, args, extra) {
      const target = resolveTarget(args, msg);
      if (!target) return extra.reply('❓ Usage: .disallow <number>');
      const { number, jid } = target;
      const wl  = readWL();
      const idx = findUserIndex(wl.users, jid);
      if (idx === -1) {
        await react(sock, msg, '⚠️');
        return extra.reply(`╭─ ⚠️ *Not Found*\n│ +${number} is not in the list.\n╰─ ${config.botName}`);
      }
      wl.users.splice(idx, 1);
      writeWL(wl);
      try { require('../../utils/dashboardSync').triggerImmediateSync(); } catch { /* ignore */ }
      await react(sock, msg, '✅');
      return extra.reply(`╭─ ✅ *User Removed*\n│ +${number}\n╰─ ${config.botName}`);
    },
  },
  {
    name: 'listusers',
    aliases: ['users', 'allowed'],
    category: 'admin',
    description: 'List all allowed users',
    usage: '.listusers',
    ownerOnly: true,
    async execute(sock, msg, args, extra) {
      const wl = readWL();
      if (!wl.users.length) {
        return extra.reply(
          `╭─ 📋 *Allowed Users — 0*\n│ No one allowed yet.\n│ Use .allow <number>\n╰─ ${config.botName}`
        );
      }
      let text = `╭─ 📋 *Allowed Users — ${wl.users.length}*\n│\n`;
      wl.users.forEach((u, i) => {
        const d = new Date(u.addedAt).toLocaleDateString('en-GB');
        text += `│ *${i + 1}.* +${u.number}  _${d}_\n`;
      });
      text += `╰─ ${config.botName}`;
      return extra.reply(text);
    },
  },
];
