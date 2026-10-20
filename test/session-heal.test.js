// test/session-heal.test.js — session-health decisions behind the 3.3 Bad-MAC
// auto-repair: stale-vs-fresh classification and the conservative heal trigger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDecryptFail, healDecision, STUB_CIPHERTEXT } from '../src/bot/session-heal.js';

test('ciphertext stub constant matches the Baileys enum value', () => {
  assert.equal(STUB_CIPHERTEXT, 2);
});

test('messages queued before the link are classified stale (harmless replays)', () => {
  const now = Date.now();
  const tenMinOld = { messageTimestamp: Math.floor((now - 10 * 60_000) / 1000) };
  assert.equal(classifyDecryptFail(tenMinOld, now), 'stale');
});

test('messages arriving after the link are classified fresh', () => {
  const now = Date.now();
  const fiveSecAgo = { messageTimestamp: Math.floor((now - 5_000) / 1000) };
  assert.equal(classifyDecryptFail(fiveSecAgo, now), 'fresh');
  // unknown/garbled age must take the safe direction: fresh
  assert.equal(classifyDecryptFail({ messageTimestamp: 0 }, now), 'fresh');
});

test('auto-repair fires only on sustained fresh failures with zero decodes', () => {
  // healthy session: stale noise + messages decoding → never heal
  assert.equal(healDecision({ freshFails: 5, decoded: 3, attempts: 0 }).wipe, false);
  // post-link burst but new messages still decode → keys are fine, no heal
  assert.equal(healDecision({ freshFails: 40, decoded: 4, attempts: 0 }).wipe, false);
  // not enough failures yet → keep waiting
  assert.equal(healDecision({ freshFails: 3, decoded: 0, attempts: 0 }).wipe, false);
  // dead keys: sustained fresh failures, zero decodes → wipe + re-pair
  assert.equal(healDecision({ freshFails: 10, decoded: 0, attempts: 0 }).wipe, true);
});

test('auto-repair is capped: exhausted state asks for the manual fix instead', () => {
  const d = healDecision({ freshFails: 30, decoded: 0, attempts: 2 });
  assert.equal(d.wipe, false);
  assert.equal(d.exhausted, true);
  // and below the cap there is no exhaustion
  const d2 = healDecision({ freshFails: 30, decoded: 0, attempts: 1 });
  assert.equal(d2.wipe, true);
  assert.equal(d2.exhausted, false);
});
