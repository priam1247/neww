/**
 * ZaFar Bot — .ytdl  (owner only)
 *
 * Diagnostics + repair for the YouTube engine used by .song and .ytv.
 *
 *   .ytdl                 → status report (yt-dlp, ffmpeg, cookies, proxy, last error)
 *   .ytdl update          → update yt-dlp (fixes "sign in to confirm you're not a bot")
 *   .ytdl repair          → install yt-dlp if it is missing (standalone binary → pip)
 *   .ytdl test <link>     → real metadata probe with the raw verdict
 *   .ytdl raw <link>      → verbose probe, shows the last real yt-dlp output
 *   .ytdl proxy <url|off> → route yt-dlp through a proxy (fixes IP-level blocks)
 *   .ytdl engine          → which download engines are available
 *   .ytdl fallback on|off → enable/disable the remote backup sources
 */

const YT = require('../../utils/youtubedl');
const ffmpeg = require('../../utils/ffmpeg');
const providers = require('../../utils/downloadProviders');
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
  out += `${line('impersonation', diag.capabilities?.impersonate ? 'available' : 'not available')}\n`;
  out += `${line('auto-update', config.ytdlp?.updateOnBotCheck !== false ? 'on' : 'off')}\n`;
  if (diag.lastError) {
    const when = new Date(diag.lastError.at).toLocaleString('en-GB', { timeZone: config.timezone });
    out += `${line('last failure', `${diag.lastError.code} @ ${when}`)}\n`;
    if (diag.lastError.detail) out += `${line('   detail', String(diag.lastError.detail).slice(0, 160))}\n`;
    if (diag.lastError.attempts?.length) {
      out += `${line('   engines', diag.lastError.attempts.slice(0, 5).map(a => `${a.engine}=${a.code}`).join(', '))}\n`;
    }
  }
  out += `├─ Fixes\n`;
  out += `│ • \`.cookies set\` — bot-check cure (YouTube cookies)\n`;
  out += `│ • \`.ytdl update\` — bot-check cure for an outdated build\n`;
  out += `│ • \`.ytdl proxy <url>\` — real country/IP blocks\n`;
  out += `│ • \`.ytdl repair\` — install yt-dlp if it is missing\n`;
  out += `╰─ ${config.botName}`;
  return out;
}

module.exports = {
  name: 'ytdl',
  aliases: ['ytfix', 'ytdlp', 'ytdiag'],
  category: 'admin',
  description: 'Diagnose and repair the YouTube downloader (.song/.ytv)',
  usage: '.ytdl | .cookies set | .ytdl update | .ytdl proxy <url|off> | .ytdl test <link>',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    const sub = String(args[0] || '').toLowerCase();

    try {
      if (!sub || sub === 'status') {
        return extra.reply(await status());
      }

      if (sub === 'update') {
        const status = await extra.status('⏳ Updating yt-dlp…');
        const v = await YT.update();
        return status.update(v
          ? `✅ yt-dlp updated — now ${v}\nTry .song / .ytv again.`
          : '❌ Could not update yt-dlp on this host. Try `.ytdl repair` or install it manually:\n`pip install -U yt-dlp`');
      }

      if (sub === 'repair') {
        const status = await extra.status('⏳ Looking for a usable yt-dlp…');
        const cmd = await YT.ensureInstalled();
        return status.update(cmd
          ? `✅ yt-dlp ready: ${YT.version()}\n${cmd.join(' ')}`
          : `❌ Installation failed: ${YT.installError() || 'unknown error'}\nInstall it manually and restart:\n\`pip install -U yt-dlp\``);
      }

      // ── Proxy (the fix for real IP/country blocks) ────────────────────────
      if (sub === 'proxy') {
        const value = args.slice(1).join(' ').trim();
        if (!value) {
          const current = settings.get('proxy', '') || config.ytdlp?.proxy || process.env.YTDLP_PROXY || '';
          return extra.reply(`╭─ 🌐 *yt-dlp proxy*\n│ Current: ${current || 'none'}\n├─ Set: \`.ytdl proxy http://user:pass@host:port\`\n│ Clear: \`.ytdl proxy off\`\n╰─ ${config.botName}`);
        }
        if (['off', 'none', 'clear', 'delete'].includes(value.toLowerCase())) {
          settings.set('proxy', '');
          return extra.reply('🌐 Proxy cleared — yt-dlp will use the direct connection again.');
        }
        if (!/^(https?|socks[45]?):\/\//i.test(value)) {
          return extra.reply('❌ That is not a proxy URL. Example:\n`.ytdl proxy http://user:pass@1.2.3.4:8080`');
        }
        settings.set('proxy', value);
        return extra.reply(`🌐 Proxy saved: ${value.replace(/\/\/([^@/]+)@/, '//***@')}\nTry .song / .ytv again.`);
      }

      // ── Engines ───────────────────────────────────────────────────────────
      if (sub === 'engine' || sub === 'engines') {
        const list = providers.listProviders();
        let out = `╭─ 🔧 *Download engines*\n`;
        out += `│ yt-dlp (local): ${YT.resolveCommand() ? `✅ ${YT.version()}` : '❌ not installed'}\n`;
        for (const p of list) {
          out += `│ ${p.name}: ${p.enabled ? '✅ available' : '⚠️ not configured'} (${p.kinds.join(', ')})\n`;
        }
        out += `│ ffmpeg: ${ffmpeg.version() ? `✅ ${ffmpeg.version()}` : '❌ not runnable'}\n`;
        out += `│ backup sources: ${settings.get('remoteFallback', true) !== false ? 'enabled' : 'disabled'}\n`;
        out += `╰─ ${config.botName}`;
        return extra.reply(out);
      }

      if (sub === 'fallback') {
        const value = String(args[1] || '').toLowerCase();
        if (!['on', 'off'].includes(value)) return extra.reply('Usage: `.ytdl fallback on|off`');
        settings.set('remoteFallback', value === 'on');
        return extra.reply(`✅ Backup download sources ${value === 'on' ? 'enabled' : 'disabled'}.`);
      }

      // ── Explain a recent or supplied yt-dlp error without external services ──
      if (sub === 'triage' || sub === 'why') {
        const pasted = args.slice(1).join(' ').trim();
        const diag = pasted ? null : await YT.diagnostics();
        const detail = pasted || diag?.lastError?.detail || diag?.lastError?.code || '';
        if (!detail) return extra.reply('⬜ Nothing to explain yet — try `.ytdl raw <link>` first.');
        const verdict = YT.classify({ message: detail, stderr: detail });
        return extra.reply(`🔎 Error: *${verdict.code}*\n${YT.friendlyError({ ...verdict, message: detail, stderr: detail }, { isOwner: true })}`);
      }

      // ── Probes ────────────────────────────────────────────────────────────
      if (sub === 'test' || sub === 'raw') {
        const target = args.slice(1).join(' ').trim();
        if (!target) return extra.reply(`Usage: .ytdl ${sub} <YouTube link or search words>`);

        const url = YT.isYouTubeUrl(target) ? YT.normalizeYouTubeUrl(target) : `ytsearch1:${target}`;

        if (sub === 'raw') {
          const status = await extra.status('🔎 Running a verbose probe…');
          const res = await YT.probeRaw(url, { timeout: 60000 });
          const tail = String(res.stderr || '').trim().split('\n').filter(Boolean).slice(-6).join('\n');
          return status.update(
            `${res.ok ? '✅ Probe OK' : `❌ Probe failed → *${res.code}*`}\n` +
            `├─ yt-dlp: ${YT.version()} | ffmpeg: ${ffmpeg.version() || 'none'}\n` +
            `│ cookies: ${YT.cookieInfo().source || 'none'} | proxy: ${settings.get('proxy', '') || config.ytdlp?.proxy || 'none'}\n` +
            `╰─ last output:\n${tail.slice(0, 900) || '(nothing)'}`,
          );
        }

        const status = await extra.status('🔎 Probing YouTube…');
        try {
          const info = await YT.getInfo(url, { timeout: 60000 });
          return status.update(
            `✅ YouTube reachable\n│ Title: ${info.title || '?'}\n│ Duration: ${info.duration || '?'}s\n│ Uploader: ${info.uploader || '?'}\n│ ID: ${info.id || '?'}\n├─ yt-dlp: ${YT.version()}\n│ ffmpeg: ${ffmpeg.version() || 'NOT RUNNABLE'}\n│ cookies: ${YT.cookieInfo().source || 'none'}\n╰─ Download should work now.`,
          );
        } catch (e) {
          const info = YT.classify(e);
          return status.update(`❌ Probe failed → *${info.code}*\n${YT.friendlyError(e, { isOwner: true })}`);
        }
      }

      return extra.reply('Usage: .ytdl | .ytdl update | .ytdl repair | .ytdl proxy <url|off> | .ytdl engine | .ytdl test <link> | .ytdl raw <link> | .ytdl triage <error>');
    } catch (e) {
      console.error('[ytdl] error:', e.message);
      return extra.reply(`❌ ${e.message}`);
    }
  },
};
