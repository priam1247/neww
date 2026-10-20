// test/queue.test.js — concurrency, fairness, timeouts, positions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobQueue } from '../src/core/queue.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('respects concurrency limit', async () => {
  const q = new JobQueue(2);
  let running = 0, maxRunning = 0;
  const job = async () => {
    running++; maxRunning = Math.max(maxRunning, running);
    await sleep(30);
    running--;
  };
  await Promise.all(Array.from({ length: 6 }, () => q.add('a', 'j', job)));
  assert.ok(maxRunning <= 2, `max running was ${maxRunning}`);
});

test('runs everything and resolves values', async () => {
  const q = new JobQueue(3);
  const out = await Promise.all([1, 2, 3].map(i => q.add('a', `j${i}`, async () => i * 10)));
  assert.deepEqual(out, [10, 20, 30]);
});

test('position() reports queue depth per user', async () => {
  const q = new JobQueue(1);
  const gate = new Promise(r => setTimeout(r, 60));
  const first = q.add('u1', 'slow', () => gate);
  const second = q.add('u1', 'fast', () => 1);
  await sleep(5);
  assert.equal(q.position('u1'), 1);
  await first; await second;
  assert.equal(q.position('u1'), 0);
});

test('job timeout rejects without killing the queue', async () => {
  const q = new JobQueue(1);
  await assert.rejects(
    q.add('u1', 'hang', () => new Promise(() => {}), { timeoutMs: 50 }),
    /timed out/
  );
  const ok = await q.add('u1', 'ok', () => 'fine');
  assert.equal(ok, 'fine');
});

test('per-user fairness cap: nobody starves the queue', async () => {
  const q = new JobQueue(1);
  const order = [];
  // u1 floods 6 jobs, u2 sends 1 — u2 must not wait behind all of them
  const flood = Array.from({ length: 6 }, (_, i) =>
    q.add('u1', `f${i}`, async () => { await sleep(10); order.push(`u1-${i}`); }));
  const late = q.add('u2', 'mine', async () => { order.push('u2'); });
  await Promise.all([...flood, late]);
  assert.ok(order.indexOf('u2') < 5, `u2 ran at position ${order.indexOf('u2')}, order=${order}`);
});

test('errors propagate to the caller', async () => {
  const q = new JobQueue(1);
  await assert.rejects(q.add('u', 'bad', () => { throw new Error('boom'); }), /boom/);
});
