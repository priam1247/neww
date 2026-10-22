/**
 * ZaFar Bot — .spotify  (Spotify link → MP3)
 *
 *   .spotify <link>            Spotify track link → the matching audio
 *   .spotify <artist - title>  plain text works too
 *
 * Spotify itself does not allow third-party downloads, so the bot:
 *   1. reads the track's *metadata*,
 *   2. finds the same song on YouTube,
 *   3. downloads that as MP3 — exactly like .song does.
 *
 * Metadata comes from Spotify's public oEmbed endpoint, so no API key is
 * required; add SPOTIFY_CLIENT_ID/SECRET for album + duration too.
 */

const config = require('../../config');
const spotify = require('../../utils/spotify');
const YT = require('../../utils/youtubedl');
const youtubeSearch = require('../../utils/youtubeSearch');
const { downloadAndSend } = require('../../utils/mediaPipeline');

module.exports = {
  name: 'spotify',
  aliases: ['sp', 'spot', 'spotdl'],
  category: 'media',
  description: 'Download a Spotify track as MP3 (matched on YouTube)',
  usage: '.spotify <Spotify link or "artist - title">',

  async execute(sock, msg, args, extra) {
    const chatId = extra?.from || msg.key.remoteJid;
    const say = (text) => sock.sendMessage(chatId, { text }, { quoted: msg });
    const react = (emoji) => sock.sendMessage(chatId, { react: { text: emoji, key: msg.key } }).catch(() => {});

    const input = args.join(' ').trim();
    if (!input) return say(`Usage: ${module.exports.usage}`);

    const status = await extra.status('🎧 Reading Spotify…').catch(() => null);
    const update = (t) => (status ? status.update(t) : say(t));

    try {
      const track = await spotify.resolveTrack(input);
      const shown = track.artists ? `${track.artists} — ${track.title}` : track.title;

      // Resolve the match on YouTube (same search stack as .song/.ytv).
      const results = await youtubeSearch.searchYouTube(track.searchQuery, { limit: 3 });
      if (!results.length) {
        await react('❌');
        return update(
          `❌ *${shown}*\nI found the track on Spotify but nothing matching it on YouTube.\n` +
          `Try \`.song ${track.searchQuery}\` with a different spelling.`,
        );
      }

      const best = results[0];
      const alternative = results[1];
      const time = best.duration ? ` (${Math.floor(best.duration / 60)}:${String(best.duration % 60).padStart(2, '0')})` : '';
      await update(
        `🎧 *${shown}*\n` +
        `├─ Spotify: ${track.source === 'spotify-api' ? 'API' : 'link metadata'}${track.album ? ` • ${track.album}` : ''}\n` +
        `├─ Matching on YouTube: *${best.title}*${time}\n` +
        `╰─ Downloading as MP3…` +
        (alternative ? `\n_Wrong match? Try_ \`.song ${track.searchQuery}\`` : ''),
      );

      // Reuse the full pipeline (progress card, cookies, proxy, fallbacks).
      return downloadAndSend(sock, msg, extra, {
        url: best.url,
        kind: 'audio',
        title: track.artists ? `${track.title} - ${track.artists}` : track.title,
        author: track.artists,
        attempts: [{ engine: 'spotify+yt-dlp', code: 'OK' }],
        lane: 'light',
        cache: false,
      });
    } catch (e) {
      console.error('[spotify] error:', e.message);
      await react('❌');
      const isOwner = Boolean(extra?.isOwner);
      const hint = e.code === 'SPOTIFY_META'
        ? `❌ Could not read that Spotify link.\nMake sure it is a public track link, or use \`${config.prefix}song <artist - title>\`.`
        : YT.friendlyError(e, { isOwner });
      return update(hint);
    }
  },
};
