// cli.js — developer entry point. Same engine, terminal front-end. Lets you
// exercise the full pipeline without pairing WhatsApp:
//   node cli.js movie "inception 2010" 1080
//   node cli.js series "breaking bad" s01e01 720
//   node cli.js providers
import config from './src/config.js';
import { log } from './src/core/log.js';
import media from './src/media/index.js';
import { handle } from './src/bot/handler.js';

const args = process.argv.slice(2);
if (!args.length) {
  console.log(`
${config.botName} — CLI mode

  node cli.js movie "inception 2010" 1080
  node cli.js series "breaking bad" s01e01 720
  node cli.js providers
  node cli.js help
`);
  process.exit(0);
}

// terminal transport: plain prints, "edit" just overwrites the line
let lastLine = '';
const transport = {
  async say(_jid, text) { lastLine = ''; console.log('\n' + text); },
  async edit(_jid, text) { console.log('· ' + text.split('\n')[0]); },
  async sendDoc(_jid, p, caption) { console.log('\n📎 ' + (caption || '') + '\n   → saved: ' + p); },
  async sendImage(_jid, p, caption) { console.log('\n🖼️ ' + (caption || '') + '\n   → ' + p); },
  async sendVideo(_jid, p, caption) { console.log('\n🎬 ' + (caption || '') + '\n   → ' + p); },
  async sendAudio(_jid, p, opts = {}) { console.log('\n🎵 ' + (opts.caption || '') + '\n   → ' + p); },
  async sendSticker(_jid, buf) { console.log('\n🏷️ sticker (' + (buf?.length || 0) + ' bytes)'); },
  async react() {},
  async downloadMedia() { return null; },   // no raw media in CLI mode
  statusCard(_jid, initial) {
    console.log('\n' + initial.split('\n')[0]);
    return {
      async update(text) { process.stdout.write('\r' + String(text).split('\n')[0].slice(0, 70) + '        '); },
      async final(text) { process.stdout.write('\n'); console.log(text); },
    };
  },
  async progress(_jid, text) {
    process.stdout.write('\r' + text.slice(0, 60));
  }
};

await media.boot().catch(e => { console.error('boot failed:', e.message); process.exit(1); });

const text = args[0].startsWith(config.prefix) ? args.join(' ') : `${config.prefix}${args.join(' ')}`;
const handled = await handle(transport, 'cli', text);
process.exit(handled ? 0 : 2);
