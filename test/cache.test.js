// test/cache.test.js — TTL maps, persistence, orphan sweep. Uses isolated env
// (each node:test file runs in its own process, so env cannot leak).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.TEMP_DIR = './temp/test-media';
process.env.CACHE_FILE = './temp/test/cache-store.json';
process.env.CACHE_MAX_MB = '1';

const { default: cache, _internal } = await import('../src/core/cache.js');

test('meta cache set/get/TTL', async () => {
  cache.mset('k1', { a: 1 });
  assert.deepEqual(cache.mget('k1'), { a: 1 });

  // force-expire via internals
  const e = _internal.meta.get('k1');
  e.exp = Date.now() - 1;
  assert.equal(cache.mget('k1'), null);
});

test('link cache get/set', () => {
  cache.lset('link1', 'https://example.com/file.mkv');
  assert.equal(cache.lget('link1'), 'https://example.com/file.mkv');
  assert.equal(cache.lget('missing'), null);
});

test('negative cache', () => {
  cache.nset('neg1', 5);
  assert.equal(cache.nget('neg1'), true);
  const e = _internal.neg.get('neg1');
  _internal.neg.set('neg1', Date.now() - 1);
  assert.equal(cache.nget('neg1'), false);
});

test('file LRU: fget validates file existence', () => {
  const f = './temp/test-media/real-file.mp4';
  fs.mkdirSync('./temp/test-media', { recursive: true });
  fs.writeFileSync(f, 'x'.repeat(1024));
  cache.fset('movie:tt123::720', { file: f, sizeMB: 1, title: 'T', quality: 720 });
  assert.ok(cache.fget('movie:tt123::720'));
  assert.equal(cache.fget('movie:gone::720'), null);     // missing file auto-evicts
  const ghost = { file: './temp/test-media/ghost.mp4', sizeMB: 1 };
  cache.fset('ghost', ghost);
  assert.equal(cache.fget('ghost'), null);               // nonexistent file rejected
});

test('persistence: snapshot survives a fresh load', () => {
  cache.mset('persist-meta', { v: 42 });
  cache.lset('persist-link', 'https://x/y.mkv');
  const f = './temp/test-media/persisted.mp4';
  fs.writeFileSync(f, 'z'.repeat(2048));
  cache.fset('persist-file', { file: f, sizeMB: 2, title: 'P', quality: 1080 });

  cache.persist();
  assert.ok(fs.existsSync('./temp/test/cache-store.json'));

  // wipe in-memory state, restore from disk
  _internal.meta.clear(); _internal.links.clear(); _internal.files.clear();
  const restored = _internal.restore();
  assert.ok(restored >= 3);
  assert.deepEqual(cache.mget('persist-meta'), { v: 42 });
  assert.equal(cache.lget('persist-link'), 'https://x/y.mkv');
  assert.ok(cache.fget('persist-file'));
});

test('sweep removes orphan files not in the index', () => {
  const orphan = './temp/test-media/orphan.bin';
  fs.writeFileSync(orphan, 'junk');
  cache.sweep();
  assert.equal(fs.existsSync(orphan), false);            // not indexed → deleted
  assert.ok(fs.existsSync('./temp/test-media/persisted.mp4'));  // indexed → kept
});

test('keyOf format', () => {
  assert.equal(cache.keyOf('tt011', 1, 2, '720'), 'tt011:1:2:720');
  assert.equal(cache.keyOf('tt011', null, null, '1080'), 'tt011:::1080');
});

test('stats shape', () => {
  const s = cache.stats();
  assert.ok(Number.isFinite(s.files) && Number.isFinite(s.meta) && Number.isFinite(s.links));
});
