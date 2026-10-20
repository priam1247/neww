// test/http.test.js — retry, hedging, HTML helpers, cookie jar over a local server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { req, hedge, anchors, decodeEntities, jar } from '../src/core/http.js';

let flakyCount = 0;
const server = http.createServer((reqMsg, res) => {
  const url = new URL(reqMsg.url, 'http://x');
  res.setHeader('set-cookie', 'sid=abc123; Path=/');
  if (url.pathname === '/flaky') {
    flakyCount++;
    if (flakyCount <= 2) { res.writeHead(500); return res.end('boom'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, tries: flakyCount }));
  }
  if (url.pathname === '/json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ hello: 'world' }));
  }
  if (url.pathname === '/perm404') { res.writeHead(404); return res.end('nope'); }
  if (url.pathname === '/html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(`<html><a href="/page1">Page One</a><a href="https://ext.com/x">Ext</a><a name="skip">no href attr handled</a></html>`);
  }
  res.writeHead(200); res.end('ok');
});

let base;
before(async () => {
  await new Promise(r => { server.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('req parses JSON', async () => {
  const d = await req(`${base}/json`, { retries: 0 });
  assert.deepEqual(d, { hello: 'world' });
});

test('req retries 5xx and succeeds', async () => {
  const d = await req(`${base}/flaky`, { retries: 3, timeout: 3000 });
  assert.equal(d.ok, true);
});

test('req does NOT retry permanent 4xx', async () => {
  await assert.rejects(req(`${base}/perm404`, { retries: 3, timeout: 3000 }), /404/);
});

test('hedge collects results until deadline', async () => {
  const t0 = Date.now();
  const out = await hedge([
    new Promise(r => setTimeout(() => r('never'), 5000)),
    new Promise(r => setTimeout(() => r('never2'), 5000))
  ], 80);
  assert.deepEqual(out, []);
  assert.ok(Date.now() - t0 < 1000, 'hedge must respect the deadline');
});

test('hedge keeps successful results', async () => {
  const out = await hedge([
    Promise.resolve('a'),
    new Promise(r => setTimeout(() => r('b'), 30)),
    Promise.reject(new Error('x'))
  ], 2000);
  assert.deepEqual(out, ['a', 'b']);
});

test('anchors extracts href+text', () => {
  const list = anchors(`<a href="/p1">One &amp; Two</a><a href="https://e.com/x?q=1&amp;z=2">Ext</a>`, 'http://s.com');
  assert.equal(list[0].text, 'One & Two');
  assert.equal(list[0].href, 'http://s.com/p1');
  assert.equal(list[1].href, 'https://e.com/x?q=1&z=2');
});

test('decodeEntities handles numeric refs', () => {
  assert.equal(decodeEntities('&#65;&#x42;&amp;'), 'AB&');
});

test('cookie jar receives set-cookie from requests', async () => {
  await req(`${base}/json`, { retries: 0 });
  const host = new URL(base).hostname;
  assert.ok(jar.header(host)?.includes('sid=abc123'));
});
