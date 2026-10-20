// src/commands/spotify.js — merged from Zafar-bot-main: Spotify link → MP3.
//   .spotify <link>            Spotify track link → the matching audio
//   .spotify <artist - title>  plain text works too
// Reads the track's metadata (public oEmbed — no API key), finds the same
// song on YouTube, downloads that as MP3 through the shared pipeline.
import config from '../config.js';
import { log } from '../core/log.js';
import { metrics } from '../core/metrics.js';
import { resolveTrack } from '../providers/local/spotify.js';
import { searchYouTube } from '../providers/local/youtubeSearch.js';
import YT from '../providers/local/ytdlp.js';
import { downloadAndSend } from '../media/pipeline.js';

const splog = log.child('cmd.spotify');

export const help = (P) =>
  `🎧 *${config.botName} — Spotify*\n\n*${P}spotify <link or "artist - title">*\ne.g. \`${P}spotify https://open.spotify.com/track/...\``;

export async function run(ctx, args) {
  const P = config.prefix;
  const input = args.join(' ').trim();
  if (!input) return ctx.say(help(P));

  const status = ctx.status ? ctx.status('🎧 Reading Spotify…') : null;
  const update = (t) => status ? status.update(t) : ctx.say(t);

  try {
    const track = await resolveTrack(input);
    const shown = track.artists ? `${track.artists} — ${track.title}` : track.title;

    const results = await searchYouTube(track.searchQuery, { limit: 3 });
    if (!results.length) {
      await update(`❌ *${shown}*\nI found the track on Spotify but nothing matching it on YouTube.\nTry \`${P}song ${track.searchQuery}\` with a different spelling.`);
      return null;
    }

    const best = results[0];
    const time = best.duration ? ` (${Math.floor(best.duration / 60)}:${String(best.duration % 60).padStart(2, '0')})` : '';
    await update(
      `🎧 *${shown}*\n` +
      `├─ Spotify: ${track.source === 'spotify-api' ? 'API' : 'link metadata'}${track.album ? ` • ${track.album}` : ''}\n` +
      `├─ Matching on YouTube: *${best.title}*${time}\n` +
      `╰─ Downloading as MP3…`
    );

    metrics.bump('command.spotify');
    return downloadAndSend(ctx, {
      url: best.url, kind: 'audio',
      title: track.artists ? `${track.title} - ${track.artists}` : track.title,
      author: track.artists, sendAs: 'audio',
    });
  } catch (e) {
    splog.error('spotify error:', e.message);
    const hint = e.code === 'SPOTIFY_META'
      ? `❌ Could not read that Spotify link (${e.message}).\nMake sure it is a public track link, or use \`${P}song <artist - title>\`.`
      : YT.friendlyError(e);
    return update(hint);
  }
}
