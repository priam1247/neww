/**
 * ZaFar Bot — .cookies  (owner only)
 *
 * The single most effective fix for YouTube's "Sign in to confirm you're not a
 * bot" wall on a hosting/VPS IP. Upload cookies once and .song/.ytv start
 * working without touching a file manager on the host.
 *
 *   .cookies                    → status (source, amount, age) + how to add
 *   .cookies set                → reply to / attach a cookies.txt file
 *   .cookies set <text|base64>  → paste the file contents (or base64 of them)
 *   .cookies test               → live probe: does YouTube accept us now?
 *   .cookies clear              → remove the stored cookies
 *
 * Accepted formats: Netscape cookies.txt, base64 of it, and the JSON export
 * produced by popular browser extensions (converted automatically).
 */

const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const YT = require('../../utils/youtubedl');
const config = require('../../config');

const fmtAge = (ms) => {
  if (!ms && ms !== 0) return 'unknown';
  const h = Math.floor(ms / 3600000);
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60000))} min`;
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} days`;
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
  if (!buffer || !buffer.length) throw new Error('could not download that file');
  return buffer.toString('utf8');
}

module.exports = {
  name: 'cookies',
  aliases: ['cookie', 'setcookies'],
  category: 'admin',
  description: 'Add / inspect the YouTube cookies used by .song and .ytv',
  usage: '.cookies | .cookies set | .cookies test | .cookies clear',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    const sub = String(args[0] || '').toLowerCase();
    const react = (emoji) => sock.sendMessage(extra.from, { react: { text: emoji, key: msg.key } }).catch(() => {});

    try {
      // ── Status ────────────────────────────────────────────────────────────
      if (!sub || sub === 'status') {
        const ci = YT.cookieInfo();
        let out = `╭─ 🍪 *YouTube Cookies*\n`;
        if (ci.source) {
          out += `│ Status: ✅ active\n`;
          out += `│ Source: ${ci.source}\n`;
          out += `│ Cookies: ${ci.count}\n`;
          out += `│ Path: ${ci.file || 'inline (config/env)'}\n`;
          if (ci.mtime) out += `│ Age: ${fmtAge(Date.now() - ci.mtime)}\n`;
        } else {
          out += `│ Status: ❌ none\n`;
          out += `│ Without cookies YouTube treats this server as a bot.\n`;
        }
        out += `├─ Commands\n`;
        out += `│ • \`.cookies set\` — reply to (or attach) a cookies.txt\n`;
        out += `│ • \`.cookies set <text|base64>\` — paste contents\n`;
        out += `│ • \`.cookies test\` — probe YouTube now\n`;
        out += `│ • \`.cookies clear\` — remove them\n`;
        out += `╰─ ${config.botName}`;
        return extra.reply(out);
      }

      // ── Set ───────────────────────────────────────────────────────────────
      if (sub === 'set' || sub === 'add') {
        const status = await extra.status('🍪 Reading cookies…');

        let raw = args.slice(1).join(' ').trim();
        if (!raw) raw = (await readAttachedCookies(sock, msg) || '').trim();

        if (!raw) {
          return status.update(
            `❌ No cookies found in this message.\n\n*How to do it:*\n` +
            `1. Log in to YouTube in a desktop browser.\n` +
            `2. Export cookies in *Netscape* format (extension: "Get cookies.txt LOCALLY").\n` +
            `3. Send the file here and reply to it with \`.cookies set\`,\n` +
            `   *or* paste the text: \`.cookies set # Netscape HTTP Cookie File…\``,
          );
        }

        const { file, count } = YT.setCookies(raw);
        await react('✅');
        return status.update(
          `✅ *Cookies stored* — ${count} cookies\n│ Path: ${file}\n│ They are used by .song and .ytv automatically.\n│ Test them: \`.cookies test\``,
        );
      }

      // ── Clear ─────────────────────────────────────────────────────────────
      if (sub === 'clear' || sub === 'remove' || sub === 'delete') {
        const removed = YT.clearCookies();
        await react(removed ? '🗑️' : '⚠️');
        return extra.reply(removed
          ? '🗑️ Cookies removed. YouTube will bot-check this server again.'
          : '⚠️ Nothing to remove — no cookies were stored.');
      }

      // ── Test ──────────────────────────────────────────────────────────────
      if (sub === 'test') {
        const status = await extra.status('🔎 Testing YouTube access…');
        const target = args[1] ? args.slice(1).join(' ') : 'BaW_jenozKc'; // yt-dlp's test video
        const url = YT.isYouTubeUrl(target) ? YT.normalizeYouTubeUrl(target) : `https://www.youtube.com/watch?v=${target}`;
        try {
          const info = await YT.getInfo(url, { timeout: 60000 });
          await react('✅');
          return status.update(
            `✅ *YouTube accepted this server*\n│ Title: ${info.title || '?'}\n│ Uploader: ${info.uploader || '?'}\n` +
            `│ Cookies: ${YT.cookieInfo().source ? 'in use' : 'none'}\n╰─ .song and .ytv should work now.`,
          );
        } catch (e) {
          const info = YT.classify(e);
          await react('❌');
          return status.update(`❌ Probe failed → *${info.code}*\n${YT.friendlyError(e)}`);
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
