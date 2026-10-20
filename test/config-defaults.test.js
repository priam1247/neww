// test/config-defaults.test.js — the owner's pair/owner numbers are baked in so
// pairing-code login + admin commands work out of the box on a fresh panel deploy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config.js';

test('pairing-code login is preconfigured for the owner number', () => {
  assert.equal(config.pairNumber, '265894016453');
  assert.equal(config.ownerNumber, '265894016453');
});

test('identity defaults are set', () => {
  assert.equal(config.botName, 'ZaFarBot 3.3');
  assert.match(config.prefix, /^\/$/);
  assert.ok(['open', 'whitelist'].includes(config.accessMode));
});

test("the owner's TMDB v3 key is baked in and TorBox support is fully removed", () => {
  assert.match(config.tmdbKey, /^[0-9a-f]{32}$/);
  // TorBox needs a Pro plan — removed entirely in 3.3 (config, providers, docs)
  assert.ok(!('torboxKey' in config), 'torboxKey must not exist in config');
});
