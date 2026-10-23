#!/usr/bin/env node
/**
 * Offline tests for the background-job stack:
 *   utils/persistentJobs.js  — queue, bounds, retry, crash recovery
 *   utils/rcloneStore.js     — inline cutoff, config gating, rclone invocation
 *   utils/providerRouter.js  — routing, DRM refusal, result shape
 *
 * No network, no yt-dlp, no rclone: the engine and the rclone binary are fakes.
 *
 *   node --test scripts/test-provider-core.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-core-'));

process.env.JOBS_DB = path.join(TMP, 'jobs.sqlite');
process.env.MEDIA_DIR = path.join(TMP, 'media');
process.env.JOBS_MIN_FREE_MB = '800';
process.env.INLINE_LIMIT = '104857600';

const jobs = require(path.join(REPO, 'utils/persistentJobs'));
const router = require(path.join(REPO, 'utils/providerRouter'));
const rclone = require(path.join(REPO, 'utils/rcloneStore'));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const onceEvent = (name, timeout = 5000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timed out waiting for "${name}"`)), timeout);
  jobs.once(name, (payload) => {
    clearTimeout(timer);
    resolve(payload);
  });
});

const freshQueue = () => {
  jobs._resetForTests({ removeDb: true });
  jobs._setInspectorForTests(() => ({ effectiveFreeMB: 5000 }));
};

test.after(() => {
  jobs._resetForTests({ removeDb: true });
  router._setEngineForTests(null);
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── persistentJobs ───────────────────────────────────────────────────────────
test('queue runs a job and reports the result', async () => {
  freshQueue();
  jobs.start({
    run: async (provider, req) => ({ provider, title: 'clip', quality: '720p', path: '', size: 42, subs: [], log: req.url }),
    pollMs: 20,
  });
  const done = onceEvent('done');
  const id = jobs.enqueue({ provider: 'generic', req: { url: 'https://example.com/v' } });

  const job = await done;
  assert.strictEqual(job.id, id);
  assert.strictEqual(job.title, 'clip');
  assert.strictEqual(job.req.url, 'https://example.com/v');
  assert.strictEqual(jobs.get(id).status, 'done');
  await jobs.stop();
});

test('one job per provider and two jobs overall', async () => {
  freshQueue();
  const state = { active: 0, peak: 0, queued: [] };
  const run = () => new Promise((resolve) => {
    state.active += 1;
    state.peak = Math.max(state.peak, state.active);
    state.queued.push(() => {
      state.active -= 1;
      resolve({ ok: true });
    });
  });

  jobs.start({ run, pollMs: 10 });
  jobs.enqueue({ provider: 'generic', req: { n: 1 } });
  jobs.enqueue({ provider: 'generic', req: { n: 2 } });
  jobs.enqueue({ provider: 'alpha', req: { n: 3 } });
  jobs.enqueue({ provider: 'beta', req: { n: 4 } });
  await delay(200);

  assert.strictEqual(state.active, 2, 'global concurrency is capped at 2');
  assert.strictEqual(state.peak, 2);
  assert.strictEqual(jobs.stats().running, 2);
  assert.strictEqual(jobs.stats().queued, 2);

  while (state.queued.length) {
    state.queued.shift()();
    await delay(60);
  }
  await jobs.stop();
  assert.strictEqual(jobs.stats().done, 4);
});

test('a failed job is retried once then marked dead', async () => {
  freshQueue();
  let calls = 0;
  jobs.start({ run: async () => { calls += 1; throw new Error('boom'); }, pollMs: 10 });

  const retried = onceEvent('retry');
  const failed = onceEvent('fail');
  const id = jobs.enqueue({ provider: 'generic', req: { url: 'https://example.com/x' } });

  const retry = await retried;
  assert.match(retry.error, /boom/);
  assert.strictEqual(jobs.get(id).status, 'queued');

  const dead = await failed;
  assert.strictEqual(dead.id, id);
  assert.strictEqual(calls, 2, 'exactly one retry');
  assert.strictEqual(jobs.get(id).status, 'dead');
  await jobs.stop();
});

test('enqueue refuses when the disk guard is below its floor', () => {
  freshQueue();
  jobs._setInspectorForTests(() => ({ effectiveFreeMB: 12 }));
  assert.throws(
    () => jobs.enqueue({ provider: 'generic', req: { url: 'https://example.com/x' } }),
    (err) => err.code === 'NOT_ENOUGH_DISK',
  );
  assert.strictEqual(jobs.stats().total, 0);
});

test('enqueue refuses when the queue is full', async () => {
  freshQueue();
  process.env.JOBS_MAX_QUEUED = '1';
  jobs.start({ run: () => new Promise(() => {}), pollMs: 1000 });
  jobs.enqueue({ provider: 'generic', req: { n: 1 } });
  assert.throws(() => jobs.enqueue({ provider: 'generic', req: { n: 2 } }), (err) => err.code === 'QUEUE_FULL');
  delete process.env.JOBS_MAX_QUEUED;
  await jobs.stop({ timeoutMs: 50 });
});

test('interrupted jobs are requeued on boot', async () => {
  freshQueue();
  const id = jobs.enqueue({ provider: 'generic', req: { url: 'https://example.com/resume' } });

  // Simulate a crash: the row is stuck in 'running' with an attempt charged.
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(process.env.JOBS_DB);
  raw.prepare("UPDATE jobs SET status='running', attempts=1, started_at=? WHERE id=?").run(Date.now(), id);
  raw.close();
  jobs._resetForTests();

  jobs.start({ run: async () => ({ ok: true }), pollMs: 10 });
  const done = onceEvent('done');
  const job = await done;
  assert.strictEqual(job.id, id);
  assert.strictEqual(jobs.get(id).status, 'done');
  await jobs.stop();
});

test('unknown providers are rejected instead of guessed', async () => {
  await assert.rejects(() => router.run('netflix', { url: 'https://example.com' }), (err) => err.code === 'UNKNOWN_PROVIDER');
});

// ── rcloneStore ──────────────────────────────────────────────────────────────
test('files under the inline limit are never uploaded', async () => {
  const file = path.join(TMP, 'small.bin');
  fs.writeFileSync(file, 'x'.repeat(16));
  assert.strictEqual(await rclone.put(file, 16), null);
  assert.strictEqual(await rclone.put(file), null);
});

test('oversized files fail loudly without a config file', async () => {
  const file = path.join(TMP, 'big.bin');
  fs.writeFileSync(file, 'x'.repeat(2048));
  const old = { config: process.env.RCLONE_CONFIG, remote: process.env.RCLONE_REMOTE, bin: process.env.RCLONE_BIN };
  process.env.INLINE_LIMIT = '1024';
  process.env.RCLONE_CONFIG = path.join(TMP, 'missing.conf');
  process.env.RCLONE_REMOTE = 'drive';

  await assert.rejects(() => rclone.put(file, 2048), (err) => err.code === 'RCLONE_CONFIG_MISSING');

  Object.assign(process.env, {
    RCLONE_CONFIG: old.config ?? '', RCLONE_REMOTE: old.remote ?? '', RCLONE_BIN: old.bin ?? '',
  });
  process.env.INLINE_LIMIT = '104857600';
});

test('rclone copy + link produce a share URL', async () => {
  const bin = path.join(TMP, 'fake-rclone.sh');
  const calls = path.join(TMP, 'rclone-calls.log');
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\ncase "$1" in\n  copy) exit 0 ;;\n  link) echo "https://drive.example/share/abc"; exit 0 ;;\n  *) exit 1 ;;\nesac\n`);
  fs.chmodSync(bin, 0o755);

  const cfg = path.join(TMP, 'rclone.conf');
  fs.writeFileSync(cfg, '[drive]\ntype = drive\n');
  const file = path.join(TMP, 'movie.mp4');
  fs.writeFileSync(file, 'x'.repeat(4096));

  const old = { bin: process.env.RCLONE_BIN, config: process.env.RCLONE_CONFIG, remote: process.env.RCLONE_REMOTE, p: process.env.RCLONE_PATH };
  process.env.RCLONE_BIN = bin;
  process.env.RCLONE_CONFIG = cfg;
  process.env.RCLONE_REMOTE = 'drive';
  process.env.RCLONE_PATH = 'bot/uploads';
  process.env.INLINE_LIMIT = '1024';

  const link = await rclone.put(file, 4096);
  assert.strictEqual(link, 'https://drive.example/share/abc');

  const log = fs.readFileSync(calls, 'utf8');
  assert.match(log, new RegExp(`copy ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} drive:bot/uploads/ --config`));
  assert.match(log, /link drive:bot\/uploads\/movie\.mp4 --config/);

  const available = rclone.available();
  assert.strictEqual(available.configExists, true);
  assert.strictEqual(available.remote, 'drive');

  Object.assign(process.env, {
    RCLONE_BIN: old.bin ?? '', RCLONE_CONFIG: old.config ?? '', RCLONE_REMOTE: old.remote ?? '', RCLONE_PATH: old.p ?? '',
  });
  process.env.INLINE_LIMIT = '104857600';
});

// ── providerRouter ───────────────────────────────────────────────────────────
test('ordinary links route to the generic provider', () => {
  const target = router.route('https://example.com/watch?v=abc');
  assert.strictEqual(target.provider, 'generic');
  assert.strictEqual(target.blocked, false);
  assert.strictEqual(target.host, 'example.com');

  const nested = router.route('https://www.youtube.com/watch?v=abc');
  assert.strictEqual(nested.provider, 'generic');
  assert.strictEqual(nested.host, 'youtube.com');
});

test('DRM subscription services are refused with a reason', () => {
  const cases = [
    'https://www.netflix.com/watch/80100172',
    'https://www.disneyplus.com/video/abc',
    'https://tv.apple.com/us/show/abc',
    'https://music.apple.com/us/album/abc',
    'https://www.deezer.com/track/123',
    'https://deezer.page.link/abc',
  ];
  for (const url of cases) {
    const target = router.route(url);
    assert.strictEqual(target.blocked, true, `${url} should be blocked`);
    assert.match(target.reason, /DRM-protected/);
  }
  assert.strictEqual(router.route('https://notnetflix.com/watch/1').blocked, false);
});

test('malformed and non-http links are rejected', () => {
  for (const bad of ['not a url', 'ftp://example.com/a.mp4', 'javascript:alert(1)', 'http://localhost/x']) {
    assert.throws(() => router.route(bad), (err) => err.code === 'BAD_URL', bad);
  }
});

test('generic download returns the shared result shape', async () => {
  const out = path.join(TMP, 'media');
  fs.mkdirSync(out, { recursive: true });

  router._setEngineForTests({
    getInfo: async () => ({ title: 'Test Clip' }),
    downloadVideo: async (url, opts) => {
      const file = `${opts.outBase}.mp4`;
      fs.writeFileSync(file, 'x'.repeat(1024));
      return { file };
    },
    run: async () => ({ stdout: '', stderr: '' }),
  });

  const result = await router.run('generic', { url: 'https://example.com/watch?v=abc', height: 480, subs: [] });
  assert.strictEqual(result.provider, 'generic');
  assert.strictEqual(result.title, 'Test Clip');
  assert.strictEqual(result.quality, '480p');
  assert.strictEqual(result.size, 1024);
  assert.ok(fs.existsSync(result.path));
  assert.deepStrictEqual(result.subs, []);
  assert.match(result.log, /start example\.com/);

  await assert.rejects(
    () => router.run('generic', { url: 'https://www.netflix.com/watch/1' }),
    (err) => err.code === 'DRM_UNSUPPORTED',
  );
});
