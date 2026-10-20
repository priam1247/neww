// src/bot/handler.js — command router. Transport-agnostic: works for WhatsApp,
// CLI, anything that can say/edit/send files. Handles prefix parsing, access
// gates (on/off + whitelist), bare-number selection routing ("reply 2"),
// cooldowns, and error containment. Merged from Zafar-bot-main.
import config from '../config.js';
import { log } from '../core/log.js';
import { metrics } from '../core/metrics.js';
import * as access from './access.js';
import * as selections from './selections.js';
import * as pending from './pending.js';
import * as movie from '../commands/movie.js';
import * as series from '../commands/series.js';
import * as netflix from '../commands/netflix.js';
import * as providers from '../commands/providers.js';
import * as stats from '../commands/stats.js';
import * as extra from '../commands/extra.js';
import * as song from '../commands/song.js';
import * as ytv from '../commands/ytv.js';
import * as dl from '../commands/dl.js';
import * as spotify from '../commands/spotify.js';
import * as sticker from '../commands/sticker.js';
import * as viewonce from '../commands/viewonce.js';
import * as tgsticker from '../commands/tgsticker.js';
import * as paper from '../commands/paper.js';
import * as admin from '../commands/admin.js';

const hlog = log.child('handler');
const cooldowns = new Map();   // jid+cmd -> last ms

const ROUTES = {
  movie: { mod: movie, aliases: ['film', 'mv', 'pelicula'] },
  series: { mod: series, aliases: ['tv', 'show', 's'] },
  netflix: { mod: netflix, aliases: ['nf', 'flix'] },
  providers: { mod: providers, aliases: ['src', 'sources', 'health'] },
  stats: { mod: stats, aliases: ['metrics', 'm', 'update'] },
  help: { mod: { run: (ctx) => ctx.say(extra.help(ctx)) }, aliases: ['start', 'h', 'menu', 'commands'] },
  cache: { mod: { run: extra.cacheCmd }, aliases: [] },
  subs: { mod: { run: extra.subs }, aliases: ['subtitle', 'sub'] },
  // merged from Zafar-bot-main
  song: { mod: song, aliases: ['play', 'music', 'yta'] },
  ytv: { mod: ytv, aliases: ['ytvideo', 'ytmp4', 'video', 'playvid'] },
  dl: { mod: dl, aliases: ['download', 'save', 'getvid', 'fetch'] },
  spotify: { mod: spotify, aliases: ['sp', 'spot', 'spotdl'] },
  sticker: { mod: sticker, aliases: ['s', 'stiker', 'stc'] },
  viewonce: { mod: viewonce, aliases: ['readvo', 'read', 'vv', 'readviewonce'] },
  tgsticker: { mod: tgsticker, aliases: ['tgs'] },
  tgpack: { mod: { run: tgsticker.runTgPack }, aliases: ['tgstickers'] },
  paper: { mod: paper, aliases: ['papers', 'pastpaper', 'pp'] },
  countpapers: { mod: { run: paper.countpapers }, aliases: ['listpapers', 'papercount', 'vaultcount'] },
  refreshpapers: { mod: { run: paper.refreshpapers }, aliases: ['refreshvault', 'reloadpapers'] },
  ping: { mod: { run: extra.ping }, aliases: ['p'] },
  allow: { mod: { run: admin.allow, ownerOnly: true }, aliases: ['allowuser'] },
  disallow: { mod: { run: admin.disallow, ownerOnly: true }, aliases: ['disallowuser', 'removeuser'] },
  listusers: { mod: { run: admin.listusers, ownerOnly: true }, aliases: ['users', 'allowed'] },
  on: { mod: { run: admin.on, ownerOnly: true }, aliases: [] },
  off: { mod: { run: admin.off, ownerOnly: true }, aliases: [] },
  mode: { mod: { run: admin.mode, ownerOnly: true }, aliases: [] },
  broadcast: { mod: { run: admin.broadcast, ownerOnly: true }, aliases: ['bc', 'announce'] },
  restart: { mod: { run: admin.restart, ownerOnly: true }, aliases: ['reboot'] },
  botinfo: { mod: { run: admin.botinfo, ownerOnly: true }, aliases: ['botstatus'] },
  cookies: { mod: { run: admin.cookies, ownerOnly: true }, aliases: ['cookie', 'setcookies'] },
  ytdl: { mod: { run: admin.ytdl, ownerOnly: true }, aliases: ['ytfix', 'ytdlp', 'ytdiag'] },
};

// site shortcuts share the .dl pipeline
for (const sc of dl.SHORTCUTS) {
  ROUTES[sc.name] = { mod: { run: (ctx, args) => dl.runShortcut(ctx, sc, args) }, aliases: sc.aliases };
}

const route = (cmd) => {
  for (const [name, r] of Object.entries(ROUTES)) {
    if (name === cmd || r.aliases.includes(cmd)) return { name, ...r };
  }
  return null;
};

export function makeContext(transport, jid, msg = {}) {
  const senderJid = msg.key?.participant || jid;
  const numbers = access.senderNumbers(msg, senderJid);
  const owner = access.isOwnerSender(numbers) || jid === config.ownerJid || jid === 'cli';

  const ctx = {
    jid,
    msg,
    sender: senderJid,
    // stable identity for selection pickers (phone number when known)
    senderKey: numbers[0] || senderJid,
    senderNumbers: numbers,
    isOwner: owner,
    prefix: config.prefix,
    transport,

    say: (t) => transport.say(jid, t, msg),
    say2: (otherJid, t) => transport.say(otherJid, t),
    edit: (t) => transport.edit ? transport.edit(jid, t) : transport.say(jid, t),
    sendDoc: (path, caption, opts = {}) => transport.sendDoc(jid, path, caption, opts),
    sendImage: (media, caption, opts = {}) => transport.sendImage
      ? transport.sendImage(jid, media, caption, opts)
      : transport.sendDoc(jid, media, caption || 'image', {}),
    sendVideo: (media, caption, opts = {}) => transport.sendVideo
      ? transport.sendVideo(jid, media, caption, opts)
      : transport.sendDoc(jid, media, caption || 'video', {}),
    sendAudio: (media, opts = {}) => transport.sendAudio
      ? transport.sendAudio(jid, media, opts)
      : transport.sendDoc(jid, media, opts.caption || 'audio', opts),
    sendSticker: (buffer) => transport.sendSticker
      ? transport.sendSticker(jid, buffer)
      : transport.sendDoc(jid, buffer, 'sticker.webp', {}),
    downloadMedia: (m) => transport.downloadMedia ? transport.downloadMedia(m || msg) : null,
    quotedMedia: () => {
      const q = msg?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      if (!q) return null;
      return { key: msg.key, message: q };
    },
    react: (emoji) => transport.react ? transport.react(jid, emoji, msg.key) : Promise.resolve(),
    progress: (t) => transport.progress ? transport.progress(jid, t) : {},
    /** editable status card (send-then-edit, throttled, falls back to plain say) */
    status: (initialText) => {
      if (!transport.statusCard) {
        // transport without edit support: return a shim that just says
        let said = false;
        return { update: async (t) => { if (!said) { said = true; } }, final: async (t) => transport.say(jid, t) };
      }
      return transport.statusCard(jid, initialText, msg);
    },
    cooldown(kind, ms) {
      const k = `${jid}:${kind}`;
      const last = cooldowns.get(k) || 0;
      if (Date.now() - last < ms) return true;
      cooldowns.set(k, Date.now());
      return false;
    }
  };
  return ctx;
}

// text -> { cmd, args } | null
export function parse(text) {
  const P = config.prefix;
  const t = String(text || '').trim();
  if (!t.startsWith(P)) return null;
  const body = t.slice(P.length).trim();
  if (!body) return { cmd: 'help', args: [] };
  const [cmd, ...args] = body.split(/\s+/);
  return { cmd: cmd.toLowerCase(), args };
}

/** Bare-number / cancel routing ("reply with a number" pickers). */
export async function trySelections(ctx, text) {
  const t = String(text || '').trim();
  const key = ctx.senderKey || ctx.sender;

  // merged: legacy pending (movie/series) — bare "2" re-dispatches as ".movie pick 2"
  const rerun = pending.tryBarePick(ctx.jid, t, config.prefix);
  if (rerun) return handle(ctx.transport, ctx.jid, rerun, ctx.msg);

  if (selections.isCancel(t)) {
    if (selections.clear(ctx.jid, key)) {
      await ctx.say('👍 Cancelled. Nothing was downloaded.');
      return true;
    }
    return false;
  }
  const picked = selections.match(ctx.jid, key, t);
  if (picked) {
    try {
      await picked.entry.run(ctx, picked.item, picked.index);
    } catch (e) {
      hlog.error('selection run failed:', e.message);
      await ctx.say(`💥 ${String(e.message || '').split('\n')[0].slice(0, 140)}`).catch(() => {});
    }
    return true;
  }
  if (selections.isOutOfRange(ctx.jid, key, t)) {
    const open = selections.peek(ctx.jid, key);
    await ctx.say(`❌ Pick a number between 1 and ${open.items.length}, or reply *cancel*.`);
    return true;
  }
  return false;
}

export async function handle(transport, jid, text, msg = {}) {
  const ctx = makeContext(transport, jid, msg);
  const parsed = parse(text);

  // 1. bare number / cancel — only when a picker is open for this sender
  if (!parsed || /^\d/.test(parsed.cmd)) {
    const handled = await trySelections(ctx, text);
    if (handled) return true;
  }
  if (!parsed) return false;

  const found = route(parsed.cmd);
  if (!found) {
    await ctx.say(`Unknown command. Try *${config.prefix}help*`);
    return true;
  }

  // 2. merged access gates: bot on/off, then whitelist (owner always passes)
  if (!access.botOn() && !ctx.isOwner) return true;      // silent: bot is off
  if (!access.isAllowedSender({ numbers: ctx.senderNumbers, owner: ctx.isOwner })) return true;
  if (found.ownerOnly && !ctx.isOwner) {
    await ctx.say('👑 This command is only for the bot owner.');
    return true;
  }

  metrics.bump('command.run', { cmd: found.name });
  const ctx2 = { ...ctx, ownerOnly: Boolean(found.ownerOnly) };
  try {
    await found.mod.run(ctx2, parsed.args, msg);
  } catch (e) {
    hlog.error(`/${parsed.cmd} failed:`, e);
    metrics.bump('command.error');
    await ctx.say(`💥 ${e.message}`).catch(() => {});
  }
  return true;
}

export { ROUTES };
