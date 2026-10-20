/**
 * The download guard must abort a dead socket quickly — but it must NOT kill a
 * slow transfer that is still receiving data (the old code aborted the whole
 * download after a fixed 60 s, which made big movies impossible to fetch).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'zafar-stall-test-'));
process.env.TEMP_DIR = path.join(SANDBOX, 'media');
process.env.JOB_DIR = path.join(SANDBOX, 'media');
process.env.CACHE_FILE = path.join(SANDBOX, 'cache.json');
process.env.DATA_DIR = path.join(SANDBOX, 'data');
process.env.MIN_FREE_MB = '0';
process.env.DOWNLOAD_STALL_MS = '400';     // abort after 400 ms of silence
process.env.DOWNLOAD_RETRIES = '0';
process.env.MOVIE_QUIET = '1';

const enginePath = (p) => new URL(`../engine/${p}`, require('url').pathToFileURL(__filename)).href;

let server, base;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/stall.mp4') {
      // announce a big body, send a little, then go silent forever
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': 10 * 1024 * 1024 });
      res.write(Buffer.alloc(4096, 1));
      return;                                  // never ends
    }
    if (req.url === '/slow.mp4') {
      // 8 chunks, 150 ms apart: total 1.2 s — longer than the 400 ms stall
      // window per chunk, but never silent for longer than it
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': 8 * 1024 });
      let n = 0;
      const timer = setInterval(() => {
        res.write(Buffer.alloc(1024, 2));
        if (++n === 8) { clearInterval(timer); res.end(); }
      }, 150);
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise(r => server.close(r));
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('a silent socket is aborted instead of hanging forever', async () => {
  const { httpToFile } = await import(enginePath('media/download.js'));
  const dest = path.join(SANDBOX, 'media', 'stalled.mp4');
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  await assert.rejects(httpToFile(`${base}/stall.mp4`, dest), /stalled/i);
});

test('a slow but alive transfer is not aborted', async () => {
  const { httpToFile } = await import(enginePath('media/download.js'));
  const dest = path.join(SANDBOX, 'media', 'slow.mp4');
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const out = await httpToFile(`${base}/slow.mp4`, dest);
  assert.equal(out.bytes, 8 * 1024);
  assert.equal(fs.statSync(dest).size, 8 * 1024);
});
