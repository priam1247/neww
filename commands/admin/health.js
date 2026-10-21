const fs = require('fs');
const YT = require('../../utils/youtubedl');
const ffmpeg = require('../../utils/ffmpeg');
const jobQueue = require('../../utils/jobQueue');
const sendCache = require('../../utils/sendCache');
const { getTempDir } = require('../../utils/tempManager');
const movieEngine = require('../../utils/movieEngine');

const mb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

module.exports = {
  name: 'health',
  category: 'admin',
  description: 'Show bot runtime and media engine health',
  usage: '.health',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    const command = YT.resolveCommand();
    const ytVersion = YT.version();
    const ffmpegPath = ffmpeg();
    const ffmpegVersion = ffmpeg.version();
    let freeDisk = 'unavailable';
    try {
      const stat = fs.statfsSync(getTempDir());
      freeDisk = mb(stat.bavail * stat.bsize);
    } catch { /* filesystem stats are optional on unsupported platforms */ }

    const memory = process.memoryUsage();
    const uptimeSeconds = Math.floor(process.uptime());
    const uptime = `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m`;
    const jobs = jobQueue.stats();
    const cacheEntries = sendCache.count();
    const failure = YT.lastError();
    let providers = 'unavailable';
    try {
      const rows = await movieEngine.providers();
      providers = `${rows.length} registered${rows.length ? ` · ${rows.filter((row) => /live|closed/i.test(row.state || '')).length} live` : ''}`;
    } catch { /* movie engine may not be configured */ }

    const lastFailure = failure
      ? `${failure.code || 'unknown'}${failure.detail ? ` · ${String(failure.detail).replace(/\s+/g, ' ').slice(0, 120)}` : ''}`
      : 'none';
    const text = [
      '🩺 *Bot health*',
      `yt-dlp: ${ytVersion || 'missing'} · ${Array.isArray(command) ? command.join(' ') : command || 'not found'}`,
      `ffmpeg: ${ffmpegPath || 'not found'} · ${ffmpegVersion || 'version unknown'}`,
      `Temp free disk: ${freeDisk}`,
      `Memory: RSS ${mb(memory.rss)} · heap ${mb(memory.heapUsed)}/${mb(memory.heapTotal)}`,
      `Uptime: ${uptime}`,
      `Jobs: light ${jobs.light.running} running/${jobs.light.waiting} waiting · heavy ${jobs.heavy.running} running/${jobs.heavy.waiting} waiting`,
      `Send cache: ${cacheEntries} entries`,
      `Last yt-dlp failure: ${lastFailure}`,
      `Movie providers: ${providers}`,
    ].join('\n');

    return extra.reply(text);
  },
};
