// src/commands/admin.js — merged from Zafar-bot-main: owner administration.
//   .allow / .disallow / .listusers   whitelist management
//   .on / .off                        bot kill-switch (persisted)
//   .broadcast <msg>                  send to every participating group
//   .restart                          exit; the supervisor restarts
//   .cookies  set|test|clear          YouTube cookies (fixes bot-checks)
//   .ytdl     status|update|repair|proxy|engine|fallback|test
import config from '../config.js';
import YT from '../providers/local/ytdlp.js';
import * as remote from '../providers/local/remote.js';
import * as access from '../bot/access.js';
import ffmpeg from '../utils/ffmpeg.js';
import { store } from '../core/store.js';
import { metrics } from '../core/metrics.js';

const BOOT = Date.now();
const uptime = (ms) => {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
};

const guard = (ctx) => {
  if (ctx.isOwner) return null;
  return ctx.say('👑 This command is only for the bot owner.');
};

const react = (ctx, emoji) => ctx.react ? ctx.react(emoji).catch(() => {}) : Promise.resolve();

const cleanNumber = (raw) => {
  if (!raw) return null;
  const n = String(raw).replace(/@.*/, '').replace(/[^0-9]/g, '').trim();
  return n.length >= 7 ? n : null;
};

// ── allow / disallow / listusers ─────────────────────────────────────────────
export async function allow(ctx, args) {
  if (await guard(ctx)) return;
  const target = resolveTarget(args, ctx.msg);
  if (!target) return ctx.say('❓ Usage: .allow <number>');
  const added = access.whitelistAdd(target);
  await react(ctx, added ? '✅' : '⚠️');
  return ctx.say(added
    ? `╭─ ✅ *User Added*\n│ +${target}\n╰─ ${config.botName}`
    : `╭─ ⚠️ *Already Allowed*\n│ +${target}\n╰─ ${config.botName}`);
}

export async function disallow(ctx, args) {
  if (await guard(ctx)) return;
  const target = resolveTarget(args, ctx.msg);
  if (!target) return ctx.say('❓ Usage: .disallow <number>');
  const removed = access.whitelistRemove(target);
  await react(ctx, removed ? '✅' : '⚠️');
  return ctx.say(removed
    ? `╭─ ✅ *User Removed*\n│ +${target}\n╰─ ${config.botName}`
    : `╭─ ⚠️ *Not Found*\n│ +${target} is not in the list.\n╰─ ${config.botName}`);
}

export async function listusers(ctx) {
  if (await guard(ctx)) return;
  const wl = access.readWhitelist();
  if (!wl.users.length) {
    return ctx.say(`╭─ 📋 *Allowed Users — 0*\n│ No one allowed yet.\n│ Use .allow <number>\n╰─ ${config.botName}`);
  }
  let text = `╭─ 📋 *Allowed Users — ${wl.users.length}*\n│\n`;
  wl.users.forEach((u, i) => {
    const d = new Date(u.addedAt).toLocaleDateString('en-GB');
    text += `│ *${i + 1}.* +${u.number}  _${d}_\n`;
  });
  return ctx.say(`${text}╰─ ${config.botName}`);
}

function resolveTarget(args, msg) {
  const mentioned = msg?.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  let n = mentioned?.length ? cleanNumber(mentioned[0]) : cleanNumber(args[0]);
  return n || null;
}

// ── on / off / mode ──────────────────────────────────────────────────────────
export async function on(ctx) {
  if (await guard(ctx)) return;
  access.setBotOn(true);
  await react(ctx, '✅');
  return ctx.say(`✅ *${config.botName} is ON*\nAll commands are active.`);
}

export async function off(ctx) {
  if (await guard(ctx)) return;
  access.setBotOn(false);
  await react(ctx, '🔴');
  return ctx.say(`🔴 *${config.botName} is OFF*\nUse .on to bring it back.`);
}

export async function mode(ctx, args) {
  if (await guard(ctx)) return;
  const v = String(args[0] || '').toLowerCase();
  if (!['open', 'whitelist'].includes(v)) {
    return ctx.say(`Current mode: *${config.accessMode}*\nUsage: .mode open|whitelist\n_Whitelist mode answers only to allowed users (owner always). Set ACCESS_MODE in .env to persist._`);
  }
  store.set('state', 'accessMode', v);
  await react(ctx, '✅');
  return ctx.say(`✅ Access mode: *${v}*\n_Restarts keep .env as the source of truth — update ACCESS_MODE there to persist._`);
}

// ── broadcast / restart / botinfo ────────────────────────────────────────────
export async function broadcast(ctx, args) {
  if (await guard(ctx)) return;
  if (args.length < 1) return ctx.say('❓ Usage: .broadcast <message>');
  const message = args.join(' ');
  await react(ctx, '📢');
  let chats = {};
  try { chats = await ctx.transport?.groupFetchAllParticating?.() || await ctx.transport?.groupFetchAllParticipating?.() || {}; } catch { /* empty */ }
  const ids = Object.keys(chats);
  let sent = 0, failed = 0;
  const text = `╭─ 📢 *${config.botName}*\n│\n│ ${message}\n╰─ ${config.botName}`;
  for (const jid of ids) {
    try { await ctx.say2(jid, text); sent++; await new Promise(r => setTimeout(r, 500)); }
    catch { failed++; }
  }
  await react(ctx, '✅');
  return ctx.say(`╭─ 📢 *Broadcast Done*\n│ ✅ Sent: ${sent}\n│ ❌ Failed: ${failed}\n╰─ ${config.botName}`);
}

export async function restart(ctx) {
  if (await guard(ctx)) return;
  await react(ctx, '🔄');
  await ctx.say(`╭─ 🔄 *Restarting...*\n│ Back in a few seconds.\n╰─ ${config.botName}`);
  setTimeout(() => process.exit(0), 2000);
}

export async function botinfo(ctx) {
  const mem = process.memoryUsage();
  const now = new Date().toLocaleString('en-GB', { timeZone: config.timezone });
  const s = metrics.snapshot();
  const t =
    `╭─ *${config.botName} — Stats*\n` +
    `│ ⏱️ Uptime: ${uptime(Date.now() - BOOT)}\n` +
    `│ 💾 RAM: ${(mem.rss / 1024 / 1024).toFixed(1)} MB\n` +
    `│ 🕒 ${now}\n` +
    `│ 🖥️ Node: ${process.version}\n` +
    `│ ⚙️ Prefix: \`${config.prefix}\`\n` +
    `│ 🔑 Access: ${config.accessMode}\n` +
    `│ 📦 Commands run: ${s.counters['command.run'] || 0}\n` +
    `╰─ *${config.botName}*`;
  return ctx.say(t);
}

// ── .cookies (YouTube cookies for the yt-dlp engine) ─────────────────────────
export async function cookies(ctx, args) {
  if (await guard(ctx)) return;
  const sub = String(args[0] || '').toLowerCase();
  try {
    if (!sub || sub === 'status') {
      const ci = YT.cookieInfo();
      let out = `╭─ 🍪 *YouTube Cookies*\n`;
      if (ci.source) {
        out += `│ Status: ✅ active\n│ Source: ${ci.source}\n│ Cookies: ${ci.count}\n│ Path: ${ci.file || 'inline (config/env)'}\n`;
        if (ci.mtime) out += `│ Age: ${fmtAge(Date.now() - ci.mtime)}\n`;
      } else {
        out += `│ Status: ❌ none\n│ Without cookies YouTube treats this server as a bot.\n`;
      }
      out += `├─ Commands\n│ • \`.cookies set <text|base64>\` — paste a cookies.txt\n│ • \`.cookies test\` — probe YouTube now\n│ • \`.cookies clear\` — remove them\n╰─ ${config.botName}`;
      return ctx.say(out);
    }
    if (sub === 'set' || sub === 'add') {
      const raw = args.slice(1).join(' ').trim();
      if (!raw) return ctx.say('❌ No cookies found in this message.\n\n*How to do it:*\n1. Log in to YouTube in a desktop browser.\n2. Export cookies in *Netscape* format ("Get cookies.txt LOCALLY" extension).\n3. Paste: `.cookies set # Netscape HTTP Cookie File…` (or base64 of it).');
      const { file, count } = YT.setCookies(raw);
      await react(ctx, '✅');
      return ctx.say(`✅ *Cookies stored* — ${count} cookies\n│ Path: ${file}\n│ Used by .song/.ytv automatically.\n│ Test them: \`.cookies test\``);
    }
    if (sub === 'clear' || sub === 'remove' || sub === 'delete') {
      const removed = YT.clearCookies();
      await react(ctx, removed ? '🗑️' : '⚠️');
      return ctx.say(removed ? '🗑️ Cookies removed. YouTube will bot-check this server again.' : '⚠️ Nothing to remove — no cookies were stored.');
    }
    if (sub === 'test') {
      const status = ctx.status ? ctx.status('🔎 Testing YouTube access…') : null;
      const target = args[1] ? args.slice(1).join(' ') : 'BaW_jenozKc';
      const url = YT.isYouTubeUrl(target) ? YT.normalizeYouTubeUrl(target) : `https://www.youtube.com/watch?v=${target}`;
      try {
        const info = await YT.getInfo(url, { timeout: 60_000 });
        const text = `✅ *YouTube accepted this server*\n│ Title: ${info.title || '?'}\n│ Uploader: ${info.uploader || '?'}\n│ Cookies: ${YT.cookieInfo().source ? 'in use' : 'none'}\n╰─ .song and .ytv should work now.`;
        return status ? status.update(text) : ctx.say(text);
      } catch (e) {
        const text = `❌ Probe failed → *${YT.classify(e).code}*\n${YT.friendlyError(e)}`;
        return status ? status.update(text) : ctx.say(text);
      }
    }
    return ctx.say('Usage: .cookies | .cookies set <text> | .cookies test | .cookies clear');
  } catch (e) {
    return ctx.say(`❌ ${e.message}`);
  }
}

// ── .ytdl (engine diagnostics + repair) ──────────────────────────────────────
export async function ytdl(ctx, args) {
  if (await guard(ctx)) return;
  const sub = String(args[0] || '').toLowerCase();
  try {
    if (!sub || sub === 'status') {
      const diag = await YT.diagnostics();
      const yt = diag.installed ? `${diag.version || 'unknown'}\n│   binary: ${diag.source}` : `NOT INSTALLED${diag.installError ? ` (${diag.installError})` : ''}`;
      let out = `╭─ *YouTube engine (yt-dlp)*\n│ yt-dlp: ${yt}\n│ ffmpeg: ${diag.ffmpeg || 'NOT RUNNABLE'}\n│ cookies: ${diag.cookieSource || 'none'}${diag.cookieCount ? ` (${diag.cookieCount})` : ''}\n│ proxy: ${diag.proxy || 'none'}\n│ backup sources: ${store.get('settings', 'remoteFallback', true) ? 'on' : 'off'}\n│ impersonation: ${diag.capabilities?.impersonate ? 'available' : 'not available'}\n`;
      if (diag.lastError) {
        const when = new Date(diag.lastError.at).toLocaleString('en-GB', { timeZone: config.timezone });
        out += `│ last failure: ${diag.lastError.code} @ ${when}\n`;
      }
      out += `├─ Fixes\n│ • \`.cookies set\` — bot-check cure\n│ • \`.ytdl update\` — outdated build cure\n│ • \`.ytdl proxy <url>\` — real country/IP blocks\n│ • \`.ytdl repair\` — install yt-dlp\n╰─ ${config.botName}`;
      return ctx.say(out);
    }
    if (sub === 'update') {
      const status = ctx.status ? ctx.status('⏳ Updating yt-dlp…') : null;
      const v = await YT.update();
      const text = v ? `✅ yt-dlp updated — now ${v}\nTry .song / .ytv again.` : '❌ Could not update yt-dlp. Try `.ytdl repair` or install manually: `pip install -U yt-dlp`';
      return status ? status.update(text) : ctx.say(text);
    }
    if (sub === 'repair') {
      const status = ctx.status ? ctx.status('⏳ Looking for a usable yt-dlp…') : null;
      const cmd = await YT.ensureInstalled();
      const text = cmd ? `✅ yt-dlp ready: ${YT.version()}\n${cmd.join(' ')}` : `❌ Installation failed: ${YT.installError() || 'unknown error'}\nInstall manually: \`pip install -U yt-dlp\``;
      return status ? status.update(text) : ctx.say(text);
    }
    if (sub === 'proxy') {
      const value = args.slice(1).join(' ').trim();
      if (!value) {
        const current = store.get('settings', 'proxy', '') || config.ytdlpProxy || '';
        return ctx.say(`╭─ 🌐 *yt-dlp proxy*\n│ Current: ${current || 'none'}\n├─ Set: \`.ytdl proxy http://user:pass@host:port\`\n│ Clear: \`.ytdl proxy off\`\n╰─ ${config.botName}`);
      }
      if (['off', 'none', 'clear', 'delete'].includes(value.toLowerCase())) {
        store.set('settings', 'proxy', '');
        return ctx.say('🌐 Proxy cleared — yt-dlp will use the direct connection again.');
      }
      if (!/^(https?|socks[45]?):\/\//i.test(value)) {
        return ctx.say('❌ That is not a proxy URL. Example:\n`.ytdl proxy http://user:pass@1.2.3.4:8080`');
      }
      store.set('settings', 'proxy', value);
      return ctx.say(`🌐 Proxy saved: ${value.replace(/\/\/([^@/]+)@/, '//***@')}\nTry .song / .ytv again.`);
    }
    if (sub === 'engine' || sub === 'engines') {
      const list = remote.listProviders();
      let out = `╭─ 🔧 *Download engines*\n│ yt-dlp (local): ${YT.resolveCommand() ? `✅ ${YT.version()}` : '❌ not installed'}\n`;
      for (const p of list) out += `│ ${p.name}: ${p.enabled ? '✅ available' : '⚠️ not configured'} (${p.kinds.join(', ')})\n`;
      out += `│ ffmpeg: ${ffmpeg.version() ? `✅ ${ffmpeg.version()}` : '❌ not runnable'}\n│ backup sources: ${store.get('settings', 'remoteFallback', true) ? 'enabled' : 'disabled'}\n╰─ ${config.botName}`;
      return ctx.say(out);
    }
    if (sub === 'fallback') {
      const value = String(args[1] || '').toLowerCase();
      if (!['on', 'off'].includes(value)) return ctx.say('Usage: `.ytdl fallback on|off`');
      store.set('settings', 'remoteFallback', value === 'on');
      return ctx.say(`✅ Backup download sources ${value === 'on' ? 'enabled' : 'disabled'}.`);
    }
    if (sub === 'test' || sub === 'raw') {
      const target = args.slice(1).join(' ').trim();
      if (!target) return ctx.say(`Usage: .ytdl ${sub} <YouTube link or search words>`);
      const url = YT.isYouTubeUrl(target) ? YT.normalizeYouTubeUrl(target) : `ytsearch1:${target}`;
      const status = ctx.status ? ctx.status('🔎 Probing YouTube…') : null;
      try {
        const info = await YT.getInfo(url, { timeout: 60_000 });
        const text = `✅ YouTube reachable\n│ Title: ${info.title || '?'}\n│ Duration: ${info.duration || '?'}s\n│ Uploader: ${info.uploader || '?'}\n│ yt-dlp: ${YT.version()}\n╰─ Download should work now.`;
        return status ? status.update(text) : ctx.say(text);
      } catch (e) {
        const text = `❌ Probe failed → *${YT.classify(e).code}*\n${YT.friendlyError(e)}`;
        return status ? status.update(text) : ctx.say(text);
      }
    }
    return ctx.say('Usage: .ytdl | .ytdl update | .ytdl repair | .ytdl proxy <url|off> | .ytdl engine | .ytdl fallback on|off | .ytdl test <link>');
  } catch (e) {
    return ctx.say(`❌ ${e.message}`);
  }
}

const fmtAge = (ms) => {
  if (!ms && ms !== 0) return 'unknown';
  const h = Math.floor(ms / 3600_000);
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60_000))} min`;
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} days`;
};
