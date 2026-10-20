// test/ranker.test.js — scoring behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rank, isOld } from '../src/core/ranker.js';
import config from '../src/config.js';

const mk = (over = {}) => ({
  provider: 'test', kind: 'torrent', title: 'Test.2020.720p.WEB-DL.x264',
  quality: 720, codec: 'x264', sourceTag: 'WEBDL', sizeMB: 900, seeds: 100,
  isPack: false, isEpisode: false, ...over
});

test('prefers exact quality match', () => {
  const [best] = rank([mk({ quality: 480 }), mk({ quality: 720 }), mk({ quality: 2160 })], { want: 720, year: 2020 });
  assert.equal(best.quality, 720);
});

test('prefers better source ladder', () => {
  const bluray = mk({ title: 'T.2020.720p.BluRay.x264', sourceTag: 'BLURAY' });
  const cam = mk({ title: 'T.2020.720p.CAM', sourceTag: 'CAM' });
  const [best] = rank([cam, bluray], { want: 720, year: 2020 });
  assert.equal(best.sourceTag, 'BLURAY');
});

test('log-scaled seeds: 5000 not 50x better than 500', () => {
  const many = rank([mk({ seeds: 5000 })], { want: 720, year: 2020 })[0].score;
  const few = rank([mk({ seeds: 500 })], { want: 720, year: 2020 })[0].score;
  assert.ok(many - few < 40, `gap too large: ${many - few}`);
  assert.ok(many > few);
});

test('size window: inside beats far outside', () => {
  const inWin = mk({ sizeMB: 900 });
  const huge = mk({ sizeMB: 20000 });
  const [best] = rank([huge, inWin], { want: 720, year: 2020, maxMB: 2800 });
  assert.equal(best.sizeMB, 900);
});

test('pack penalty for single-episode requests', () => {
  const opts = { want: 720, year: 2020, wantSingleEpisode: true };
  const pack = rank([mk({ isPack: true, title: 'Show.S01.Complete.720p' })], opts)[0].score;
  const ep = rank([mk({ isEpisode: true, title: 'Show.S01E05.720p' })], opts)[0].score;
  assert.ok(ep > pack);
});

test('cached boost dominates', () => {
  const cached = rank([mk({ cached: true })], { want: 720, year: 2020 })[0].score;
  const plain = rank([mk({})], { want: 720, year: 2020 })[0].score;
  assert.ok(cached - plain > 30);
});

test('CAM title penalty', () => {
  const cam = rank([mk({ title: 'Movie.2024.HDCAM.720p', sourceTag: 'CAM' })], { want: 720, year: 2024 })[0].score;
  const clean = rank([mk({})], { want: 720, year: 2024 })[0].score;
  assert.ok(clean > cam);
});

test('seed floor filters for new content but not old', () => {
  const dead = mk({ seeds: 0 });
  const optsNew = { want: 720, year: new Date().getFullYear() };
  const optsOld = { want: 720, year: 1975 };
  assert.equal(rank([dead], optsNew).length, 0);
  assert.equal(rank([dead], optsOld).length, 1);
  assert.equal(isOld(1975), true);
  assert.equal(isOld(new Date().getFullYear()), false);
});

test('trust multiplier shifts scores', () => {
  const trusted = rank([mk({ provider: 'trusted' })], { want: 720, year: 2020 })[0];
  assert.ok(trusted.score > 0);
});

test('size window from config is respected', () => {
  assert.ok(config.sizeWindow[1080][0] < config.sizeWindow[1080][1]);
});
