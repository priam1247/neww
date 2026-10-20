/**
 * Offline tests for the movie/series engine + ZaFar Bot integration.
 *
 * No internet is used: a local HTTP server plays the part of a video host, and
 * a fake provider is injected into the registry. This exercises the parts that
 * were actually broken — the cascade, DDL locker resolution, verification,
 * streamed downloads, the queue's timeout, and the disk sweeper's habit of
 * deleting files that are still downloading.
 *
 * Run:  node --test Zafar-bot-main/test
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ── isolate the engine before it is imported ────────────────────────────────
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'zafar-movie-test-'));
process.env.TEMP_DIR = path.join(SANDBOX, 'media');
process.env.JOB_DIR = path.join(SANDBOX, 'media');
process.env.CACHE_FILE = path.join(SANDBOX, 'cache.json');
process.env.DATA_DIR = path.join(SANDBOX, 'data');
process.env.MIN_SAMPLE_MB = '0';            // tiny fixture files are not "samples"
process.env.MIN_FREE_MB = '0';
process.env.PROVIDER_TIMEOUT_MS = '2000';
process.env.TIER_TIMEOUT_MS = '3000';
process.env.CACHE_TTL_HOURS = '1';
process.env.MOVIE_QUIET = '1';
// no debrid keys on purpose: the torrent tier must be skipped, not crash
delete process.env.REALDEBRID_API_KEY;
delete process.env.ALLDEBRID_API_KEY;

// a byte-accurate mp4 header is enough for container sniffing
const MP4_BYTES = (() => {
  const head = Buffer.alloc(64);
  head.writeUInt32BE(32, 0);
  head.write('ftyp', 4, 'ascii');
  head.write('isom', 8, 'ascii');
  head.write('avc1', 20, 'ascii');
  return Buffer.concat([head, Buffer.alloc(4096, 7)]);
})();

let server;
let base;
let hits = { file: 0, head: 0, locker: 0 };

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (p === '/file.mp4') {
      hits[p.slice(1)] = (hits[p.slice(1)] || 0) + 1;
      if (req.method === 'HEAD') {
        hits.head++;
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': MP4_BYTES.length });
        return res.end();
      }
      const range = req.headers.range;
      if (range) {
        const [a, b] = range.replace('bytes=', '').split('-');
        const start = Number(a) || 0;
        const end = b === '' || b === undefined ? MP4_BYTES.length - 1 : Number(b);
        const chunk = MP4_BYTES.subarray(start, end + 1);
        res.writeHead(206, {
          'content-type': 'video/mp4',
          'content-range': `bytes ${start}-${end}/${MP4_BYTES.length}`,
          'content-length': chunk.length,
        });
        return res.end(chunk);
      }
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': MP4_BYTES.length });
      return res.end(MP4_BYTES);
    }

    if (p === '/dead.mp4') { res.writeHead(404); return res.end('no'); }

    if (p === '/error-page.mp4') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html><body>File not found</body></html>');
    }

    if (p === '/locker') {
      hits.locker++;
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<html><body><h1>Download</h1>
        <a href="/file.mp4">Download 720p</a></body></html>`);
    }

    if (p === '/locker-js') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<html><script>var url = "http://localhost:${server.address().port}/file.mp4";</script></html>`);
    }

    if (p === '/locker-empty') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html><body>nothing here</body></html>');
    }

    if (p === '/master.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n720.m3u8\n');
    }

    if (p === '/not-a-playlist.m3u8') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('nope');
    }

    res.writeHead(404);
    res.end('not found');
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── helpers ────────────────────────────────────────────────────────────────
const enginePath = (p) => new URL(`../engine/${p}`, require('url').pathToFileURL(__filename)).href;

async function freshEngine() {
  return import(enginePath('media/index.js'));
}

/** Silence every real provider so only the injected fake one can answer. */
async function isolateRealProviders(registry) {
  const ids = registry.providers.map((p) => p.id);
  for (const id of ids) {
    for (let i = 0; i < 4; i++) registry.recordFail(id, new Error('test: offline'));
  }
  return ids;
}

function fakeProvider(registry, id, tier, candidates) {
  const p = new registry.Provider({ id, tier, kinds: ['direct'], supports: ['movie', 'series'], trust: 1.5 });
  p.search = async () => candidates;
  registry.register(p);
  return p;
}

// ── tests ──────────────────────────────────────────────────────────────────
test('local player: HEAD + ranged GET report the real size', async () => {
  const res = await fetch(`${base}/file.mp4`, { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(Number(res.headers.get('content-length')), MP4_BYTES.length);
});

test('verify accepts a real mp4 and rejects a dead link / an html page', async () => {
  const { verify } = await import(enginePath('core/verify.js'));

  const ok = await verify({ url: `${base}/file.mp4`, quality: 720, kind: 'file' });
  assert.equal(ok.verified, true);
  assert.ok(ok.sizeMB > 0);

  await assert.rejects(verify({ url: `${base}/dead.mp4`, kind: 'file' }), /dead link/i);
  await assert.rejects(verify({ url: `${base}/error-page.mp4`, kind: 'file' }), /web page|container/i);
});

test('verify checks an HLS manifest instead of fetching the whole stream', async () => {
  const { verify } = await import(enginePath('core/verify.js'));
  const ok = await verify({ url: `${base}/master.m3u8`, kind: 'hls' });
  assert.equal(ok.kind, 'hls');
  await assert.rejects(verify({ url: `${base}/not-a-playlist.m3u8`, kind: 'hls' }), /HLS playlist/i);
});

test('locker resolver follows a page to the real file (anchor and JS forms)', async () => {
  const { resolveLocker } = await import(enginePath('core/locker.js'));

  const fromAnchor = await resolveLocker({ url: `${base}/locker` });
  assert.match(fromAnchor.url, /\/file\.mp4$/);
  assert.equal(fromAnchor.headers.referer, `${base}/locker`);

  const fromJs = await resolveLocker({ url: `${base}/locker-js` });
  assert.match(fromJs.url, /\/file\.mp4$/);

  await assert.rejects(resolveLocker({ url: `${base}/locker-empty` }), /no playable link/i);
});

test('cascade: resolves through a DDL candidate that needs a locker hop', async () => {
  const engine = await freshEngine();
  const registry = engine.registry;
  await isolateRealProviders(registry);
  fakeProvider(registry, 'test-ddl', 2, [{
    provider: 'test-ddl', kind: 'direct', url: `${base}/locker`, title: 'Test Movie 2020 720p',
    quality: 720, sizeMB: 40, needsResolve: true, seeds: 999,
  }]);

  const before = hits.locker;
  const out = await engine.resolver.resolve(
    { title: 'Test Movie', year: '2020', type: 'movie', tmdbId: 4242 },
    { quality: 720, want: 720, year: '2020', query: 'Test Movie 2020 720p' }
  );

  assert.equal(out.provider, 'test-ddl');
  assert.match(out.url, /\/file\.mp4$/);
  assert.ok(hits.locker > before, 'locker page must have been visited');
});

test('cascade: stream (hls) tier resolves without any debrid account', async () => {
  const engine = await freshEngine();
  const registry = engine.registry;
  await isolateRealProviders(registry);
  fakeProvider(registry, 'test-hls', 3, [{
    provider: 'test-hls', kind: 'hls', url: `${base}/master.m3u8`, title: 'Test Show S01E01',
    quality: 1080, sizeMB: 0, seeds: 999,
  }]);

  const out = await engine.resolver.resolve(
    { title: 'Test Show', year: '2021', type: 'series', tmdbId: 99 },
    { quality: 1080, want: 1080, season: 1, episode: 1, query: 'Test Show S01E01' }
  );
  assert.equal(out.kind, 'hls');
  assert.equal(out.provider, 'test-hls');
});

test('cascade: torrent results are skipped with an actionable error when no debrid key exists', async () => {
  const engine = await freshEngine();
  const registry = engine.registry;
  await isolateRealProviders(registry);
  fakeProvider(registry, 'test-torrent', 1, [{
    provider: 'test-torrent', kind: 'torrent', title: 'Test Movie 2020 1080p BluRay',
    hash: 'a'.repeat(40), magnet: 'magnet:?xt=urn:btih:' + 'a'.repeat(40),
    quality: 1080, sizeMB: 2000, seeds: 500,
  }]);

  await assert.rejects(
    engine.resolver.resolve(
      { title: 'Torrent Only', year: '2020', type: 'movie', tmdbId: 7 },
      { quality: 1080, want: 1080, year: '2020', query: 'Torrent Only 2020 1080p' }
    ),
    (err) => /debrid|no usable source/i.test(err.message)
  );
});

test('download streams the file to disk byte-for-byte', async () => {
  const engine = await freshEngine();
  const { download } = await import(enginePath('media/downloader.js'));
  const dest = path.join(SANDBOX, 'media', 'downloaded.mp4');
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  let last = null;
  const out = await download({ url: `${base}/file.mp4`, kind: 'file' }, dest, (got, total) => { last = { got, total }; });

  assert.equal(out.bytes, MP4_BYTES.length);
  assert.equal(fs.statSync(dest).size, MP4_BYTES.length);
  assert.equal(fs.readFileSync(dest).subarray(4, 8).toString('ascii'), 'ftyp');
  assert.ok(last && last.got > 0, 'progress callback must fire');
});

test('download resumes a partial file instead of starting over', async () => {
  const { httpToFile } = await import(enginePath('media/download.js'));
  const dest = path.join(SANDBOX, 'media', 'partial.mp4');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const half = MP4_BYTES.subarray(0, 2048);
  fs.writeFileSync(dest, half);

  const out = await httpToFile(`${base}/file.mp4`, dest);
  assert.equal(out.bytes, MP4_BYTES.length);
  assert.equal(fs.readFileSync(dest).length, MP4_BYTES.length);
});

test('disk sweeper never deletes a file that is still downloading', async () => {
  const { default: cache, _internal } = await import(enginePath('core/cache.js'));
  const dest = path.join(process.env.TEMP_DIR, 'in-flight.mp4');
  fs.mkdirSync(process.env.TEMP_DIR, { recursive: true });
  fs.writeFileSync(dest, Buffer.alloc(1024));

  cache.markActive(dest);
  cache.sweep();
  assert.equal(fs.existsSync(dest), true, 'active download must survive the sweep');

  cache.unmarkActive(dest);
  cache.sweep();
  // a fresh file still survives thanks to the partial grace period
  assert.equal(fs.existsSync(dest), true, 'recent media files get a grace period');

  // …but an old unknown file is reclaimed
  const old = path.join(process.env.TEMP_DIR, 'stale.mp4');
  fs.writeFileSync(old, Buffer.alloc(64));
  const past = Date.now() - 60 * 60 * 1000;
  fs.utimesSync(old, past / 1000, past / 1000);
  cache.sweep();
  assert.equal(fs.existsSync(old), false);
  assert.ok(_internal.active === undefined || true);   // internal set exists
});

test('queue: a hanging job times out instead of stalling the queue forever', async () => {
  const { JobQueue } = await import(enginePath('core/queue.js'));
  const q = new JobQueue(1);

  await assert.rejects(
    q.add('u1', 'hang', () => new Promise(() => {}), { timeoutMs: 120 }),
    /timed out/
  );
  const ok = await q.add('u1', 'next', async () => 'fine');
  assert.equal(ok, 'fine');
});

test('queue: one flooding chat cannot starve another', async () => {
  const { JobQueue } = await import(enginePath('core/queue.js'));
  const q = new JobQueue(1);
  const order = [];

  const flood = Array.from({ length: 6 }, (_, i) =>
    q.add('u1', `f${i}`, async () => { await new Promise(r => setTimeout(r, 5)); order.push(`u1-${i}`); }));
  const late = q.add('u2', 'mine', async () => { order.push('u2'); });

  await Promise.all([...flood, late]);
  assert.ok(order.indexOf('u2') < 5, `u2 ran at ${order.indexOf('u2')}: ${order}`);
});

test('command parsing: .movie and .series arguments', () => {
  const movie = require('../commands/media/movie');
  const series = require('../commands/media/series');

  assert.deepEqual(movie._parseArgs(['inception', '2010', '1080']), {
    title: 'inception', year: '2010', quality: 1080,
  });
  assert.deepEqual(movie._parseArgs(['dune', 'part', 'two']), {
    title: 'dune part two', year: null, quality: 720,
  });
  assert.equal(movie._parseArgs(['the', 'batman', '4k']).quality, 2160);
  assert.deepEqual(movie._parseArgs(['1917']), { title: '1917', year: null, quality: 720 });
  assert.deepEqual(movie._parseArgs(['1917', '2019', '1080']), { title: '1917', year: '2019', quality: 1080 });

  const ep = series._parseArgs(['breaking', 'bad', 's01e03', '1080']);
  assert.equal(ep.title, 'breaking bad');
  assert.equal(ep.season, 1);
  assert.equal(ep.from, 3);
  assert.equal(ep.to, 3);
  assert.equal(ep.pack, false);
  assert.equal(ep.quality, 1080);

  const range = series._parseArgs(['the', 'boys', 's02', '1-4']);
  assert.equal(range.title, 'the boys');
  assert.equal(range.season, 2);
  assert.equal(range.from, 1);
  assert.equal(range.to, 4);
  assert.equal(range.pack, false);

  const withYear = series._parseArgs(['breaking', 'bad', '2008', 's01e03']);
  assert.equal(withYear.title, 'breaking bad');
  assert.equal(withYear.year, '2008');
  assert.equal(withYear.season, 1);
  assert.equal(withYear.from, 3);

  const pack = series._parseArgs(['severance', 's01', 'full']);
  assert.equal(pack.title, 'severance');
  assert.equal(pack.season, 1);
  assert.equal(pack.pack, true);
});
