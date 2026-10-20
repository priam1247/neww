// src/commands/ytv.js — merged from Zafar-bot-main: YouTube → MP4.
//   .ytv <link or search words> [144-1080]   (--first / leading ! skips picker)
// Automatic quality fallback when the requested size is too big; one heavy
// video job at a time; live progress card; honest failure messages.
import config from '../config.js';
import { log } from '../core/log.js';
import { metrics } from '../core/metrics.js';
import YT from '../providers/local/ytdlp.js';
import { searchYouTube, formatResults } from '../providers/local/youtubeSearch.js';
import { offer } from '../bot/selections.js';
import { downloadAndSend } from '../media/pipeline.js';

const ylog = log.child('cmd.ytv');
const QUALITIES = [144, 240, 360, 480, 720, 1080].sort((a, b) => a - b);
const LOCK_STALE_MS = 30 * 60_000;

let busyUntil = 0;   // one video job at a time keeps CPU/disk/RAM safe on small hosts

export const help = (P) =>
  `🎬 *${config.botName} — Video*\n\n*${P}ytv <name or link> [360|480|720|1080]*\ne.g. \`${P}ytv https://youtu.be/x 720\``;

export async function run(ctx, args) {
  const P = config.prefix;
  args = [...args];
  let height = Number(config.videoDefaultQuality) || 720;

  const last = String(args[args.length - 1] || '').toLowerCase().replace(/p$/, '');
  if (QUALITIES.includes(Number(last))) { height = Number(last); args.pop(); }

  let firstHit = false;
  const flagIdx = args.findIndex(a => /^--?first$/i.test(a));
  if (flagIdx !== -1) { firstHit = true; args.splice(flagIdx, 1); }
  let query = args.join(' ').trim();
  if (query.startsWith('!')) { firstHit = true; query = query.slice(1).trim(); }
  if (!query) return ctx.say(help(P));

  // search phrases: list the results and let the user pick
  if (!YT.isYouTubeUrl(query)) {
    const results = await searchYouTube(query, { limit: Math.max(1, config.searchResults) });
    if (!results.length) {
      const engine = YT.resolveCommand() || await YT.ensureInstalled();
      if (!engine) return ctx.say(YT.friendlyError(Object.assign(new Error('yt-dlp is not installed'), { code: 'NO_YTDLP' })));
      return ctx.say('❌ No results found for that search.');
    }
    if (results.length > 1 && config.searchPicker && !firstHit) {
      const listText = formatResults(results, {
        header: `🔎 *Results for "${query}"*`,
        note: `Reply with a number (1-${results.length}) to download in ${height}p, or *cancel*.\n_Next time, add --first to skip this step._`,
      });
      await ctx.say(listText);
      offer({
        chatId: ctx.jid, sender: ctx.senderKey, items: results, label: 'ytv',
        ttlMs: Math.max(1, config.searchTtlMinutes) * 60_000,
        run: (ctx2, item) => run(ctx2, [item.url, String(height)]),
      });
      return;
    }
    query = results[0].url;
  } else {
    query = YT.normalizeYouTubeUrl(query);
  }

  // one heavy job at a time; a stale lock (crashed job) never blocks forever
  if (Date.now() < busyUntil) return ctx.say('⏳ Another video is being processed. Try again in a minute.');
  busyUntil = Date.now() + LOCK_STALE_MS;
  metrics.bump('command.ytv');

  try {
    // quality fallback ladder: requested → lower, capped at 3 attempts
    const candidates = [height, ...QUALITIES.filter(q => q < height).reverse()].slice(0, 3);
    let lastErr = null;
    for (const q of candidates) {
      const res = await downloadAndSend(ctx, { url: query, kind: 'video', height: q });
      if (res.sent) return res;
      lastErr = res.error;
      const code = res.code;
      // only a size problem is worth a lower quality; anything else is final
      if (!['TOO_BIG', 'NO_FORMATS', 'UNKNOWN'].includes(code)) break;
    }
    return null;
  } finally {
    busyUntil = 0;
  }
}
