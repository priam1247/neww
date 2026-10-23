const YT = require('../../utils/youtubedl');
const ffmpeg = require('../../utils/ffmpeg');
const settings = require('../../utils/mediaSettings');
const config = require('../../config');

async function status() {
  const diag = await YT.diagnostics();
  const yt = diag.installed ? (diag.version || 'installed') : 'MISSING';
  const ck = diag.cookies ? `${diag.cookieCount || 0} (${diag.cookieSource || 'file'})` : 'none';
  const lines = [
    '*yt-dlp*',
    `Binary: ${yt}`,
    `ffmpeg: ${diag.ffmpeg || 'MISSING'}`,
    `Cookies: ${ck}`,
    `Proxy: ${diag.proxy || 'none'}`,
  ];
  if (diag.lastError) {
    lines.push(`Last error: ${diag.lastError.code}`);
  }
  return lines.join('\n');
}

module.exports = {
  name: 'ytdl',
  aliases: ['ytfix', 'ytdlp', 'ytdiag'],
  category: 'admin',
  description: 'yt-dlp status & tools',
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
        const s = await extra.status('⏳ Updating…');
        const v = await YT.update();
        return s.update(v ? `✅ yt-dlp ${v}` : '❌ Update failed.');
      }

      if (sub === 'repair') {
        const s = await extra.status('⏳ Checking yt-dlp…');
        const cmd = await YT.ensureInstalled();
        return s.update(cmd ? `✅ yt-dlp ${YT.version()}` : '❌ Repair failed.');
      }

      if (sub === 'proxy') {
        const value = args.slice(1).join(' ').trim();
        if (!value) {
          const current = settings.get('proxy', '') || config.ytdlp?.proxy || process.env.YTDLP_PROXY || '';
          const masked = current ? current.replace(/\/\/([^@/]+)@/, '//***@') : 'none';
          return extra.reply(`🌐 Proxy: ${masked}`);
        }
        if (['off', 'none', 'clear', 'delete'].includes(value.toLowerCase())) {
          settings.set('proxy', '');
          return extra.reply('🌐 Proxy cleared.');
        }
        if (!/^(https?|socks[45]?):\/\//i.test(value)) {
          return extra.reply(`Usage: ${P}ytdl proxy http://user:pass@host:port`);
        }
        settings.set('proxy', value);
        return extra.reply(`🌐 Proxy set: ${value.replace(/\/\/([^@/]+)@/, '//***@')}`);
      }

      if (sub === 'test') {
        const target = args.slice(1).join(' ').trim();
        if (!target) return extra.reply(`Usage: ${P}ytdl test <link or query>`);

        const url = YT.isYouTubeUrl(target) ? YT.normalizeYouTubeUrl(target) : `ytsearch1:${target}`;
        const s = await extra.status('🔎 Probing…');
        try {
          const info = await YT.getInfo(url, { timeout: 60000 });
          return s.update(`✅ OK — ${info.title || '?'}\nyt-dlp ${YT.version()} · ffmpeg ${ffmpeg.version() || 'missing'}`);
        } catch (e) {
          const info = YT.classify(e);
          return s.update(`❌ ${info.code}: ${YT.friendlyError(e, { isOwner: true })}`);
        }
      }

      return extra.reply(`Usage: ${P}ytdl [update|repair|proxy|test]`);
    } catch (e) {
      console.error('[ytdl] error:', e.message);
      return extra.reply('❌ Diagnostic failed.');
    }
  },
};
