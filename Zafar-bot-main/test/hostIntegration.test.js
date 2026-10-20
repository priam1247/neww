/**
 * The movie/series feature must behave like the rest of ZaFar Bot, not like a
 * separate app bolted onto it. These tests pin the adapter down:
 *
 *   • temp files live in the bot's own temp dir (temp/movies)
 *   • finished files go out the way `.dl` sends them (video ≤ 50 MB, document
 *     above), through the same Baileys call the other commands use
 *   • big files are parked on the bot's Drime account with the documented
 *     S3 multipart flow (create → sign → PUT parts → complete → entries)
 *   • nothing here needs axios, baileys or the internet
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'zafar-host-test-'));
process.env.TEMP_DIR = SANDBOX;
process.env.CACHE_FILE = path.join(SANDBOX, 'cache.json');
process.env.MOVIE_QUIET = '1';

const config = require('../config');
const host = require('../utils/movieHost');
const tempManager = require('../utils/tempManager');

after(() => {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  host.reset();
  delete config.movies.drimeUpload;
  delete config.movies.drimeThresholdMB;
});

/** Small valid-ish mp4 header so nothing chokes on the bytes. */
function writeMovie(name, bytes) {
  const dir = host.tempDir();
  const file = path.join(dir, name);
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, Buffer.from('ftypisom', 'ascii'), 0, 8, 0);
  fs.closeSync(fd);
  if (bytes > 8) fs.truncateSync(file, bytes); // sparse: costs no real disk
  return file;
}

function fakeSock() {
  const sent = [];
  return {
    sent,
    async sendMessage(jid, content) {
      sent.push({ jid, content });
      return { key: { id: `m${sent.length}` } };
    },
  };
}

const MSG = { key: { id: 'h1', remoteJid: '111@s.whatsapp.net' } };

test('temp files live inside the bot temp dir', () => {
  const dir = host.tempDir();
  assert.ok(dir.startsWith(tempManager.getTempDir()), `${dir} must be under ${tempManager.getTempDir()}`);
  assert.ok(fs.existsSync(dir), 'the folder must be created on demand');
  assert.ok(host.tempFile('x.mp4').startsWith(dir));
});

test('small files are sent as playable video, exactly like .dl', async () => {
  const file = writeMovie('small.mp4', 2 * 1024);
  const sock = fakeSock();

  const res = await host.sendMedia(sock, '111@s.whatsapp.net', MSG, {
    file, title: 'Small Film', caption: '🎬 *Small Film*',
  });

  assert.equal(res.as, 'video');
  assert.equal(sock.sent.length, 1);
  assert.ok(sock.sent[0].content.video, 'must use the video field');
  assert.equal(sock.sent[0].content.mimetype, 'video/mp4');
  assert.match(sock.sent[0].content.caption, /Small Film/);
  assert.equal(sock.sent[0].content.video.url, file);
});

test('files above 50 MB are sent as documents (WhatsApp limit rule)', async () => {
  const file = writeMovie('big.mp4', 51 * 1024 * 1024);
  const sock = fakeSock();

  const res = await host.sendMedia(sock, '111@s.whatsapp.net', MSG, { file, title: 'Big Film' });

  assert.equal(res.as, 'document');
  assert.ok(sock.sent[0].content.document, 'must use the document field');
  assert.match(sock.sent[0].content.fileName, /Big Film\.mp4$/);
});

test('Drime policy: off / big / always', () => {
  config.movies.drimeUpload = 'off';
  assert.equal(host.drimeMode(), 'off');
  assert.equal(host.shouldUploadDrime(10 * 1024 * 1024 * 1024), false);

  config.movies.drimeUpload = 'always';
  assert.equal(host.shouldUploadDrime(1), true);

  config.movies.drimeUpload = 'big';
  config.movies.drimeThresholdMB = 100;
  assert.equal(host.shouldUploadDrime(50 * 1024 * 1024), false);
  assert.equal(host.shouldUploadDrime(150 * 1024 * 1024), true);
});

test('big files are uploaded to Drime and the link is posted', async () => {
  const file = writeMovie('upload.mp4', 11 * 1024 * 1024); // 3 parts of 5 MB
  config.movies.drimeUpload = 'always';
  config.drime = { ...config.drime, apiToken: 'test-token', baseUrl: 'https://drime.test/api/v1', workspaceId: 0 };

  const calls = [];
  const client = {
    async post(url, body) {
      calls.push({ method: 'post', url, body });
      if (url === '/s3/multipart/create') return { data: { key: 'uploads/uuid/uuid', uploadId: 'UPLOAD1' } };
      if (url === '/s3/multipart/batch-sign-part-urls') {
        return { data: { urls: body.partNumbers.map(n => ({ partNumber: n, url: `https://s3.test/part${n}` })) } };
      }
      if (url === '/s3/multipart/complete') return { data: { location: 'https://s3.test/done' } };
      if (url === '/s3/entries') {
        return { data: { fileEntry: { id: 42, hash: 'HASH42', name: 'Upload.mp4' } } };
      }
      throw new Error(`unexpected POST ${url}`);
    },
    async get(url) {
      calls.push({ method: 'get', url });
      if (url.startsWith('/file-entries/')) return { data: { link: { url: 'https://drime.test/share/abc' } } };
      return { data: {} };
    },
  };

  const http = {
    create: () => client,
    async put(url, buffer) {
      calls.push({ method: 'put', url, bytes: buffer.length });
      return { headers: { etag: '"etag"' } };
    },
  };
  host.setHttp(http);

  const prog = [];
  const up = await host.drimeUpload(file, 'Upload', { onProgress: (a, b) => prog.push([a, b]) });

  assert.equal(up.id, 42);
  assert.equal(up.link, 'https://drime.test/share/abc');
  assert.equal(up.size, 11 * 1024 * 1024);

  // documented flow: create → sign → PUT every part → complete → entries → link
  assert.deepEqual(calls.map(c => `${c.method} ${c.url}`), [
    'post /s3/multipart/create',
    'post /s3/multipart/batch-sign-part-urls',
    'put https://s3.test/part1',
    'put https://s3.test/part2',
    'put https://s3.test/part3',
    'post /s3/multipart/complete',
    'post /s3/entries',
    'get /file-entries/42/shareable-link',
  ]);

  const complete = calls.find(c => c.url === '/s3/multipart/complete');
  assert.equal(complete.body.parts.length, 3);
  assert.deepEqual(complete.body.parts[0], { PartNumber: 1, ETag: '"etag"' });

  const entry = calls.find(c => c.url === '/s3/entries');
  assert.equal(entry.body.clientName, 'Upload.mp4');
  assert.equal(entry.body.size, 11 * 1024 * 1024);

  assert.ok(prog.length >= 1, 'upload progress must be reported');
  assert.equal(prog[prog.length - 1][0], 11 * 1024 * 1024);
});

test('a failed Drime upload still delivers the file', async () => {
  const file = writeMovie('failupload.mp4', 51 * 1024 * 1024);
  config.movies.drimeUpload = 'always';
  config.drime = { ...config.drime, apiToken: 'test-token', baseUrl: 'https://drime.test/api/v1' };

  host.setHttp({
    create: () => ({ async post() { throw new Error('drime down'); }, async get() { return { data: {} }; } }),
    async put() { throw new Error('drime down'); },
  });

  const sock = fakeSock();
  const res = await host.deliver(sock, '111@s.whatsapp.net', MSG, { file, title: 'Still Works' });

  assert.equal(res.as, 'document');
  assert.match(String(res.error), /drime down/);
  assert.equal(sock.sent.filter(m => m.content.document).length, 1, 'the user still gets the file');
  // and the failure is reported, not swallowed silently into a crash
});

test('capabilities reflect the bot, not the engine', () => {
  const caps = host.capabilities();
  assert.ok(caps.tempDir.includes('movies'));
  assert.equal(typeof caps.downloader, 'boolean');
  assert.equal(typeof caps.ffmpeg.works, 'boolean');
  assert.match(host.statusLine(), /downloader (✓|✗).*ffmpeg.*Drime/);
  assert.ok(caps.maxDownloadMB >= 1);
});

test('the engine asks the host for ffmpeg instead of guessing', async () => {
  const { ffmpegPath } = await import(new URL('../engine/host.js', require('url').pathToFileURL(__filename)).href);
  const resolved = await ffmpegPath();
  // either the bot found a working binary, or it says "no" — never throws
  assert.ok(resolved === null || typeof resolved === 'string');
});
