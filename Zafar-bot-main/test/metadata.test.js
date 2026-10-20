/**
 * Multi-source metadata tests — every source is mocked by a local HTTP server,
 * so the whole chain is exercised with no internet access:
 *
 *   TMDB · Cinemeta · IMDb (suggest) · TVMaze · OMDb · Trakt · Jikan · AniList
 *
 * The point of the suite is the behaviour that matters in production:
 *   • one film found by several sources is merged into ONE item with all ids
 *   • a dead / keyless source never breaks the lookup
 *   • a TMDB outage still produces a downloadable item (imdb + tmdb ids)
 *   • anime routes to the anime sources
 *   • the quality ladder falls back instead of failing
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'zafar-meta-test-'));

let server, base;
let tmdbDown = false;

const TMDB_MOVIE = {
  id: 27205, title: 'Inception', release_date: '2010-07-15',
  poster_path: '/inc.jpg', vote_average: 8.4, popularity: 120, overview: 'Dreams.',
  imdb_id: 'tt1375666',
};

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const send = (obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

    // ── TMDB ──────────────────────────────────────────────────────────────
    if (p.startsWith('/3/')) {
      if (tmdbDown) return send({ status_message: 'down' }, 503);
      if (p === '/3/search/movie') {
        return send({ results: url.searchParams.get('query')?.toLowerCase().includes('inception') ? [TMDB_MOVIE] : [] });
      }
      if (p === '/3/search/tv') return send({ results: [] });
      if (p === '/3/movie/27205') return send({ ...TMDB_MOVIE, runtime: 148, genres: [{ name: 'Sci-Fi' }], external_ids: { imdb_id: 'tt1375666' } });
      if (p === '/3/find/tt1375666') return send({ movie_results: [TMDB_MOVIE], tv_results: [] });
      return send({});
    }

    // ── Cinemeta ──────────────────────────────────────────────────────────
    if (p === '/catalog/movie/top/search=inception.json') {
      return send({ metas: [{ imdb_id: 'tt1375666', moviedb_id: 27205, name: 'Inception', releaseInfo: '2010', poster: 'https://img/inc.jpg', imdbRating: '8.4' }] });
    }
    if (p === '/meta/movie/tt1375666.json') {
      return send({ meta: { imdb_id: 'tt1375666', moviedb_id: 27205, name: 'Inception', releaseInfo: '2010', poster: 'https://img/inc.jpg', imdbRating: '8.4', description: 'Dreams.' } });
    }
    if (p === '/catalog/series/top/search=inception.json') return send({ metas: [] });

    // ── IMDb suggestions ──────────────────────────────────────────────────
    if (p.startsWith('/suggestion/x/')) {
      if (!p.toLowerCase().includes('inception')) return send({ d: [] });
      return send({ d: [{ id: 'tt1375666', l: 'Inception', y: 2010, qid: 'movie', rank: 20 }] });
    }

    // ── TVMaze ────────────────────────────────────────────────────────────
    if (p === '/search/shows') {
      const q = String(url.searchParams.get('q') || '').toLowerCase();
      if (!q.includes('night')) return send([]);
      return send([{ score: 9, show: { id: 42, name: 'Night Court', premiered: '1984-01-04', externals: { imdb: 'tt0086776' }, genres: ['Comedy'], weight: 90 } }]);
    }
    if (p === '/shows/42') {
      return send({ id: 42, name: 'Night Court', premiered: '1984-01-04', externals: { imdb: 'tt0086776' }, genres: ['Comedy'], averageRuntime: 30, _embedded: { episodes: new Array(16).fill({ season: 1 }) } });
    }
    if (p === '/lookup/shows') {
      return send({ id: 42, name: 'Night Court', premiered: '1984-01-04', externals: { imdb: 'tt0086776' } });
    }
    if (p === '/shows/42/episodes') {
      return send([{ number: 1, season: 1, name: 'Pilot', airdate: '1984-01-04' }, { number: 2, season: 1, name: 'Two', airdate: '1984-01-11' }]);
    }
    if (p === '/shows/42/episodebynumber') {
      return send({ number: 2, season: 1, name: 'Two', airdate: '1984-01-11' });
    }

    // ── OMDb ──────────────────────────────────────────────────────────────
    if (p === '/' && url.searchParams.get('i') === 'tt1375666') {
      return send({ Response: 'True', imdbID: 'tt1375666', Title: 'Inception', Year: '2010', Runtime: '148 min', Genre: 'Action, Sci-Fi', imdbRating: '8.8', Plot: 'Dreams.', Type: 'movie' });
    }
    if (p === '/' && url.searchParams.get('s')) {
      const q = String(url.searchParams.get('s')).toLowerCase();
      if (!q.includes('inception')) return send({ Response: 'True', Search: [] });
      return send({ Response: 'True', Search: [{ imdbID: 'tt1375666', Title: 'Inception', Year: '2010', Type: 'movie' }] });
    }
    if (p === '/') return send({ Response: 'False', Error: 'not found' });

    // ── Trakt ─────────────────────────────────────────────────────────────
    if (p === '/search/movie') {
      const q = String(url.searchParams.get('query') || '').toLowerCase();
      if (!q.includes('inception')) return send([]);
      return send([{ type: 'movie', score: 500, movie: { title: 'Inception', year: 2010, ids: { trakt: 16662, imdb: 'tt1375666', tmdb: 27205 }, genres: ['Sci-Fi'], overview: 'Dreams.' } }]);
    }
    if (p === '/movies/trending') {
      return send([{ watchers: 900, movie: { title: 'Trending Film', year: 2025, ids: { trakt: 1, imdb: 'tt9999999', tmdb: 999 } } }]);
    }

    // ── Jikan ─────────────────────────────────────────────────────────────
    if (p === '/anime') {
      const q = String(url.searchParams.get('q') || '').toLowerCase();
      if (!q.includes('titan')) return send({ data: [] });
      return send({ data: [{ mal_id: 16498, title: 'Shingeki no Kyojin', title_english: 'Attack on Titan', year: 2013, episodes: 25, score: 8.5, images: { jpg: { large_image_url: 'https://img/aot.jpg' } }, genres: [{ name: 'Action' }], duration: '24 min per ep', members: 3000000 }] });
    }
    if (p === '/anime/16498/full') {
      return send({ data: { mal_id: 16498, title: 'Shingeki no Kyojin', title_english: 'Attack on Titan', year: 2013, episodes: 25, score: 8.5, images: { jpg: { large_image_url: 'https://img/aot.jpg' } }, genres: [{ name: 'Action' }] } });
    }

    // ── AniList ───────────────────────────────────────────────────────────
    if (p === '/') {
      let body = '';
      req.on('data', (c) => { body += c; });
      return req.on('end', () => {
        send({ data: { Page: { media: [{
          id: 16498, idMal: 16498,
          title: { romaji: 'Shingeki no Kyojin', english: 'Attack on Titan', native: '進撃の巨人' },
          startDate: { year: 2013 }, episodes: 25, duration: 24, averageScore: 85,
          coverImage: { large: 'https://img/aot.jpg' }, genres: ['Action'], synonyms: ['AoT'],
          description: 'Titans.', status: 'FINISHED', popularity: 400000,
        }] } } });
      });
    }

    send({ error: 'not found' }, 404);
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  // point every source at the mock BEFORE the engine is imported
  process.env.TMDB_BASE = `${base}/3`;
  process.env.CINEMETA_BASE = base;
  process.env.TVMAZE_BASE = base;
  process.env.OMDB_BASE = base;
  process.env.TRAKT_BASE = base;
  process.env.JIKAN_BASE = base;
  process.env.ANILIST_BASE = base;
  process.env.IMDB_SUGGEST_BASE = base;
  process.env.OMDB_API_KEY = 'test-omdb';
  process.env.TRAKT_CLIENT_ID = 'test-trakt';
  process.env.METADATA_TIMEOUT_MS = '3000';
  process.env.TEMP_DIR = path.join(SANDBOX, 'media');
  process.env.JOB_DIR = path.join(SANDBOX, 'media');
  process.env.CACHE_FILE = path.join(SANDBOX, 'cache.json');
  process.env.DATA_DIR = path.join(SANDBOX, 'data');
  process.env.IMDB_INDEX_FILE = path.join(SANDBOX, 'imdb-index.tsv');
  process.env.MOVIE_QUIET = '1';
});

after(async () => {
  await new Promise(r => server.close(r));
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ignore */ }
});

const enginePath = (p) => new URL(`../engine/${p}`, pathToFileURL(__filename)).href;
const meta = () => import(enginePath('metadata/index.js'));

test('every source is registered and reports its key requirement', async () => {
  const { table } = await meta();
  const rows = table();
  const ids = rows.map(r => r.id);
  for (const id of ['tmdb', 'cinemeta', 'imdb', 'tvmaze', 'omdb', 'trakt', 'jikan', 'anilist']) {
    assert.ok(ids.includes(id), `missing source: ${id}`);
  }
  assert.equal(rows.find(r => r.id === 'tmdb').needsKey, true);
  assert.equal(rows.find(r => r.id === 'cinemeta').needsKey, false);
  assert.equal(rows.find(r => r.id === 'anilist').needsKey, false);
  // omdb/trakt are enabled because the test env provides keys
  assert.equal(rows.find(r => r.id === 'omdb').enabled, true);
  assert.equal(rows.find(r => r.id === 'trakt').enabled, true);
});

test('search merges the same film from TMDB + Cinemeta + IMDb + Trakt + OMDb into ONE item', async () => {
  const { search } = await meta();
  const hits = await search('Inception', { type: 'movie', year: '2010' });

  const inception = hits.filter(h => /^inception$/i.test(h.title));
  assert.equal(inception.length, 1, `expected one merged item, got ${inception.length}: ${hits.map(h => h.title)}`);

  const item = inception[0];
  assert.equal(item.imdbId, 'tt1375666');
  assert.equal(item.tmdbId, 27205);
  assert.ok(item.sources.length >= 3, `expected several sources, got ${item.sources}`);
  assert.ok(item.poster, 'poster must survive the merge');
});

test('details() keeps ids from every source (imdb + tmdb + ratings)', async () => {
  const { search, details } = await meta();
  const [best] = await search('Inception', { type: 'movie', year: '2010' });
  const full = await details(best);

  assert.equal(full.imdbId, 'tt1375666');
  assert.equal(full.tmdbId, 27205);
  assert.ok(full.rating, 'a rating should be filled in');
  assert.ok(full.overview);
});

test('a TMDB outage does not break the lookup (Cinemeta + IMDb still resolve it)', async () => {
  tmdbDown = true;
  try {
    const { search, details } = await meta();
    const hits = await search('Inception', { type: 'movie', year: '2010' });
    assert.ok(hits.length, 'other sources must still answer');

    const full = await details(hits[0]);
    assert.equal(full.imdbId, 'tt1375666', 'IMDb id must be filled from Cinemeta');
    assert.equal(full.tmdbId, 27205, 'TMDB id must be filled from Cinemeta.moviedb_id');
  } finally {
    tmdbDown = false;
  }
});

test('series search uses TVMaze and keeps the episode count', async () => {
  const { search, details } = await meta();
  const hits = await search('Night Court', { type: 'series' });
  assert.ok(hits.length, 'TVMaze should answer for TV');

  const full = await details(hits[0]);
  assert.equal(full.tvMazeId || full.tvmazeId, 42);
  assert.equal(full.episodes, 16);
});

test('anime is found through Jikan + AniList and flagged as anime', async () => {
  const { search, looksAnime } = await meta();
  const hits = await search('Attack on Titan', { type: 'series' });
  assert.ok(hits.length, 'anime sources must answer');

  const best = hits[0];
  assert.ok(best.anime, 'item must be flagged as anime');
  assert.equal(best.malId, 16498);
  assert.equal(looksAnime(best), true, 'anime detection must route to Nyaa');
  assert.ok(hits.some(h => h.source === 'jikan') || hits.some(h => (h.sources || []).includes('jikan')));
});

test('Trakt trending works through the same layer', async () => {
  const { trakt } = await meta();
  const rows = await trakt.trending('movie', 5);
  assert.equal(rows[0].title, 'Trending Film');
  assert.equal(rows[0].imdbId, 'tt9999999');
});

test('an unknown title returns an empty list instead of throwing', async () => {
  const { search } = await meta();
  const hits = await search('zzzz-no-such-film-zzzz', { type: 'movie' });
  assert.deepEqual(hits, []);
});

test('quality ladder falls back down, then up, and honours the switch', async () => {
  const media = await import(enginePath('media/index.js'));
  assert.deepEqual(media.qualityLadder(1080), [1080, 720, 480, 2160]);
  assert.deepEqual(media.qualityLadder(720), [720, 480, 1080, 2160]);
  assert.deepEqual(media.qualityLadder(480), [480, 720, 1080, 2160]);
});

test('identify() accepts a merged item and returns ids for the providers', async () => {
  const media = await import(enginePath('media/index.js'));
  const { search } = await meta();

  const [pick] = await search('Inception', { type: 'movie', year: '2010' });
  const item = await media.identify({ item: pick });

  assert.equal(item.imdbId, 'tt1375666');   // torrent indexers
  assert.equal(item.tmdbId, 27205);          // stream providers
  assert.equal(item.title, 'Inception');
});

test('the IMDb bulk index is used when the dump has been built', async () => {
  const idx = process.env.IMDB_INDEX_FILE;
  fs.writeFileSync(idx, [
    'tt0133093\tmovie\tThe Matrix\tthe matrix\t1999',
    'tt0234215\tmovie\tThe Matrix Reloaded\tthe matrix reloaded\t2003',
  ].join('\n') + '\n');

  const imdb = await import(enginePath('metadata/imdb.js'));
  assert.equal(imdb.default.hasIndex(), true, 'a fresh index must be detected without a restart');
  const hits = await imdb.default.fromIndex('the matrix', { type: 'movie' });
  assert.equal(hits.length, 2);
  assert.equal(hits[0].imdbId, 'tt0133093');
  assert.equal(hits[1].year, '2003');
});
