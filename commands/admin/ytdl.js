const YT = require('../../utils/youtubedl');
const ffmpeg = require('../../utils/ffmpeg');
const settings = require('../../utils/mediaSettings');
const ytAuth = require('../../utils/ytAuth');
const ytInnertube = require('../../utils/ytInnertube');
const providers = require('../../utils/downloadProviders');
const config = require('../../config');

async function status() {
  const diag = await YT.diagnostics();
  const yt = diag.installed ? (diag.version || 'installed') : 'MISSING';
  const ck = diag.cookies ? `${diag.cookieCount || 0} (${diag.cookieSource || 'file'})` : 'none';
  const oauth = ytAuth.hasYtCreds() ? 'linked' : 'none';
  const lines = [
    '*yt-dlp*',
    `Binary: ${yt}`,
    `ffmpeg: ${diag.ffmpeg || 'MISSING'}`,
    `OAuth: ${oauth}`,
    `Cookies: ${ck}`,
    `Proxy: ${diag.proxy || 'none'}`,
  ];
  if (diag.invalidProxy) {
    lines.push(`Ignored bad proxy: ${diag.invalidProxy}`);
  }
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
          const current = YT.proxyUrl();
          const masked = current ? current.replace(/\/\/([^@/]+)@/, '//***@') : 'none';
          const invalid = YT.invalidProxyReason();
          return extra.reply(invalid ? `🌐 Proxy: none (ignored invalid ${invalid})` : `🌐 Proxy: ${masked}`);
        }
        if (['off', 'none', 'clear', 'delete'].includes(value.toLowerCase())) {
          settings.set('proxy', '');
          return extra.reply('🌐 Proxy cleared.');
        }
        const check = settings.validateProxyUrl(value);
        if (!check.ok) {
          return extra.reply(`❌ Invalid proxy (${check.reason}).\nExample: ${P}ytdl proxy http://user:pass@198.51.100.10:8080`);
        }
        settings.set('proxy', check.url);
        return extra.reply(`🌐 Proxy set: ${check.url.replace(/\/\/([^@/]+)@/, '//***@')}`);
      }

      if (sub === 'test') {
        const target = args.slice(1).join(' ').trim();
        if (!target) return extra.reply(`Usage: ${P}ytdl test <link or query>`);

        const isYt = YT.isYouTubeUrl(target);
        const url = isYt ? YT.normalizeYouTubeUrl(target) : `ytsearch1:${target}`;
        const s = await extra.status('🔎 Probing…');
        try {
          const info = await YT.getInfo(url, { timeout: 45000 });
          return s.update(`✅ yt-dlp OK — ${info.title || '?'}\nyt-dlp ${YT.version()} · ffmpeg ${ffmpeg.version() || 'missing'}`);
        } catch (e) {
          if (isYt) {
            try {
              const itInfo = await ytInnertube.getVideoInfo(url);
              if (itInfo?.title) {
                return s.update(`✅ Innertube OK — ${itInfo.title}\n(yt-dlp: ${YT.classify(e).code})`);
              }
            } catch { /* fall through */ }
            try {
              const hit = await providers.resolveMedia(url, { kind: 'audio', timeoutMs: 35000 });
              if (hit?.url) {
                return s.update(`✅ Remote (${hit.provider}) OK — ${hit.title || 'stream ready'}\n(yt-dlp: ${YT.classify(e).code})`);
              }
            } catch { /* fall through */ }
          }
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
