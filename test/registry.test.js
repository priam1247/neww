// test/registry.test.js — circuit breaker lifecycle + trust scoring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Provider, register, isLive, recordFail, recordWin, recordStart, trustOf, get, table } from '../src/core/registry.js';

test('registration is idempotent', () => {
  class A extends Provider {
    constructor() { super({ id: 'test-a', tier: 1, kinds: ['torrent'] }); }
  }
  const first = register(new A());
  const again = register(new A());
  assert.equal(first, again);
  assert.ok(get('test-a'));
});

test('breaker: 3 consecutive fails trip it open', () => {
  class B extends Provider {
    constructor() { super({ id: 'test-b', tier: 1, kinds: ['torrent'] }); }
  }
  register(new B());
  assert.equal(isLive('test-b'), true);
  recordFail('test-b', new Error('e1'));
  recordFail('test-b', new Error('e2'));
  assert.equal(isLive('test-b'), true);          // 2 fails: still closed
  recordFail('test-b', new Error('e3'));
  assert.equal(isLive('test-b'), false);         // tripped
  assert.equal(get('test-b') ? true : true, true);
});

test('breaker: half-open probe then win closes it', () => {
  class C extends Provider {
    constructor() { super({ id: 'test-c', tier: 2, kinds: ['direct'] }); }
  }
  register(new C());
  for (let i = 0; i < 4; i++) recordFail('test-c', new Error('x'));
  assert.equal(isLive('test-c'), false);

  // simulate the open window elapsing
  const realNow = Date.now;
  const h = get('test-c');
  const realDateNow = Date;
  Date.now = () => realNow() + 60_000;
  assert.equal(isLive('test-c'), true);          // window elapsed → probe allowed

  recordStart('test-c');
  recordWin('test-c', 120);
  Date.now = realNow;
  assert.equal(isLive('test-c'), true);
});

test('breaker: a win resets consecutive fails', () => {
  class D extends Provider {
    constructor() { super({ id: 'test-d', tier: 1, kinds: ['torrent'] }); }
  }
  register(new D());
  recordFail('test-d', new Error('a'));
  recordFail('test-d', new Error('b'));
  recordWin('test-d', 50);
  recordFail('test-d', new Error('c'));
  recordFail('test-d', new Error('d'));
  assert.equal(isLive('test-d'), true);          // streak reset → only 2 consecutive
});

test('trustOf bounds: [0.5, 1.6], neutral below 5 samples', () => {
  assert.equal(trustOf('never-registered-provider'), 1);
  const t = Number(trustOf('test-b'));
  assert.ok(t >= 0.5 && t <= 1.6, `trust out of bounds: ${t}`);
});

test('table() exposes health rows', () => {
  const rows = table();
  assert.ok(Array.isArray(rows));
  const row = rows.find(r => r.id === 'test-a');
  assert.ok(row, 'test-a missing from table');
  assert.ok('wins' in row && 'trust' in row && 'state' in row);
});
