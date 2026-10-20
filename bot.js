// bot.js — WhatsApp entry point.
//   1. process guards (ENOSPC-safe, memory watchdog, temp sweeper)
//   2. engine boots (cache restore, provider registration)
//   3. WhatsApp pairs via QR or pairing code (first run) and serves commands
import config from './src/config.js';
import { log } from './src/core/log.js';
import media from './src/media/index.js';
import watchdog from './src/core/watchdog.js';
import { startWhatsApp } from './src/bot/wa.js';

const blog = log.child('bot');

watchdog.installProcessGuards();
watchdog.startTempSweeper();
watchdog.startMemoryWatchdog();

blog.info(`🚀 ${config.botName} starting`);
blog.info(`   debrid: ${[config.realDebridKey && 'realdebrid', config.allDebridKey && 'alldebrid'].filter(Boolean).join(', ') || 'none configured'}`);
blog.info(`   tmdb key: ${config.tmdbKey ? 'set' : 'MISSING'}`);
blog.info(`   yt-dlp: ${config.ytdlpDeadlineMs / 60000 | 0}min deadline · drime papers: ${config.drimeApiToken ? 'set' : 'off'}`);
blog.info(`   access: ${config.accessMode} · owner: ${config.ownerNumber || config.ownerJid || 'unset'}`);
blog.info('   selfbot: on — commands typed on the linked phone are executed');

await media.boot().catch(e => blog.warn('engine boot:', e.message));
const sock = await startWhatsApp();
if (!sock) {
  blog.warn('engine online, WhatsApp offline (degraded mode) — adapter will retry every 2 minutes');
  blog.warn('or fix deps and restart: npm install  |  panel: bash start.sh');
}
