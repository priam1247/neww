// src/commands/song.js — merged from Zafar-bot-main: YouTube → MP3.
//   .song <name or link> [audio|doc]   (audio|doc overrides config.songSendAs)
// Search phrases show a numbered list (reply with a number, or cancel);
// add --first or a leading ! to take the top hit immediately.
import config from '../config.js';
import { log } from '../core/log.js';
import { metrics } from '../core/metrics.js';
import YT from '../providers/local/ytdlp.js';
import { searchYouTube, formatResults } from '../providers/local/youtubeSearch.js';
import { offer } from '../bot/selections.js';
import { downloadAndSend } from '../media/pipeline.js';
import { jobDir } from '../media/transfer.js';

const slog = log.child('cmd.song');

export const help = (P) =>
  `🎵 *${config.botName} — Song*\n\n*${P}song <name or link> [audio|doc]*\ne.g. \`${P}song Faded Alan Walker\`\n_Search results: reply with a number. Add --first to skip._`;

export async function run(ctx, args) {
  const P = config.prefix;
  args = [...args];

  // trailing send-mode token
  let sendAs = String(config.songSendAs).toLowerCase();
  const last = String(args[args.length - 1] || '').toLowerCase();
  if (['audio', 'mp3'].includes(last)) { sendAs = 'audio'; args.pop(); }
  else if (['doc', 'document', 'file'].includes(last)) { sendAs = 'document'; args.pop(); }

  // --first (or leading !) skips the results list
  let firstHit = false;
  const flagIdx = args.findIndex(a => /^--?first$/i.test(a));
  if (flagIdx !== -1) { firstHit = true; args.splice(flagIdx, 1); }
  let text = args.join(' ').trim();
  if (text.startsWith('!')) { firstHit = true; text = text.slice(1).trim(); }
  if (!text) return ctx.say(help(P));

  const executeForUrl = async (url, presetTitle = '', presetAuthor = '') => {
    return await downloadAndSend(ctx, { url, kind: 'audio', title: presetTitle || '', author: presetAuthor, sendAs });
  };

  if (YT.isYouTubeUrl(text)) return executeForUrl(YT.normalizeYouTubeUrl(text));

  // search + picker
  const results = await searchYouTube(text, { limit: Math.max(1, config.searchResults) });
  if (!results.length) {
    const engine = YT.resolveCommand() || await YT.ensureInstalled();
    if (!engine) return ctx.say(YT.friendlyError(Object.assign(new Error('yt-dlp is not installed'), { code: 'NO_YTDLP' })));
    return ctx.say('❌ No results found for that search. Try a different spelling, or paste a YouTube link.');
  }

  if (results.length > 1 && config.searchPicker && !firstHit) {
    const listText = formatResults(results, {
      header: `🔎 *Results for "${text}"*`,
      note: `Reply with a number (1-${results.length}) to download, or *cancel*.\n_Next time, add --first to skip this step._`,
    });
    await ctx.say(listText);
    offer({
      chatId: ctx.jid,
      sender: ctx.senderKey,
      items: results,
      label: 'song',
      ttlMs: Math.max(1, config.searchTtlMinutes) * 60_000,
      run: (ctx2, item) => run(ctx2, [item.url]),
    });
    return;
  }

  metrics.bump('command.song');
  return executeForUrl(results[0].url, results[0].title, results[0].author);
}
