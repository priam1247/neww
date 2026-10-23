/**
 * ZaFar Bot — persistent job store + worker pool
 *
 * The lanes in utils/jobQueue.js live in RAM: a panel restart forgets every
 * queued download. This store keeps accepted jobs in `database/jobs.sqlite`
 * (node:sqlite, built into Node 22) so a restart resumes them instead.
 *
 * Guarantees
 *   • bounded concurrency — 2 jobs overall, 1 per provider (both configurable)
 *   • disk-aware — `enqueue()` refuses when utils/diskSpace.js reports less
 *     than JOBS_MIN_FREE_MB of folder budget left
 *   • crash recovery — rows stuck in 'running' are reset to 'queued' on start()
 *   • one retry — a failed attempt is requeued once, then marked 'dead'
 *
 * Events
 *   'queued' { id, provider }                    accepted
 *   'retry'  { id, provider, error, attempt }    first failure, requeued
 *   'done'   { id, provider, req, ...result }    finished
 *   'fail'   { id, provider, req, error }        terminal (dead)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const diskSpace = require('./diskSpace');
const log = require('./logger')('jobs');

const BOT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DB = path.join(BOT_ROOT, 'database', 'jobs.sqlite');
const MAX_ATTEMPTS = 2;               // first run + one retry
const PROVIDER_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

let db = null;
let dbFile = null;
let inspector = (dir) => diskSpace.inspectDisk(dir);
let runner = null;
let timer = null;
let running = false;
const inflight = new Set();

// ── configuration (read per call so .env / panel changes apply on restart) ───
const intEnv = (name, fallback, min = 0) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
};
const minFreeMB = () => intEnv('JOBS_MIN_FREE_MB', 800);
const maxQueued = () => intEnv('JOBS_MAX_QUEUED', 50, 1);
const maxHeavy = () => intEnv('JOBS_MAX_CONCURRENT', 2, 1);
const maxPerProvider = () => intEnv('JOBS_MAX_PER_PROVIDER', 1, 1);
const dbPath = () => String(process.env.JOBS_DB || DEFAULT_DB);

// ── connection ───────────────────────────────────────────────────────────────
function openDb() {
  const file = path.resolve(dbPath());
  if (db && dbFile === file) return db;
  closeDb();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // node:sqlite is flagged experimental on Node 22; import lazily so the rest
  // of the bot boots even if a future runtime drops it. The experimental
  // warning is silenced for the length of the require — it would otherwise be
  // printed on every panel restart.
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    if (String(warning).includes('SQLite is an experimental feature')) return;
    return originalEmitWarning.call(process, warning, ...rest);
  };
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } finally {
    process.emitWarning = originalEmitWarning;
  }
  db = new DatabaseSync(file);
  dbFile = file;
  try { db.exec('PRAGMA busy_timeout = 5000'); } catch { /* older builds */ }
  try { db.exec('PRAGMA journal_mode = WAL'); } catch { /* fs without WAL */ }
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      provider    TEXT    NOT NULL,
      req         TEXT    NOT NULL,
      status      TEXT    NOT NULL DEFAULT 'queued',
      attempts    INTEGER NOT NULL DEFAULT 0,
      result      TEXT,
      error       TEXT,
      created_at  INTEGER NOT NULL,
      started_at  INTEGER,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status, id);
  `);
  return db;
}

function closeDb() {
  if (!db) return;
  try { db.close(); } catch { /* already closed */ }
  db = null;
  dbFile = null;
}

const parse = (raw, fallback) => {
  try { return JSON.parse(raw); } catch { return fallback; }
};

function rowToJob(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    provider: row.provider,
    req: parse(row.req, {}),
    status: row.status,
    attempts: Number(row.attempts) || 0,
    result: row.result ? parse(row.result, null) : null,
    error: row.error || null,
    createdAt: Number(row.created_at),
    startedAt: row.started_at == null ? null : Number(row.started_at),
    finishedAt: row.finished_at == null ? null : Number(row.finished_at),
  };
}

// ── admission ────────────────────────────────────────────────────────────────
function assertDiskSpace() {
  let info;
  try { info = inspector(BOT_ROOT); } catch { return; }   // guard never blocks on a broken probe
  const free = info?.effectiveFreeMB;
  if (Number.isFinite(free) && free < minFreeMB()) {
    throw Object.assign(
      new Error(`not enough disk: ${free.toFixed(0)} MB free, need ${minFreeMB()} MB`),
      { code: 'NOT_ENOUGH_DISK', freeMB: free, requiredMB: minFreeMB() },
    );
  }
}

function assertQueueRoom() {
  const row = openDb().prepare(
    "SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')",
  ).get();
  const pending = Number(row?.n) || 0;
  if (pending >= maxQueued()) {
    throw Object.assign(new Error(`queue full (${pending} pending)`), { code: 'QUEUE_FULL', pending });
  }
}

/**
 * Accept a job. Throws synchronously (NOT_ENOUGH_DISK / QUEUE_FULL) so the
 * caller can tell the user before promising work.
 *
 * @param {{provider: string, req: object}} job
 * @returns {number} job id
 */
function enqueue({ provider, req } = {}) {
  const name = String(provider || '').trim();
  if (!PROVIDER_RE.test(name)) throw new TypeError(`invalid provider: ${provider}`);
  if (!req || typeof req !== 'object' || Array.isArray(req)) throw new TypeError('req must be an object');

  let payload;
  try { payload = JSON.stringify(req); } catch { throw new TypeError('req must be JSON-serialisable'); }

  assertDiskSpace();
  assertQueueRoom();

  const info = openDb().prepare(
    "INSERT INTO jobs (provider, req, status, attempts, created_at) VALUES (?, ?, 'queued', 0, ?)",
  ).run(name, payload, Date.now());

  const id = Number(info.lastInsertRowid);
  emitter.emit('queued', { id, provider: name });
  if (running) setImmediate(tick);
  return id;
}

// ── worker pool ──────────────────────────────────────────────────────────────
function defaultRunner(provider, req) {
  const router = require('./providerRouter');
  return router.run(provider, req);
}

/** Reset anything a previous process left mid-flight. */
function recover() {
  const res = openDb().prepare(
    "UPDATE jobs SET status='queued', started_at=NULL WHERE status='running'",
  ).run();
  const n = Number(res.changes) || 0;
  if (n) log.warn(`requeued ${n} job(s) interrupted by the last shutdown`);
  return n;
}

function claimNext(perProvider, active) {
  const dbc = openDb();
  const rows = dbc.prepare(
    "SELECT id, provider FROM jobs WHERE status='queued' ORDER BY id LIMIT 200",
  ).all();

  for (const row of rows) {
    if ((perProvider.get(row.provider) || 0) >= maxPerProvider()) continue;
    const res = dbc.prepare(
      "UPDATE jobs SET status='running', started_at=?, attempts=attempts+1 WHERE id=? AND status='queued'",
    ).run(Date.now(), row.id);
    if (Number(res.changes) !== 1) continue;      // another process won the row
    perProvider.set(row.provider, (perProvider.get(row.provider) || 0) + 1);
    return { id: Number(row.id), provider: row.provider, active: active + 1 };
  }
  return null;
}

function tick() {
  if (!running) return;
  try {
    const dbc = openDb();
    const perProvider = new Map();
    for (const row of dbc.prepare(
      "SELECT provider, COUNT(*) AS n FROM jobs WHERE status='running' GROUP BY provider",
    ).all()) {
      perProvider.set(row.provider, Number(row.n) || 0);
    }
    let active = [...perProvider.values()].reduce((a, b) => a + b, 0);

    while (active < maxHeavy()) {
      const claimed = claimNext(perProvider, active);
      if (!claimed) break;
      active = claimed.active;
      launch(claimed.id);
    }
  } catch (err) {
    log.error('scheduler tick failed:', err.message);
  }
}

function launch(id) {
  const job = get(id);
  if (!job) return;

  const work = Promise.resolve()
    .then(() => (runner || defaultRunner)(job.provider, job.req))
    .then((result) => succeed(job, result))
    .catch((err) => fail(job, err))
    .finally(() => {
      inflight.delete(work);
      if (running) setImmediate(tick);
    });

  inflight.add(work);
}

function succeed(job, result) {
  const payload = result && typeof result === 'object' ? result : { value: result };
  let encoded;
  try { encoded = JSON.stringify(payload); } catch { encoded = JSON.stringify({ error: 'unserialisable result' }); }

  openDb().prepare(
    "UPDATE jobs SET status='done', result=?, error=NULL, finished_at=? WHERE id=?",
  ).run(encoded, Date.now(), job.id);

  const out = { ...payload, id: job.id, provider: job.provider, req: job.req };
  log.info(`#${job.id} ${job.provider} done`);
  emitter.emit('done', out);
  return out;
}

function fail(job, err) {
  const message = String(err?.message || err || 'job failed').slice(0, 2000);

  if (job.attempts < MAX_ATTEMPTS) {
    openDb().prepare(
      "UPDATE jobs SET status='queued', error=?, started_at=NULL WHERE id=?",
    ).run(message, job.id);
    log.warn(`#${job.id} ${job.provider} failed (attempt ${job.attempts}/${MAX_ATTEMPTS}), requeued: ${message}`);
    emitter.emit('retry', { id: job.id, provider: job.provider, req: job.req, error: message, attempt: job.attempts });
    return;
  }

  openDb().prepare(
    "UPDATE jobs SET status='dead', error=?, finished_at=? WHERE id=?",
  ).run(message, Date.now(), job.id);
  log.error(`#${job.id} ${job.provider} dead after ${job.attempts} attempts: ${message}`);
  emitter.emit('fail', { id: job.id, provider: job.provider, req: job.req, error: message, attempts: job.attempts });
}

/**
 * Start the pool. Safe to call twice.
 *
 * @param {{run?: (provider: string, req: object) => Promise<any>, pollMs?: number}} opts
 */
function start(opts = {}) {
  if (typeof opts.run === 'function') runner = opts.run;
  if (running) return api;

  running = true;
  recover();
  tick();

  const pollMs = Number(opts.pollMs) > 0 ? Number(opts.pollMs) : 1000;
  timer = setInterval(tick, pollMs);
  timer.unref?.();
  log.info(`worker pool started (max ${maxHeavy()} concurrent, ${maxPerProvider()} per provider)`);
  return api;
}

/** Stop claiming work and wait briefly for in-flight jobs. */
async function stop({ timeoutMs = 5000 } = {}) {
  running = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (!inflight.size) return;
  let timeout;
  await Promise.race([
    Promise.allSettled([...inflight]),
    new Promise((resolve) => { timeout = setTimeout(resolve, timeoutMs); timeout.unref?.(); }),
  ]);
  clearTimeout(timeout);
}

// ── inspection ───────────────────────────────────────────────────────────────
function get(id) {
  return rowToJob(openDb().prepare('SELECT * FROM jobs WHERE id=?').get(Number(id)));
}

function list({ status = null, limit = 50 } = {}) {
  const n = Math.max(1, Math.min(500, Number(limit) || 50));
  const rows = status
    ? openDb().prepare('SELECT * FROM jobs WHERE status=? ORDER BY id DESC LIMIT ?').all(String(status), n)
    : openDb().prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT ?').all(n);
  return rows.map(rowToJob);
}

function stats() {
  const out = { queued: 0, running: 0, done: 0, dead: 0, total: 0 };
  for (const row of openDb().prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all()) {
    const n = Number(row.n) || 0;
    if (Object.hasOwn(out, row.status)) out[row.status] = n;
    out.total += n;
  }
  return out;
}

// ── test hooks ───────────────────────────────────────────────────────────────
function _setInspectorForTests(fn) {
  inspector = typeof fn === 'function' ? fn : (dir) => diskSpace.inspectDisk(dir);
}

function _resetForTests({ removeDb = false } = {}) {
  running = false;
  if (timer) { clearInterval(timer); timer = null; }
  inflight.clear();
  runner = null;
  inspector = (dir) => diskSpace.inspectDisk(dir);
  const file = dbFile;
  closeDb();
  if (removeDb && file) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(`${file}${suffix}`, { force: true }); } catch { /* ignore */ }
    }
  }
  emitter.removeAllListeners();
}

const api = {
  enqueue,
  start,
  stop,
  get,
  list,
  stats,
  recover,
  on: (event, fn) => { emitter.on(event, fn); return api; },
  once: (event, fn) => { emitter.once(event, fn); return api; },
  off: (event, fn) => { emitter.off(event, fn); return api; },
  isRunning: () => running,
  _setInspectorForTests,
  _resetForTests,
  MAX_ATTEMPTS,
  DB_PATH: DEFAULT_DB,
};

module.exports = api;
