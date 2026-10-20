/**
 * Every module in engine/ must import cleanly (no syntax errors, no broken
 * relative imports, no missing exports between modules). This is the cheap net
 * that catches the classic "one bad edit and the bot boots to a dead engine".
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ENGINE = path.join(__dirname, '..', 'engine');

function engineFiles(dir = ENGINE, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) engineFiles(p, out);
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = engineFiles();

test('engine has the expected shape', () => {
  assert.ok(files.length >= 40, `only ${files.length} engine files found`);
  assert.ok(fs.existsSync(path.join(ENGINE, 'package.json')), 'engine/package.json (type: module) must exist');
  assert.equal(JSON.parse(fs.readFileSync(path.join(ENGINE, 'package.json'), 'utf8')).type, 'module');
});

for (const file of files) {
  const rel = path.relative(ENGINE, file);
  test(`imports: engine/${rel}`, async () => {
    const mod = await import(pathToFileURL(file).href);
    assert.ok(mod, 'module must export something');
  });
}

test('the public resolve API exposes everything the commands call', async () => {
  const media = await import(pathToFileURL(path.join(ENGINE, 'media', 'index.js')).href);
  for (const fn of ['identify', 'resolveMovie', 'resolveEpisode', 'resolveSeason', 'targetFile', 'rememberFile', 'qualityLadder', 'boot']) {
    assert.equal(typeof media[fn], 'function', `media.${fn} missing`);
  }
});

test('the metadata layer exposes all 8 sources', async () => {
  const metadata = await import(pathToFileURL(path.join(ENGINE, 'metadata', 'index.js')).href);
  const ids = metadata.table().map(r => r.id).sort();
  assert.deepEqual(ids, ['anilist', 'cinemeta', 'imdb', 'jikan', 'omdb', 'tmdb', 'trakt', 'tvmaze']);
  for (const fn of ['search', 'details', 'lookup', 'looksAnime', 'table']) {
    assert.equal(typeof metadata[fn], 'function', `metadata.${fn} missing`);
  }
});

test('all 13 download providers are registered', async () => {
  const media = await import(pathToFileURL(path.join(ENGINE, 'media', 'index.js')).href);
  const ids = media.registry.providers.map(p => p.id).sort();
  const expected = ['4khdhub', 'apibay', 'eztv', 'hdhub4u', 'knaben', 'moviesdrive', 'nyaa',
    'solidtorrents', 'torrentio', 'videasy', 'vidlink', 'vidsrc', 'yts'];
  assert.deepEqual(ids, expected);
  // tiers: torrent 1, ddl 2, stream 3
  assert.deepEqual([...new Set(media.registry.providers.map(p => p.tier))].sort(), [1, 2, 3]);
});
