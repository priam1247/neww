const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const YT = require('../../utils/youtubedl');

const fmtAge = (ms) => {
  if (!ms && ms !== 0) return '—';
  const h = Math.floor(ms / 3600000);
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60000))}m`;
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
};

async function readAttachedCookies(sock, msg) {
  const doc = msg.message?.documentMessage
    || msg.message?.documentWithCaptionMessage?.message?.documentMessage
    || msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.documentMessage
    || msg.message?.imageMessage?.contextInfo?.quotedMessage?.documentMessage;

  if (!doc) return null;

  const target = msg.message?.documentMessage
    ? msg
    : { key: msg.key, message: { documentMessage: doc } };

  const buffer = await downloadMediaMessage(target, 'buffer', {}, {
    logger: undefined,
    reuploadRequest: sock.updateMediaMessage,
  });
  if (!buffer || !buffer.length) throw new Error('could not download file');
  return buffer.toString('utf8');
}

module.exports = {
  name: 'cookies',
  aliases: ['cookie', 'setcookies'],
  category: 'admin',
  description: 'Manage YouTube cookies',
  usage: '.cookies | .cookies set | .cookies test | .cookies clear',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    const sub = String(args[0] || '').toLowerCase();
    const react = (emoji) => sock.sendMessage(extra.from, { react: { text: emoji, key: msg.key } }).catch(() => {});

    try {
      if (!sub || sub === 'status') {
        const ci = YT.cookieInfo();
        if (!ci.source) return extra.reply('🍪 Cookies: none');
        const age = ci.mtime ? ` · ${fmtAge(Date.now() - ci.mtime)}` : '';
        return extra.reply(`🍪 Cookies: ✅ ${ci.count} (${ci.source}${age})`);
      }

      if (sub === 'set' || sub === 'add') {
        const status = await extra.status('🍪 Saving…');
        let raw = args.slice(1).join(' ').trim();
        if (!raw) raw = (await readAttachedCookies(sock, msg) || '').trim();

        if (!raw) {
          return status.update('Usage: attach/reply to `cookies.txt` with `.cookies set` or `.cookies set <text|base64>`');
        }

        const { count } = YT.setCookies(raw);
        await react('✅');
        return status.update(`✅ Stored ${count} cookies.`);
      }

      if (sub === 'clear' || sub === 'remove' || sub === 'delete') {
        const removed = YT.clearCookies();
        await react(removed ? '🗑️' : '⚠️');
        return extra.reply(removed ? '🗑️ Cookies cleared.' : '⚠️ No cookies stored.');
      }

      if (sub === 'test') {
        const status = await extra.status('🔎 Testing…');
        const target = args[1] ? args.slice(1).join(' ') : 'BaW_jenozKc';
        const url = YT.isYouTubeUrl(target) ? YT.normalizeYouTubeUrl(target) : `https://www.youtube.com/watch?v=${target}`;
        try {
          const info = await YT.getInfo(url, { timeout: 60000 });
          await react('✅');
          return status.update(`✅ OK — ${info.title || url}`);
        } catch (e) {
          const info = YT.classify(e);
          await react('❌');
          return status.update(`❌ ${info.code}: ${YT.friendlyError(e, { isOwner: true })}`);
        }
      }

      return extra.reply('Usage: .cookies | .cookies set | .cookies test | .cookies clear');
    } catch (e) {
      console.error('[cookies] error:', e.message);
      await react('❌');
      return extra.reply(`❌ ${e.message}`);
    }
  },
};
