// test/smoke.test.js — LIVE network tests. Auto-skip when offline or when
// required keys are missing. These prove the providers actually answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ONLINE = await (async () => {
  try {
    await fetch('https://api.themoviedb.org/3/configuration', { signal: AbortSignal.timeout(4000) });
    return true;                       // any HTTP response = online (401 expected without key)
  } catch { return false; }
})();

const describe = ONLINE ? test : test.skip;
const NEEDS_TMDB = ONLINE && !!process.env.TMDB_API_KEY;

describe('live: torrentio answers for a known series', { timeout: 20000 }, async () => {
  const { req } = await import('../src/core/http.js');
  // Breaking Bad S01E01 — one of the most cached shows alive
  const d = await req('https://torrentio.strem.fun/stream/series/tt0903747:1:1.json', { retries: 1, timeout: 12000 });
  assert.ok(Array.isArray(d.streams), 'streams array expected');
  assert.ok(d.streams.length > 0, 'expected candidates for BB S01E01');
});

describe('live: apibay answers for a popular query', { timeout: 15000 }, async (t) => {
  const { req } = await import('../src/core/http.js');
  let body = '', ctype = '';
  try {
    const res = await req('https://apibay.org/q.php?q=ubuntu', { json: false, retries: 0, timeout: 10000 });
    body = await res.text();
    ctype = res.headers.get('content-type') || '';
  } catch (e) {
    t.skip(`apibay unreachable from this network: ${e.message}`);
    return;
  }
  if (/<html/i.test(body) || /just a moment/i.test(body)) {
    t.skip('apibay served a bot-challenge page (Cloudflare) — endpoint guarded from this IP');
    return;
  }
  const d = JSON.parse(body);
  assert.ok(Array.isArray(d), 'apibay returns a JSON array');
  assert.ok(d[0].info_hash !== undefined, 'apibay result shape');
});

describe('live: nyaa RSS answers', { timeout: 15000 }, async () => {
  const { req } = await import('../src/core/http.js');
  const res = await req('https://nyaa.si/?page=rss&q=test&c=1_2&f=0', { json: false, retries: 1, timeout: 10000 });
  const xml = await res.text();
  assert.ok(xml.includes('<item>') || xml.includes('No results'), 'RSS shape');
});

describe('live: TMDB search (needs TMDB_API_KEY)', { timeout: 15000, skip: !NEEDS_TMDB }, async () => {
  const tmdb = await import('../src/media/tmdb.js');
  const matches = await tmdb.searchMovie('inception', '2010');
  assert.ok(matches.length > 0);
  assert.equal(matches[0].title, 'Inception');
  const meta = await tmdb.movieDetails(matches[0].tmdbId);
  assert.equal(meta.imdbId, 'tt1375666');
});
