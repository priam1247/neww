const YT = require('../../utils/youtubedl');
const { downloadAndSend, parseOptions } = require('../../utils/mediaPipeline');

module.exports = {
  name: 'dl',
  aliases: ['download', 'save', 'getvid', 'fetch'],
  category: 'media',
  description: 'Download media from a URL',
  usage: '.dl <link> [audio|video|image] [quality]',

  async execute(sock, msg, args, extra) {
    const chatId = extra?.from || msg.key.remoteJid;
    const say = (text) => sock.sendMessage(chatId, { text }, { quoted: msg });

    const { kind, height, rest } = parseOptions(args);
    const url = YT.extractUrl(rest.join(' ').trim());

    if (!url) {
      return say('Usage: .dl <link> [audio|video] [quality]');
    }

    const attempts = [];
    const imageUrl = /\.(?:avif|gif|jpe?g|png|webp)(?:[?#]|$)/i.test(url);
    const lane = kind === 'audio' || kind === 'image' || imageUrl ? 'light' : 'heavy';
    return downloadAndSend(sock, msg, extra, { url, kind, height, attempts, lane });
  },
};
