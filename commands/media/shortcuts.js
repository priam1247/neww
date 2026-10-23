/**
 * ZaFar Bot — site shortcuts: .tiktok / .x / .pinterest / .instagram / .fb
 *
 * Thin wrappers around the shared pipeline (`utils/mediaPipeline.js`), which
 * streams every file directly to disk instead of buffering in RAM and cleans
 * up temp files immediately after sending:
 *
 *   .tiktok <link> [quality]      .tt
 *   .x <link> [quality]           .twitter .xtwitter
 *   .pinterest <link>             .pin     (sends the image when it is an image)
 *   .instagram <link>             .ig .insta .igdl .reels
 *   .fb <link> [quality]          .fbdl .facebookdl .facebook
 */

const config = require('../../config');
const YT = require('../../utils/youtubedl');
const { downloadAndSend, parseOptions } = require('../../utils/mediaPipeline');

function quotedTextOf(msg) {
  const ctx = msg?.message?.extendedTextMessage?.contextInfo
    || msg?.message?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo;
  const q = ctx?.quotedMessage;
  if (!q) return '';
  return (
    q.conversation ||
    q.extendedTextMessage?.text ||
    q.imageMessage?.caption ||
    q.videoMessage?.caption ||
    ''
  );
}

const makeCommand = ({ name, aliases, description, usage, domains, hostLabel, label, defaultKind = 'video' }) => ({
  name,
  aliases,
  category: 'media',
  description,
  usage,

  async execute(sock, msg, args, extra) {
    const chatId = extra?.from || msg.key.remoteJid;
    const say = (text) => sock.sendMessage(chatId, { text }, { quoted: msg });
    const P = config.prefix || '.';

    const { kind, height, rest } = parseOptions(args, { kind: defaultKind });
    const url = YT.extractUrl(rest.join(' ').trim()) || YT.extractUrl(quotedTextOf(msg));

    if (!url) {
      return say(`Usage: ${P}${usage.replace(/^\./, '')}`);
    }

    const known = domains.some((d) => url.toLowerCase().includes(d));
    const imageUrl = /\.(?:avif|gif|jpe?g|png|webp)(?:[?#]|$)/i.test(url);
    const lane = kind === 'audio' || kind === 'image' || imageUrl ? 'light' : 'heavy';

    return downloadAndSend(sock, msg, extra, {
      url,
      kind,
      height,
      lane,
      attempts: [{ engine: `${label} chain`, code: known ? 'OK' : 'HOST_MISMATCH' }],
    });
  },
});

module.exports = [
  makeCommand({
    name: 'tiktok',
    aliases: ['tt'],
    label: 'tiktok',
    description: 'Download a TikTok video (no watermark when the source allows it)',
    usage: '.tiktok <TikTok link>',
    domains: ['tiktok.com', 'vt.tiktok.com', 'vm.tiktok.com'],
    hostLabel: 'TikTok',
  }),
  makeCommand({
    name: 'x',
    aliases: ['twitter', 'xtwitter'],
    label: 'x',
    description: 'Download a video from X / Twitter',
    usage: '.x <tweet link>',
    domains: ['twitter.com', 'x.com', 't.co', 'nitter.'],
    hostLabel: 'X/Twitter',
  }),
  makeCommand({
    name: 'pinterest',
    aliases: ['pin'],
    label: 'pinterest',
    description: 'Download a Pinterest pin (image or video)',
    usage: '.pinterest <Pinterest link>',
    domains: ['pinterest.', 'pin.it'],
    hostLabel: 'Pinterest',
  }),
  makeCommand({
    name: 'instagram',
    aliases: ['ig', 'insta', 'igdl', 'reels'],
    label: 'instagram',
    description: 'Download Instagram reels, videos, or photos',
    usage: '.instagram <Instagram link>',
    domains: ['instagram.com', 'instagr.am', 'ddinstagram.com'],
    hostLabel: 'Instagram',
  }),
  makeCommand({
    name: 'fb',
    aliases: ['fbdl', 'facebookdl', 'facebook'],
    label: 'facebook',
    description: 'Download a Facebook video or reel',
    usage: '.fb <Facebook video link>',
    domains: ['facebook.com', 'fb.watch', 'fb.com', 'm.facebook.com'],
    hostLabel: 'Facebook',
  }),
];
