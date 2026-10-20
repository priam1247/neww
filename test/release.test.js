// test/release.test.js — release-name parser (incl. the 2.0 language bug).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRelease, matchesEpisode, qualityOf } from '../src/core/release.js';

test('quality detection', () => {
  assert.equal(qualityOf('Movie.2021.1080p.BluRay.x265'), 1080);
  assert.equal(qualityOf('Movie.2021.2160p.WEB-DL'), 2160);
  assert.equal(qualityOf('Movie.2021.4K.HDR'), 2160);
  assert.equal(qualityOf('no quality here'), 0);
});

test('codec detection', () => {
  assert.equal(parseRelease('Show.S01.720p.x265-GROUP').codec, 'x265');
  assert.equal(parseRelease('Show.S01.720p.HEVC-GROUP').codec, 'x265');
  assert.equal(parseRelease('Show.S01.720p.x264-GROUP').codec, 'x264');
  assert.equal(parseRelease('Show.S01.720p.AV1-GROUP').codec, 'av1');
  assert.equal(parseRelease('Show.S01.720p-GROUP').codec, null);
});

test('source ladder', () => {
  assert.equal(parseRelease('Film.2010.1080p.BluRay.x264').sourceTag, 'BLURAY');
  assert.equal(parseRelease('Film.2010.1080p.REMUX').sourceTag, 'REMUX');
  assert.equal(parseRelease('Film.2010.1080p.WEB-DL').sourceTag, 'WEBDL');
  assert.equal(parseRelease('Film.2010.HDTV.x264').sourceTag, 'HDTV');
  assert.equal(parseRelease('Film.2024.CAM.x264').sourceTag, 'CAM');
  assert.equal(parseRelease('Film.2010.1080p').sourceTag, 'UNKNOWN');
});

test('network tags', () => {
  assert.equal(parseRelease('Show.S01E01.1080p.NF.WEB-DL').network, 'NF');
  assert.equal(parseRelease('Show.S01E01.1080p.DSNP.WEB-DL').network, 'DSNP');
});

test('audio tags', () => {
  const r = parseRelease('Film.1080p.DDP5.1.Atmos.x264');
  assert.ok(r.audio.includes('dd51'));
  assert.ok(r.audio.includes('atmos'));
});

// THE 2.0 BUG: '\bHINDI\b' in a JS string is backspace chars — never matched.
// 3.0 uses real \b regexes: Hindi/Tamil/etc must be detected now.
test('language detection (2.0 regression)', () => {
  assert.deepEqual(parseRelease('Movie.2023.1080p.Hindi.WEB-DL').langs, ['hi']);
  assert.ok(parseRelease('Movie.2023.1080p.Tamil.x264').langs.includes('ta'));
  assert.ok(parseRelease('Movie.2023.1080p.TRUEFRENCH.x264').langs.includes('fr'));
  assert.ok(parseRelease('Movie.2023.1080p.DUBLADO.x264').langs.includes('pt'));
  assert.deepEqual(parseRelease('Movie.2023.1080p.x264').langs, []);
});

test('group extraction', () => {
  assert.equal(parseRelease('Film.2020.1080p.WEB-DL.DDP5.1.H.264-EVO').group, 'EVO');
  assert.equal(parseRelease('Show.S01E01.720p.x264-RARBG').group, 'RARBG');
});

test('SxxExy variants', () => {
  assert.deepEqual(
    { s: parseRelease('Show.S01E05.720p').season, e: parseRelease('Show.S01E05.720p').episode },
    { s: 1, e: 5 }
  );
  const r2 = parseRelease('Show.1x05.720p');
  assert.equal(r2.season, 1); assert.equal(r2.episode, 5);
  const r3 = parseRelease('Show.Season.2.Episode.7.720p');
  assert.equal(r3.season, 2); assert.equal(r3.episode, 7);
});

test('multi-episode ranges S01E05-E06', () => {
  const r = parseRelease('Show.S01E05-E06.720p.WEB-DL');
  assert.equal(r.episode, 5);
  assert.equal(r.endEpisode, 6);
});

test('absolute episode numbering (anime)', () => {
  const r = parseRelease('Anime.Name.-.245.[1080p]');
  assert.equal(r.absolute, 245);
  assert.equal(r.season, 1);
});

test('pack detection', () => {
  assert.equal(parseRelease('Show.S01.Complete.720p.BluRay').isPack, true);
  assert.equal(parseRelease('Show.Season.1.1080p.WEB-DL').isPack, true);
  assert.equal(parseRelease('Show.S01E05.720p').isPack, false);
});

test('matchesEpisode logic', () => {
  const exact = parseRelease('Show.S02E07.720p');
  assert.equal(matchesEpisode(exact, 2, 7, ''), true);
  assert.equal(matchesEpisode(exact, 2, 8, ''), false);
  assert.equal(matchesEpisode(exact, 1, 7, ''), false);

  const range = parseRelease('Show.S02E07-E09.720p');
  assert.equal(matchesEpisode(range, 2, 8, ''), true);
  assert.equal(matchesEpisode(range, 2, 10, ''), false);

  const pack = parseRelease('Show.S02.Complete');
  assert.equal(matchesEpisode(pack, 2, 1, 'Show.S02.Complete'), true);
  assert.equal(matchesEpisode(pack, 3, 1, 'Show.S02.Complete'), false);

  const anime = parseRelease('Anime.Name.-.245.[1080p]');
  assert.equal(matchesEpisode(anime, 1, 245, ''), true);
  assert.equal(matchesEpisode(anime, 2, 245, ''), false);

  const unlabelled = parseRelease('Just.A.Movie.2020');
  assert.equal(matchesEpisode(unlabelled, 1, 1, ''), true);
});
