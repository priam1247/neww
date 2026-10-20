/**
 * Host-bot safety net.
 *
 * Zafar-bot-main was a finished, working bot. The movie/series feature is an
 * ADDITION to it, so these tests exist to make sure it can never again be an
 * intrusion:
 *
 *   1. every command that existed before still exists, with the same name
 *   2. the new commands introduce no name/alias collision with the old ones
 *   3. the engine never installs process-wide SIGINT/SIGTERM handlers in the
 *      host process (that would fight utils/cleanup.js on shutdown)
 *   4. the engine only ever writes inside temp/movies — the bot's own temp
 *      cleanup deletes loose files in temp/ after 30 minutes
 *   5. loading/booting the engine does not touch the bot's own modules
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const COMMANDS = path.join(ROOT, 'commands');

/** Commands the bot shipped with — they must all still be available. */
const ORIGINAL_COMMANDS = [
  'allow', 'broadcast', 'cookies', 'countpapers', 'disallow', 'dl', 'fb',
  'instagram', 'listusers', 'menu', 'on', 'paper', 'ping', 'pinterest',
  'refreshpapers', 'restart', 'song', 'spotify', 'sticker', 'tgpack',
  'tgsticker', 'tiktok', 'update', 'viewonce', 'x', 'ytdl', 'ytv',
];

/** The only commands this integration adds. */
const ADDED_COMMANDS = ['movie', 'series', 'info', 'providers', 'moviestatus'];

function commandFiles() {
  const out = [];
  for (const category of fs.readdirSync(COMMANDS)) {
    const dir = path.join(COMMANDS, category);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) out.push(path.join(dir, file));
  }
  return out;
}

/**
 * Read `name:` and `aliases: [...]` statically: the command modules need
 * axios / baileys, so requiring them here would fail outside the real bot.
 */
function keysOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const names = [...src.matchAll(/^\s*name:\s*'([^']+)'/gm)].map(m => m[1]);
  const aliases = [...src.matchAll(/aliases:\s*\[([^\]]*)\]/g)]
    .flatMap(m => [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]));
  return [...names, ...aliases];
}

test('every original command is still registered', () => {
  const keys = new Set(commandFiles().flatMap(keysOf));
  const missing = ORIGINAL_COMMANDS.filter(c => !keys.has(c));
  assert.deepEqual(missing, [], `commands lost: ${missing.join(', ')}`);
});

test('the engine commands are registered too', () => {
  const keys = new Set(commandFiles().flatMap(keysOf));
  const missing = ADDED_COMMANDS.filter(c => !keys.has(c));
  assert.deepEqual(missing, [], `missing engine commands: ${missing.join(', ')}`);
});

test('no command name or alias collides with another', () => {
  const owner = new Map();
  const clashes = [];
  for (const file of commandFiles()) {
    for (const key of keysOf(file)) {
      if (owner.has(key) && owner.get(key) !== file) {
        clashes.push(`${key}: ${path.relative(ROOT, owner.get(key))} AND ${path.relative(ROOT, file)}`);
      } else {
        owner.set(key, file);
      }
    }
  }
  assert.deepEqual(clashes, [], `alias collisions:\n${clashes.join('\n')}`);
});

test('the engine adds no process-wide signal handlers when embedded', async () => {
  process.env.TEMP_DIR = path.join(ROOT, 'temp', 'movies');
  process.env.CACHE_FILE = path.join(ROOT, 'temp', 'movies', 'cache-safety.json');
  process.env.MOVIE_QUIET = '1';

  const before = {
    SIGINT: process.listenerCount('SIGINT'),
    SIGTERM: process.listenerCount('SIGTERM'),
  };

  const { cache } = await import(new URL('../engine/media/index.js', require('url').pathToFileURL(__filename)).href);
  await cache.init({ installSignalHandlers: false });

  assert.equal(process.listenerCount('SIGINT'), before.SIGINT, 'engine must not add a SIGINT handler');
  assert.equal(process.listenerCount('SIGTERM'), before.SIGTERM, 'engine must not add a SIGTERM handler');
});

test('engine paths stay inside the bot temp folder', () => {
  const config = require('../config');
  const m = config.movies;

  for (const key of ['tempDir', 'cacheFile', 'dataDir']) {
    assert.ok(String(m[key]).replace(/\\/g, '/').startsWith('temp/'),
      `movies.${key} must live under temp/ (got ${m[key]})`);
  }
  // and specifically inside temp/movies, so the bot's 30-min temp sweep
  // (which only looks at loose files in temp/) can never delete engine data
  assert.match(String(m.tempDir).replace(/\\/g, '/'), /^temp\/movies/);
  assert.match(String(m.cacheFile).replace(/\\/g, '/'), /^temp\/movies\//);
  assert.match(String(m.dataDir).replace(/\\/g, '/'), /^temp\/movies\//);
});

test('the bridge hands the engine config but never overrides the bot config', () => {
  const env = { ...process.env };
  const bridge = require('../utils/movieEngine');
  // loading the bridge is what drives the env hand-off
  const load = bridge.load();
  return load.then(() => {
    // the bot's own keys must be untouched
    assert.equal(process.env.SESSION_NAME, env.SESSION_NAME);
    assert.equal(process.env.PREFIX, env.PREFIX);
    // and the engine got what it needs
    assert.ok(process.env.TEMP_DIR);
    assert.ok(process.env.CACHE_FILE);
  });
});
