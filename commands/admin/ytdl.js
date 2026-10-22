/**
 * ZaFar Bot — .ytdl  (owner only)
 *
 * Focused diagnostics & repair for the YouTube engine used by .song and .ytv:
 *
 *   .ytdl                 → status report (yt-dlp, ffmpeg, cookies, proxy, last error)
 *   .ytdl update          → update yt-dlp
 *   .ytdl repair          → install yt-dlp if missing
 *   .ytdl proxy <url|off> → route yt-dlp through a proxy (or clear it)
 *   .ytdl test <link>     → live metadata probe against YouTube
 */

const YT = require('../../utils/youtubedl');
const ffmpeg = require('../../utils/ffmpeg');
const settings = require('../../utils/mediaSettings');
const config = require('../../config');

const line = (label, value) => `│ ${label}: ${value}`;

const fmtAge = (ms) => {
  if (!ms) return 'unknown';
  const h = Math.floor(ms / 3600000);
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60000))} min`;
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} days`;
};

function cookieHint(diag) {
  if (!diag.cookies) return 'none — YouTube bot-checks are likely (`.cookies set`)';
  const who = diag.cookieSource || 'file';
  return `${who}, ${diag.cookieCount || 0} cookies${diag.cookieAgeMs ? ` (${fmtAge(diag.cookieAgeMs)} old)` : ''}`;
}

async function status() {
  const diag = await YT.diagnostics();
  const P = config.prefix || '.';
  const yt = diag.installed
    ? `${diag.version || 'unknown'}\n${line('   binary', diag.source)}`
    : `NOT INSTALLED${diag.installError ? ` (${diag.installError})` : ''}`;

  let out = `╭─ *YouTube engine (yt-dlp)*\n`;
  out += `${line('yt-dlp', yt)}\n`;
  out += `${line('ffmpeg', diag.ffmpeg || 'NOT RUNNABLE')}\n`;
  out += `${line('cookies', cookieHint(diag))}\n`;
  out += `${line('proxy', diag.proxy || 'none')}\n`;
  out += `${line('backup sources', settings.get('remoteFallback', true) !== false ? 'on' : 'off')}\n`;
  out += `${line('IPv4 forced', diag.capabilities?.ipv4 ? 'yes' : 'n/a')}\n`;
  out += `${line('auto-update', config.ytdlp?.updateOnBotCheck !== false ? 'on' : 'off')}\n`;
  if (diag.lastError) {
    const when = new Date(diag.lastError.at).toLocaleString('en-GB', { timeZone: config.timezone });
    out += `${line('last failure', `${diag.lastError.code} @ ${when}`)}\n`;
  }
  out += `├─ Fixes\n`;
  out += `│ • \`${P}cookies set\` — bot-check cure (YouTube cookies)\n`;
  out += `│ • \`${P}ytdl update\` — update yt-dlp binary\n`;
  out += `│ • \`${P}ytdl proxy <url|off>\` — route via proxy\n`;
  out += `│ • \`${P}ytdl repair\` — install yt-dlp if missing\n`;
  out += `╰─ ${config.botName}`;
  return out;
}

module.exports = {
  name: 'ytdl',
  aliases: ['ytfix', 'ytdlp', 'ytdiag'],
  category: 'admin',
  description: 'Diagnose and repair the YouTube downloader (.song/.ytv)',
  usage: '.ytdl | .ytdl update | .ytdl repair | .ytdl proxy <url|off> | .ytdl test <link>',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    const sub = String(args[0] || '').toLowerCase();
    const P = config.prefix || '.';

    try {
      if (!sub || sub === 'status') {
        return extra.reply(await status());
      }

      if (sub === 'update') {
        const s = await extra.status('⏳ Updating yt-dlp…');
        const v = await YT.update();
        return s.update(v
          ? `✅ yt-dlp updated — now ${v}\nTry ${P}song / ${P}ytv again.`
          : `❌ Could not update yt-dlp on this host. Try \`${P}ytdl repair\` or \`pip install -U yt-dlp\`.`);
      }

      if (sub === 'repair') {
        const s = await extra.status('⏳ Looking for a usable yt-dlp…');
        const cmd = await YT.ensureInstalled();
        return s.update(cmd
          ? `✅ yt-dlp ready: ${YT.version()}\n${cmd.join(' ')}`
          : `❌ Installation failed. Install yt-dlp manually on the host (\`pip install -U yt-dlp\`) and restart.`);
      }

      if (sub === 'proxy') {
        const value = args.slice(1).join(' ').trim();
        if (!value) {
          const current = settings.get('proxy', '') || config.ytdlp?.proxy || process.env.YTDLP_PROXY || '';
          const masked = current ? current.replace(/\/\/([^@/]+)@/, '//***@') : 'none';
          return extra.reply(
            `╭─ 🌐 *yt-dlp proxy*\n` +
            `│ Current: ${masked}\n` +
            `├─ Set: \`${P}ytdl proxy http://user:pass@host:port\`\n` +
            `│ Clear: \`${P}ytdl proxy off\`\n` +
            `╰─ ${config.botName}`,
          );
        }
        if (['off', 'none', 'clear', 'delete'].includes(value.toLowerCase())) {
          settings.set('proxy', '');
          return extra.reply('🌐 Proxy cleared — yt-dlp will use the direct connection again.');
        }
        if (!/^(https?|socks[45]?):\/\//i.test(value)) {
          return extra.reply(`❌ Invalid proxy URL. Example:\n\`${P}ytdl proxy http://user:pass@1.2.3.4:8080\``);
        }
        settings.set('proxy', value);
        return extra.reply(`🌐 Proxy saved: ${value.replace(/\/\/([^@/]+)@/, '//***@')}\nTry ${P}song / ${P}ytv again.`);
      }

      if (sub === 'test') {
        const target = args.slice(1).join(' ').trim();
        if (!target) return extra.reply(`Usage: ${P}ytdl test <YouTube link or search words>`);

        const url = YT.isYouTubeUrl(target) ? YT.normalizeYouTubeUrl(target) : `ytsearch1:${target}`;
        const s = await extra.status('🔎 Probing YouTube…');
        try {
          const info = await YT.getInfo(url, { timeout: 60000 });
          return s.update(
            `✅ YouTube reachable\n` +
            `│ Title: ${info.title || '?'}\n` +
            `│ Duration: ${info.duration || '?'}s\n` +
            `│ Uploader: ${info.uploader || '?'}\n` +
            `├─ yt-dlp: ${YT.version()}\n` +
            `│ ffmpeg: ${ffmpeg.version() || 'NOT RUNNABLE'}\n` +
            `│ cookies: ${YT.cookieInfo().source || 'none'}\n` +
            `╰─ Download should work now.`,
          );
        } catch (e) {
          const info = YT.classify(e);
          return s.update(`❌ Probe failed → *${info.code}*\n${YT.friendlyError(e, { isOwner: true })}`);
        }
      }

      return extra.reply(`Usage: ${P}ytdl | ${P}ytdl update | ${P}ytdl repair | ${P}ytdl proxy <url|off> | ${P}ytdl test <link>`);
    } catch (e) {
      console.error('[ytdl] error:', e.message);
      return extra.reply('❌ Could not run yt-dlp diagnostics right now. Check server logs.');
    }
  },
};
