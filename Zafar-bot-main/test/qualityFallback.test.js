/**
 * The quality ladder: when the requested quality has no usable source, the
 * resolver steps down (1080 → 720 → 480) instead of failing the whole command.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'zafar-fallback-test-'));
process.env.TEMP_DIR = path.join(SANDBOX, 'media');
process.env.JOB_DIR = path.join(SANDBOX, 'media');
process.env.CACHE_FILE = path.join(SANDBOX, 'cache.json');
process.env.DATA_DIR = path.join(SANDBOX, 'data');
process.env.MIN_SAMPLE_MB = '0';
process.env.MIN_FREE_MB = '0';
process.env.PROVIDER_TIMEOUT_MS = '2000';
process.env.TIER_TIMEOUT_MS = '3000';
process.env.MOVIE_QUIET = '1';
delete process.env.REALDEBRID_API_KEY;
delete process.env.ALLDEBRID_API_KEY;

const MP4 = Buffer.concat([
  (() => { const b = Buffer.alloc(48); b.writeUInt32BE(32, 0); b.write('ftyp', 4, 'ascii'); b.write('isom', 8, 'ascii'); return b; })(),
  Buffer.alloc(4096, 3),
]);

let server, base;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': MP4.length });
      return res.end();
    }
    const range = req.headers.range;
    if (range) {
      const [a, b] = range.replace('bytes=', '').split('-');
      const start = Number(a) || 0;
      const end = b === '' ? MP4.length - 1 : Number(b);
      const chunk = MP4.subarray(start, end + 1);
      res.writeHead(206, {
        'content-type': 'video/mp4',
        'content-range': `bytes ${start}-${end}/${MP4.length}`,
        'content-length': chunk.length,
      });
      return res.end(chunk);
    }
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': MP4.length });
    res.end(MP4);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(r => server.close(r));
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ignore */ }
});

const enginePath = (p) => new URL(`../engine/${p}`, pathToFileURL(__filename)).href;

/** Register a provider that only answers for one exact quality. */
async function injectOnly480(registry) {
  for (const p of registry.providers) {
    for (let i = 0; i < 4; i++) registry.recordFail(p.id, new Error('test: offline'));
  }
  const p = new registry.Provider({ id: 'only480', tier: 2, kinds: ['direct'], supports: ['movie', 'series'], trust: 2 });
  p.search = async (media, opts) => {
    if (Number(opts.want) !== 480) return [];
    return [{
      provider: 'only480', kind: 'direct', url: `${base}/movie.mp4`,
      title: `${media.title} 480p`, quality: 480, sizeMB: MP4.length / 1048576, seeds: 999,
    }];
  };
  registry.register(p);
}

test('resolveMovie falls back 1080 → 480 and reports the downgrade', async () => {
  const media = await import(enginePath('media/index.js'));
  await injectOnly480(media.registry);

  const item = { source: 'test', type: 'movie', title: 'Fallback Film', year: '2021', imdbId: 'tt1234567' };
  const res = await media.resolveMovie({ item, quality: 1080 });

  assert.equal(res.quality, 480, 'must have stepped down to the only available quality');
  assert.equal(res.requestedQuality, 1080);
  assert.equal(res.downgraded, true);
  assert.match(res.url, /movie\.mp4$/);
});

test('resolveEpisode uses the same ladder for series', async () => {
  const media = await import(enginePath('media/index.js'));
  const item = { source: 'test', type: 'series', title: 'Fallback Show', year: '2022', imdbId: 'tt7654321' };

  const res = await media.resolveEpisode({ item, season: 1, episode: 2, quality: 2160 });
  assert.equal(res.quality, 480);
  assert.equal(res.downgraded, true);
  assert.equal(res.season, 1);
  assert.equal(res.episode, 2);
});

test('a fully unavailable title reports every attempt, not just the last error', async () => {
  const media = await import(enginePath('media/index.js'));
  const registry = media.registry;

  // knock the only-480 provider out and stop the ladder from finding anything
  registry.recordFail('only480', new Error('gone'));
  registry.recordFail('only480', new Error('gone'));
  registry.recordFail('only480', new Error('gone'));
  registry.recordFail('only480', new Error('gone'));

  const item = { source: 'test', type: 'movie', title: 'Nothing At All', year: '1999', imdbId: 'tt0000001' };
  await assert.rejects(
    media.resolveMovie({ item, quality: 1080 }),
    (e) => /no source|no provider|debrid/i.test(e.message)
  );
});
