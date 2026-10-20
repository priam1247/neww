// src/commands/extra.js — /help, /cache, /subs utilities.
import config from '../config.js';
import cache from '../core/cache.js';
import { formatBytes } from '../utils/format.js';
import { searchSubs } from '../media/subs.js';
import * as media from '../media/index.js';

export function help(ctx) {
  const P = config.prefix;
  return [
    `🤖 *${config.botName}*`,
    '',
    `◈ MOVIES & SERIES`,
    `*${P}movie* <title> [year] [quality] — download a movie`,
    `*${P}series* <title> s01e03 [quality] — download an episode`,
    `*${P}series* <title> s01 range 1-6 — batch episodes`,
    `*${P}netflix* [movies|tv] [page] — Netflix catalog`,
    '',
    `◈ MUSIC & VIDEO`,
    `*${P}song* <name/link> [audio|doc] — YouTube → MP3`,
    `*${P}ytv* <name/link> [144-1080] — YouTube → MP4`,
    `*${P}dl* <any link> [audio|720] — any site (~1000)`,
    `*${P}tiktok* · *${P}x* · *${P}pinterest* · *${P}instagram* · *${P}fb*`,
    `*${P}spotify* <link or "artist - title"> — track → MP3`,
    `_search: reply with a number to pick_`,
    '',
    `◈ TOOLS`,
    `*${P}sticker* (reply to media) — make a sticker`,
    `*${P}viewonce* (reply) — reveal view-once media`,
    `*${P}tgpack* / *${P}tgsticker* — Telegram sticker packs`,
    `*${P}subs* <title> s01e03 [lang] — subtitles (optional)`,
    '',
    `◈ PAPERS`,
    `*${P}paper* <code> [module] [year] — past papers`,
    `*${P}paper* browse — explore the vault`,
    `*${P}countpapers* — vault size`,
    '',
    `◈ GENERAL`,
    `*${P}ping* — response time · *${P}menu* — this list`,
    `*${P}providers* — source health · *${P}stats* — engine metrics`,
    '',
    `_qualities: 480 / 720 / 1080 / 2160 (4k)_`,
    `_sources: 14 movie providers + yt-dlp + cobalt_`,
    `_admin: .allow .disallow .listusers .on .off .restart .broadcast .cookies .ytdl_`
  ].join('\n');
}

export async function ping(ctx) {
  const start = Date.now();
  const sent = await ctx.say('🏓 Pinging...');
  const ms = Date.now() - start;
  // edit in place when the transport supports it; otherwise send a second message
  try {
    const key = sent?.key;
    if (key && ctx.transport?.sock) {
      await ctx.transport.sock.sendMessage(ctx.jid, {
        text: `╭─ 🏓 *Pong!*\n│ ⚡ ${ms}ms response\n╰─ ${config.botName}`,
        edit: key,
      });
      return;
    }
  } catch { /* fall through */ }
  return ctx.say(`╭─ 🏓 *Pong!*\n│ ⚡ ${ms}ms response\n╰─ ${config.botName}`);
}

export async function cacheCmd(ctx, args) {
  const sub = (args[0] || '').toLowerCase();
  if (sub === 'wipe') {
    if (ctx.jid !== config.ownerJid) return ctx.say('⛔ owner only');
    cache.wipe();
    return ctx.say('🧹 cache wiped (files + indexes)');
  }
  const s = cache.stats();
  return ctx.say(`🗂️ cache: ${s.files} files · ${formatBytes(s.bytes)}\nmeta ${s.meta} · links ${s.links} · negative ${s.neg}`);
}

export async function subs(ctx, args) {
  const P = config.prefix;
  if (args.length < 2) return ctx.say(`💬 *${P}subs <title> s01e03 [lang]* — needs OPENSUBTITLES_API_KEY in .env`);

  const lang = args.find(a => /^[a-z]{2}$/.test(a)) || 'en';
  const rest = args.filter(a => !/^[a-z]{2}$/.test(a)).join(' ');
  const m = /\bs(\d{1,2})[\s._-]?e(\d{1,3})\b/i.exec(rest);
  const title = rest.replace(/\bs\d{1,2}[\s._-]?e\d{1,3}\b/i, '').trim();

  try {
    const matches = await media.tmdb.searchTv(title);
    if (!matches.length) return ctx.say('❌ Series not found.');
    const meta = await media.tmdb.tvDetails(matches[0].tmdbId);
    const results = await searchSubs({
      imdbId: meta.imdbId,
      season: m ? Number(m[1]) : null,
      episode: m ? Number(m[2]) : null,
      language: lang
    });
    if (!results.length) return ctx.say('❌ No subtitles found.');
    return ctx.say([
      `💬 *Subtitles* (${lang})`,
      ...results.map((s, i) => `*${i + 1}.* ${s.title} [${s.language}] ${s.downloads}↓`)
    ].join('\n'));
  } catch (e) {
    return ctx.say(`❌ ${e.message}`);
  }
}
