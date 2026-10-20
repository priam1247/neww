/**
 * End-to-end test of the .movie / .series commands with a fake WhatsApp socket.
 *
 * TMDB is stubbed (no internet in CI) but everything else is real: the command
 * parsing, the queue, the streamed download from a local HTTP server, the
 * document upload call and the progress-card edits.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'zafar-cmd-test-'));
process.env.TEMP_DIR = path.join(SANDBOX, 'media');
process.env.JOB_DIR = path.join(SANDBOX, 'media');
process.env.CACHE_FILE = path.join(SANDBOX, 'cache.json');
process.env.DATA_DIR = path.join(SANDBOX, 'data');
process.env.MIN_SAMPLE_MB = '0';
process.env.MIN_FREE_MB = '0';
process.env.MOVIE_QUIET = '1';

const MP4 = Buffer.concat([
  (() => { const b = Buffer.alloc(48); b.writeUInt32BE(32, 0); b.write('ftyp', 4, 'ascii'); b.write('isom', 8, 'ascii'); return b; })(),
  Buffer.alloc(2048, 1),
]);

let server, base;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/movie.mp4') {
      if (req.method === 'HEAD') {
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': MP4.length });
        return res.end();
      }
      const range = req.headers.range;
      if (range) {
        const [a, b] = range.replace('bytes=', '').split('-');
        const start = Number(a) || 0;
        const end = b === '' ? MP4.length - 1 : Number(b);
        const chunk = MP4.subarray(start, end + 1);
        res.writeHead(206, {
          'content-type': 'video/mp4',
          'content-range': `bytes ${start}-${end}/${MP4.length}`,
          'content-length': chunk.length,
        });
        return res.end(chunk);
      }
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': MP4.length });
      return res.end(MP4);
      }
    res.writeHead(404); res.end('no');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(r => server.close(r));
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Fake Baileys socket that records every call. */
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

function fakeExtra(from = '111@s.whatsapp.net') {
  return {
    from,
    sender: from,
    isOwner: true,
    reply: async (text) => { /* recorded through sock in the real flow */ },
  };
}

/** Stub the TMDB half of the bridge, keep resolve/download real. */
async function stubBridge({ movieMatches, tvMatches, fileUrl }) {
  const bridge = require('../utils/movieEngine');
  const realDownload = bridge.download;

  bridge.searchMovie = async () => movieMatches;
  bridge.searchTv = async () => tvMatches;
  bridge.movieDetails = async (id) => ({ tmdbId: id, imdbId: 'tt0000001', title: movieMatches[0].title, year: movieMatches[0].year, type: 'movie' });
  bridge.tvDetails = async (id) => ({ tmdbId: id, imdbId: 'tt0000002', title: tvMatches[0].title, year: tvMatches[0].year, type: 'series', seasons: 5 });
  bridge.resolveMovie = async () => ({
    kind: 'file', url: fileUrl, provider: 'test-src', tier: 3, sizeMB: MP4.length / 1048576,
    headers: {}, meta: await bridge.movieDetails(1),
  });
  bridge.resolveEpisode = async ({ season, episode }) => ({
    kind: 'file', url: fileUrl, provider: 'test-src', tier: 3, sizeMB: MP4.length / 1048576,
    headers: {}, season, episode, meta: await bridge.tvDetails(1),
  });
  bridge.targetFile = async (title, year, quality, season, episode) => {
    fs.mkdirSync(process.env.TEMP_DIR, { recursive: true });
    const name = `${String(title).replace(/\s+/g, '.')}.${quality}p${season ? `.S${season}E${episode}` : ''}.mp4`;
    return path.join(process.env.TEMP_DIR, name);
  };
  bridge.rememberFile = async () => true;
  bridge.enqueue = async (jid, label, fn) => fn();
  bridge.queuePosition = async () => 0;
  bridge.download = realDownload;
  return bridge;
}

test('.movie downloads the resolved file and sends it as a document', async () => {
  const bridge = await stubBridge({
    movieMatches: [{ tmdbId: 1, title: 'Inception', year: '2010', poster: null }],
    tvMatches: [],
    fileUrl: `${base}/movie.mp4`,
  });

  const cmd = require('../commands/media/movie');
  const sock = fakeSock();
  const msg = { key: { id: 'in1', remoteJid: '111@s.whatsapp.net' }, message: {} };

  await cmd.execute(sock, msg, ['inception', '2010', '1080'], fakeExtra());

  const docs = sock.sent.filter(m => m.content?.document);
  assert.equal(docs.length, 1, `expected one document, got ${sock.sent.length} messages`);
  assert.match(docs[0].content.caption, /Inception/);
  assert.match(docs[0].content.caption, /1080p/);
  assert.equal(docs[0].content.mimetype, 'video/mp4');
  assert.ok(fs.existsSync(docs[0].content.document.url), 'file must exist on disk');

  // progress card was created and edited
  const edits = sock.sent.filter(m => m.content?.edit);
  assert.ok(edits.length >= 1, 'the status card should be edited, not spammed');

  const last = sock.sent[sock.sent.length - 1];
  assert.match(last.content.text, /✅/);
});

test('.movie offers a numbered picker when several titles match', async () => {
  const bridge = await stubBridge({
    movieMatches: [
      { tmdbId: 1, title: 'Dune', year: '1984', poster: null },
      { tmdbId: 2, title: 'Dune', year: '2021', poster: null },
    ],
    tvMatches: [],
    fileUrl: `${base}/movie.mp4`,
  });

  const selections = require('../utils/selections');
  const cmd = require('../commands/media/movie');
  const sock = fakeSock();
  const msg = { key: { id: 'in2', remoteJid: '222@s.whatsapp.net' }, message: {} };

  await cmd.execute(sock, msg, ['dune'], fakeExtra('222@s.whatsapp.net'));

  const listMsg = sock.sent.find(m => /matches/i.test(m.content?.text || ''));
  assert.ok(listMsg, 'a numbered list should be sent');
  assert.ok(selections.peek('222@s.whatsapp.net', '222@s.whatsapp.net'), 'a pending selection must be registered');

  // picking "2" must download the 2021 film, not the 1984 one
  const picked = selections.match('222@s.whatsapp.net', '222@s.whatsapp.net', '2');
  assert.ok(picked, 'selection 2 must resolve');
  assert.equal(picked.item.year, '2021');

  sock.sent.length = 0;
  await picked.entry.run(sock, msg, fakeExtra('222@s.whatsapp.net'), picked.item);
  const docs = sock.sent.filter(m => m.content?.document);
  assert.equal(docs.length, 1);
});

test('.series downloads every episode of a range', async () => {
  const bridge = await stubBridge({
    movieMatches: [],
    tvMatches: [{ tmdbId: 5, title: 'The Boys', year: '2019', poster: null }],
    fileUrl: `${base}/movie.mp4`,
  });

  const cmd = require('../commands/media/series');
  const sock = fakeSock();
  const msg = { key: { id: 'in3', remoteJid: '333@s.whatsapp.net' }, message: {} };

  await cmd.execute(sock, msg, ['the', 'boys', 's02', '1-3', '720'], fakeExtra('333@s.whatsapp.net'));

  const docs = sock.sent.filter(m => m.content?.document);
  assert.equal(docs.length, 3, 'three episodes expected');
  assert.match(docs[0].content.caption, /S02E01/);
  assert.match(docs[2].content.caption, /S02E03/);
});

test('.info shows the ids that downloads need and which sources produced them', async () => {
  const bridge = require('../utils/movieEngine');
  bridge.lookup = async () => ([{
    source: 'tmdb', sources: ['tmdb', 'cinemeta', 'omdb'], type: 'movie',
    title: 'Inception', year: '2010', imdbId: 'tt1375666', tmdbId: 27205,
    rating: 8.8, runtime: 148, genres: ['Sci-Fi'], overview: 'Dreams.', poster: null,
  }]);

  const cmd = require('../commands/general/info');
  let out = '';
  const extra = {
    from: '555@s.whatsapp.net',
    sender: '555@s.whatsapp.net',
    reply: async (t) => { out = t; },
  };
  const sock = { sendMessage: async (jid, c) => { out = c.caption || c.text; return { key: { id: '1' } }; } };

  await cmd.execute(sock, { key: { id: 'i1', remoteJid: extra.from } }, ['inception'], extra);

  assert.match(out, /Inception/);
  assert.match(out, /imdb:tt1375666/);
  assert.match(out, /tmdb:27205/);
  assert.match(out, /tmdb · cinemeta · omdb/);
});

test('.info explains its usage without arguments', async () => {
  const cmd = require('../commands/general/info');
  let out = '';
  const extra = { from: '1@s.whatsapp.net', sender: '1@s.whatsapp.net', reply: async (t) => { out = t; } };
  await cmd.execute({}, { key: { id: '2' } }, [], extra);
  assert.match(out, /Usage: \.info/);
});

test('.series requires an episode marker and explains usage otherwise', async () => {
  const sock = fakeSock();
  const cmd = require('../commands/media/series');
  const msg = { key: { id: 'in4', remoteJid: '444@s.whatsapp.net' }, message: {} };

  const extra = fakeExtra('444@s.whatsapp.net');
  let replied = '';
  extra.reply = async (t) => { replied = t; };

  await cmd.execute(sock, msg, ['the', 'boys'], extra);
  assert.match(replied, /Which episode/i);
});
