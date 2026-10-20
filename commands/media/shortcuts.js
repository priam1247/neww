/**
 * ZaFar Bot — site shortcuts: .tiktok / .x / .pinterest
 *
 * Thin wrappers around the shared pipeline (utils/mediaPipeline.js). They exist
 * so the common links need no arguments and no thinking:
 *
 *   .tiktok <link> [quality]      .tt
 *   .x <link> [quality]           .twitter .xtwitter
 *   .pinterest <link>             .pin     (sends the image when it is an image)
 *
 * Each one validates its own domain first — pasting the wrong link into the
 * wrong shortcut produces a clear answer instead of a mysterious error.
 */

const YT = require('../../utils/youtubedl');
const { downloadAndSend, parseOptions } = require('../../utils/mediaPipeline');

const makeCommand = ({ name, aliases, description, usage, domains, hostLabel, label, defaultKind = 'video' }) => ({
  name,
  aliases,
  category: 'media',
  description,
  usage,

  async execute(sock, msg, args, extra) {
    const chatId = extra?.from || msg.key.remoteJid;
    const say = (text) => sock.sendMessage(chatId, { text }, { quoted: msg });

    const { kind, height, rest } = parseOptions(args, { kind: defaultKind });
    const url = YT.extractUrl(rest.join(' ').trim());

    if (!url) return say(`Usage: ${usage}\nExample: .${name} https://...`);

    const known = domains.some((d) => url.toLowerCase().includes(d));
    if (!known) {
      // Not this site — hand it to the universal command instead of failing.
      await say(`ℹ️ That is not a ${hostLabel} link — using the general downloader.`);
    }

    return downloadAndSend(sock, msg, extra, {
      url,
      kind,
      height,
      attempts: [{ engine: `${label} chain`, code: known ? 'OK' : 'HOST_MISMATCH' }],
    }); // the pipeline replies with the real reason itself
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
];
