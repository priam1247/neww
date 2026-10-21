/**
 * ZaFar Bot — .dl  (universal downloader)
 *
 *   .dl <link> [audio|video|image] [144-1080]
 *
 * One command for every site the engine can read: YouTube, TikTok, Instagram,
 * Facebook, X/Twitter, Reddit, SoundCloud, Pinterest, Vimeo, Twitch clips …
 * (yt-dlp supports ~1000 sites; cobalt covers the rest as a backup.)
 *
 * The actual work lives in utils/mediaPipeline.js, shared with .tiktok/.x/
 * .pinterest/.spotify — so all of them inherit the player-client escalation,
 * cookies (.cookies set), proxy, live progress, disk streaming and honest
 * error messages built for .song/.ytv.
 */

const path = require('path');
const YT = require('../../utils/youtubedl');
const { downloadAndSend, parseOptions, QUALITIES } = require('../../utils/mediaPipeline');

module.exports = {
  name: 'dl',
  aliases: ['download', 'save', 'getvid', 'fetch'],
  category: 'media',
  description: 'Download a video, image or audio file from almost any site',
  usage: '.dl <link> [audio|video|image] [quality]',

  async execute(sock, msg, args, extra) {
    const chatId = extra?.from || msg.key.remoteJid;
    const say = (text) => sock.sendMessage(chatId, { text }, { quoted: msg });

    const { kind, height, rest } = parseOptions(args);
    const url = YT.extractUrl(rest.join(' ').trim());

    if (!url) {
      return say(
        'Usage: .dl <link> [audio|video|image] [quality]\n' +
        'Example: .dl https://vm.tiktok.com/xxxx\n' +
        '         .dl https://x.com/user/status/123 audio\n\n' +
        `Works with YouTube, TikTok, Instagram, Facebook, X/Twitter, Reddit, SoundCloud, Pinterest and ~1000 more sites.\n` +
        `Qualities: ${QUALITIES.join(', ')}`,
      );
    }

    const attempts = [];
    const imageUrl = /\.(?:avif|gif|jpe?g|png|webp)(?:[?#]|$)/i.test(url);
    const lane = kind === 'audio' || kind === 'image' || imageUrl ? 'light' : 'heavy';
    return downloadAndSend(sock, msg, extra, { url, kind, height, attempts, lane });
  },
};
