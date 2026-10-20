// test/tv.test.js — series request parsing + pack file selection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSeriesRequest, parseEpisode, parseRange, pickEpisodeFile, episodeQuery, seasonQuery } from '../src/core/tv.js';

test('parseEpisode variants', () => {
  assert.deepEqual(parseEpisode('show s01e05'), { season: 1, episode: 5 });
  assert.deepEqual(parseEpisode('show 1x05'), { season: 1, episode: 5 });
  assert.deepEqual(parseEpisode('show s2 e10'), { season: 2, episode: 10 });
  assert.deepEqual(parseEpisode('show s01_e05'), { season: 1, episode: 5 });
  assert.equal(parseEpisode('no episode here'), null);
});

test('parseRange flips reversed ranges', () => {
  assert.deepEqual(parseRange('range 3-6'), { from: 3, to: 6 });
  assert.deepEqual(parseRange('range 9-4'), { from: 4, to: 9 });
  assert.equal(parseRange('no range'), null);
});

test('parseSeriesRequest: single episode', () => {
  const r = parseSeriesRequest('breaking bad s02e05');
  assert.equal(r.title, 'breaking bad');
  assert.equal(r.season, 2);
  assert.equal(r.epStart, 5);
  assert.equal(r.epEnd, 5);
  assert.equal(r.full, false);
});

test('parseSeriesRequest: range with season', () => {
  const r = parseSeriesRequest('friends s03 range 1-4');
  assert.equal(r.season, 3);
  assert.equal(r.epStart, 1);
  assert.equal(r.epEnd, 4);
  assert.ok(r.title.includes('friends'));
  assert.ok(!/\brange\b/.test(r.title));
});

test('parseSeriesRequest: full season', () => {
  const r = parseSeriesRequest('got s04 full');
  assert.equal(r.season, 4);
  assert.equal(r.full, true);
  assert.ok(r.title.includes('got'));
});

test('episodeQuery formats for indexers', () => {
  assert.equal(episodeQuery('Breaking Bad', '2008', 1, 5), 'Breaking Bad 2008 S01E05');
  assert.equal(seasonQuery('Breaking Bad', '2008', 2), 'Breaking Bad 2008 S02');
});

test('pickEpisodeFile: exact SxxExy match inside a pack', () => {
  const files = [
    { path: 'Show.S01E01.720p.mkv' },
    { path: 'Show.S01E02.720p.mkv' },
    { path: 'Show.S01E03.720p.mkv' }
  ];
  const pick = pickEpisodeFile(files, 1, 2);
  assert.equal(pick.path, 'Show.S01E02.720p.mkv');
});

test('pickEpisodeFile: filters samples/junk', () => {
  const files = [
    { path: 'sample.mkv' },
    { path: 'Show.S01E01.1080p.mkv' },
    { path: 'trailer.mp4' }
  ];
  const pick = pickEpisodeFile(files, 1, 1);
  assert.ok(pick && pick.path.includes('S01E01'));
});

test('pickEpisodeFile: absolute numbering fallback (anime)', () => {
  const files = [
    { path: '[Group] Anime Name - 07 [1080p].mkv' },
    { path: '[Group] Anime Name - 08 [1080p].mkv' }
  ];
  const pick = pickEpisodeFile(files, 1, 7);
  assert.ok(pick.path.includes('- 07') || pick.path.includes('08'));
  // must pick one of the two, never null
  assert.ok(pick);
});

test('pickEpisodeFile: ordered fallback by index', () => {
  const files = [
    { path: 'Episode.A.mkv' }, { path: 'Episode.B.mkv' }, { path: 'Episode.C.mkv' }
  ];
  const pick = pickEpisodeFile(files, 9, 2);      // season 9 nonsense → ordered fallback
  assert.ok(pick);                                 // returns something sane, never throws
});

test('pickEpisodeFile: empty/ junk-only lists', () => {
  assert.equal(pickEpisodeFile([], 1, 1), null);
  assert.equal(pickEpisodeFile([{ path: 'sample.mkv' }, { path: 'poster.jpg' }], 1, 1), null);
});
