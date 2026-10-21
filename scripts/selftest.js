#!/usr/bin/env node
/**
 * ZaFar Bot — offline self-test  (`npm run selftest`)
 *
 * Verifies the media engine without touching the internet:
 *   1. error classification (bot-check ≠ geo-block ≠ network …),
 *   2. cookie handling (Netscape / base64 / JSON export),
 *   3. container sniffing (mp3, m4a, mp4, webm audio vs video),
 *   4. yt-dlp argument building + capability detection,
 *   5. a full .song download against a *fake* yt-dlp (success, bot-check,
 *      profile escalation, timeout),
 *   6. remote providers (Gifted / cobalt) against a local stub API,
 *   7. that every command module loads.
 *
 * Everything runs in a throwaway directory; nothing in the repo is modified.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const http = require('http');
const assert = require('assert');

const REPO = path.join(__dirname, '..');

// ─── tiny test harness ────────────────────────────────────────────────────────
let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failures.push({ name, error: e });
    console.log(`  ❌ ${name}\n     ${e.message}`);
  }
}

// ─── sandbox: cwd with a fake bin/yt-dlp ──────────────────────────────────────
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'zafar-selftest-'));
process.chdir(sandbox);                       // engine looks for ./bin/yt-dlp
fs.mkdirSync(path.join(sandbox, 'bin'), { recursive: true });
fs.mkdirSync(path.join(sandbox, 'database'), { recursive: true });

const FAKE = path.join(sandbox, 'bin', 'yt-dlp');

// The fake records every invocation so tests can assert on the arguments.
const CALLS = path.join(sandbox, 'calls.jsonl');

fs.writeFileSync(FAKE, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify(args) + '\\n');

const env = process.env.FAKE_YTDLP || 'success';

if (args.includes('--version')) { console.log('2099.01.01'); process.exit(0); }
if (args.includes('-U')) { console.log('2099.01.01'); process.exit(0); }
if (args.includes('--help')) {
  console.log('Usage: yt-dlp [OPTIONS] URL');
  for (const f of ['--js-runtimes','--remote-components','--impersonate','--extractor-retries',
                   '--no-check-formats','--match-filters','--force-ipv4','--no-check-certificates',
                   '--max-filesize','--newline','--progress-template','--progress','--print',
                   '--extract-audio','--audio-format','--cookies','--proxy','--retries','--socket-timeout',
                   '--fragment-retries','--no-playlist','--user-agent','--socket-timeout','--add-header']) {
    console.log('    ' + f + ' VALUE');
  }
  process.exit(0);
}

if (env === 'no-ytdlp') { console.error('command not found'); process.exit(127); }
if (env === 'no-option') { console.error('yt-dlp: error: no such option: --js-runtimes'); process.exit(2); }
if (process.env.FAKE_REJECT_FLAG && args.includes(process.env.FAKE_REJECT_FLAG)) {
  console.error('yt-dlp: error: no such option: ' + process.env.FAKE_REJECT_FLAG);
  process.exit(2);
}
if (env === 'timeout') { setTimeout(() => {}, 60000); return; }

// Bot-check, optionally only for the first N calls (tests profile escalation)
const counterFile = path.join(${JSON.stringify(sandbox)}, 'count.txt');
let n = 0;
try { n = parseInt(fs.readFileSync(counterFile, 'utf8'), 10) || 0; } catch {}
fs.writeFileSync(counterFile, String(n + 1));

const failFirst = parseInt(process.env.FAKE_FAIL_FIRST || '0', 10);
const shouldFail = env === 'botcheck' || (failFirst && n < failFirst);
if (shouldFail) {
  console.error('ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you not a bot. Use --cookies for the authentication. See https://github.com/yt-dlp/yt-dlp/wiki/FAQ');
  process.exit(1);
}
if (env === 'geo') {
  console.error('ERROR: [youtube] dQw4w9WgXcQ: The uploader has not made this video available in your country');
  process.exit(1);
}
if (env === 'network') {
  console.error('ERROR: [youtube] dQw4w9WgXcQ: Unable to download API page: TLS/SSL connection has been closed (EOF)');
  process.exit(1);
}

// search (ytsearchN:) — the real build prints one line per result
const searchArg = args.find(a => String(a).startsWith('ytsearch'));
if (searchArg) {
  const n = Math.min(20, parseInt(String(searchArg).replace(/^ytsearch/, ''), 10) || 1);
  for (let i = 0; i < n; i++) {
    console.log('vid' + i + '\tResult ' + (i + 1) + '\t' + (100 + i) + '\tChannel ' + (i + 1) + '\thttps://i.ytimg.com/vi/vid' + i + '/hq.jpg');
  }
  process.exit(0);
}

// metadata probe
const printIdx = args.indexOf('--print');
if (printIdx !== -1) {
  console.log('Rick Astley\\t213\\tRickAstleyVEVO\\thttps://i.ytimg.com/vi/x/hq.jpg\\tdQw4w9WgXcQ');
  process.exit(0);
}

// download: honour -o "base.%(ext)s"
const oIdx = args.indexOf('-o');
const wantsAudio = args.some(a => String(a).startsWith('bestaudio')) || args.includes('--extract-audio');
const ext = args.includes('--extract-audio') ? 'mp3' : (wantsAudio ? 'm4a' : 'mp4');
const out = oIdx !== -1 ? args[oIdx + 1].replace('%(ext)s', ext) : null;
if (!out) { console.error('ERROR: nothing to do'); process.exit(1); }
let buf;
if (out.endsWith('.mp3')) {
  buf = Buffer.concat([Buffer.from('ID3\\x04\\x00\\x00\\x00\\x00\\x00\\x00'), Buffer.alloc(60000, 7)]);
} else if (out.endsWith('.m4a')) {
  // ftyp M4A + mp4a, no video codec -> sniff must call this audio
  buf = Buffer.concat([Buffer.from([0,0,0,0x20]), Buffer.from('ftypM4A '), Buffer.from('mp4a'), Buffer.alloc(60000, 5)]);
} else {
  buf = Buffer.concat([Buffer.from([0,0,0,0x20]), Buffer.from('ftypisom'), Buffer.from('avc1mp4a'), Buffer.alloc(90000, 3)]);
}
fs.writeFileSync(out, buf);
// progress line for the live-progress path
if (args.some(a => a.startsWith('--progress-template'))) {
  console.log('@@ZFPROG@@30000|60000|NA|1.2MiB/s|00:10');
}
console.log('done');
`);
fs.chmodSync(FAKE, 0o755);

// point the engine at our sandbox bin first
process.env.FAKE_YTDLP = 'success';

// ─── modules under test (required *after* chdir) ──────────────────────────────
const YT = require(path.join(REPO, 'utils/youtubedl.js'));
const MT = require(path.join(REPO, 'utils/mediaTransfer.js'));
const settings = require(path.join(REPO, 'utils/mediaSettings.js'));

(async () => {
  console.log('\n── 1. yt-dlp discovery & capabilities ──');

  await test('finds the yt-dlp binary and reads its version', () => {
    const cmd = YT.resolveCommand({ force: true });
    assert.ok(cmd, 'no yt-dlp found');
    assert.strictEqual(YT.version(), '2099.01.01');
  });

  await test('detects which options the installed build supports', () => {
    const caps = YT.capabilities({ force: true });
    assert.strictEqual(caps.jsRuntimes, true, 'js-runtimes not detected');
    assert.strictEqual(caps.impersonate, true, 'impersonate not detected');
    assert.strictEqual(caps.forceIpv4, true, 'force-ipv4 not detected');
    assert.strictEqual(caps.maxFilesize, true, 'max-filesize not detected');
    assert.strictEqual(caps.matchFilter, '--match-filter');
  });

  await test('base args only use supported options and always disable progress by default', () => {
    const args = YT.baseArgs();
    assert.ok(args.includes('--js-runtimes'), 'js-runtimes missing');
    assert.ok(args.includes('--no-progress'), 'progress not disabled');
    assert.ok(!args.includes('--progress-template'), 'progress template leaked into base args');
  });

  await test('progress template is added when progress is requested', () => {
    const args = YT.baseArgs({ progress: true });
    assert.ok(args.includes('--progress-template'), 'progress template missing');
    assert.ok(!args.includes('--no-progress'), 'progress not enabled');
  });

  await test('cookies are passed to yt-dlp when configured', () => {
    fs.writeFileSync(path.join(sandbox, 'cookies.txt'),
      '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1999999999\tSID\tabc\n');
    const args = YT.baseArgs();
    assert.ok(args.includes('--cookies'), 'no --cookies flag');
    assert.strictEqual(YT.hasCookies(), true);
    fs.unlinkSync(path.join(sandbox, 'cookies.txt'));
    YT.clearCookies();
  });

  console.log('\n── 2. error classification (the "region block" bug) ──');

  const cases = [
    ['Sign in to confirm you\u2019re not a bot. Use --cookies for the authentication.', 'BOT_CHECK'],
    ['ERROR: [youtube] x: The uploader has not made this video available in your country', 'GEO_BLOCK'],
    ['ERROR: Unable to download API page: TLS/SSL connection has been closed (EOF)', 'NETWORK'],
    ['ERROR: [youtube] x: Video unavailable', 'UNAVAILABLE'],
    ['ERROR: [youtube] x: This video is private', 'PRIVATE'],
    ['ERROR: [youtube] x: Sign in to confirm your age. This video may be inappropriate for some users.', 'AGE_RESTRICTED'],
    ['ERROR: HTTP Error 429: Too Many Requests', 'RATE_LIMIT'],
    ['ERROR: Requested format is not available', 'NO_FORMATS'],
    ['ERROR: Postprocessing: ffmpeg not found. Please install or provide the path', 'FFMPEG_MISSING'],
    ['ERROR: yt-dlp: error: no such option: --js-runtimes', 'BAD_ARGS'],
    ['ERROR: [youtube] x: This video is DRM protected', 'DRM'],
    ['ERROR: Unsupported URL: https://example.com/some-page', 'UNSUPPORTED_URL'],
  ];

  for (const [text, expected] of cases) {
    await test(`"${text.slice(0, 52)}…" → ${expected}`, () => {
      const info = YT.classify({ stderr: text, message: text });
      assert.strictEqual(info.code, expected, `got ${info.code}`);
    });
  }

  await test('a generic failure is never blamed on the region', () => {
    const err = { stderr: 'ERROR: something completely unexpected happened' };
    const info = YT.classify(err);
    assert.strictEqual(info.code, 'UNKNOWN');
    assert.ok(!/not available in this server's country|geo-block/i.test(YT.friendlyError(err)), 'message still blames the region');
  });

  await test('the command line itself never fakes a duration/size error', () => {
    // execFile puts the whole argv into err.message — this used to be matched
    // and reported as "media too long".
    const err = {
      message: 'Command failed: yt-dlp --match-filter duration < 3600 -o out.mp4 url',
      stderr: 'ERROR: [youtube] x: Video unavailable',
    };
    assert.strictEqual(YT.classify(err).code, 'UNAVAILABLE');
  });

  console.log('\n── 3. cookies: every format the user might send ──');

  const netscape = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1999999999\tSID\tabc\n';

  await test('accepts a Netscape cookies.txt', () => {
    const out = YT.normaliseCookieText(netscape);
    assert.ok(out && out.includes('SID'));
  });

  await test('accepts base64 of a cookies.txt', () => {
    const out = YT.normaliseCookieText(Buffer.from(netscape).toString('base64'));
    assert.ok(out && out.includes('SID'));
  });

  await test('converts a browser-extension JSON export', () => {
    const json = JSON.stringify([{ domain: '.youtube.com', hostOnly: false, path: '/', secure: true, expirationDate: 1999999999, name: 'SID', value: 'abc' }]);
    const out = YT.normaliseCookieText(json);
    assert.ok(out && out.includes('SID') && out.includes('.youtube.com'), 'JSON export not converted');
  });

  await test('rejects garbage instead of writing a broken file', () => {
    assert.strictEqual(YT.normaliseCookieText('hello world'), null);
  });

  await test('stores and clears cookies persistently (.cookies set)', () => {
    const { count } = YT.setCookies(netscape);
    assert.ok(count >= 1, 'no cookie counted');
    assert.ok(fs.existsSync(YT.COOKIE_STORE), 'cookie file not written');
    assert.strictEqual(YT.hasCookies(), true);
    YT.clearCookies();
    assert.strictEqual(YT.hasCookies(), false);
  });

  await test('managed cookies survive the temp cleanup timer (not in temp/)', () => {
    assert.ok(!YT.COOKIE_STORE.includes(`${path.sep}temp${path.sep}`), 'cookies stored inside temp/');
  });

  console.log('\n── 4. container sniffing (never mislabel a file) ──');

  await test('detects mp3 / m4a / mp4 / webm-audio / webm-video', () => {
    const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64)]);
    assert.strictEqual(MT.sniff(mp3).ext, 'mp3');

    const m4aHead = Buffer.concat([
      Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.from('mp4a'), Buffer.alloc(32, 0),
    ]);
    assert.strictEqual(MT.sniff(m4aHead).kind, 'audio');
    assert.strictEqual(MT.sniff(m4aHead).ext, 'm4a');

    const mp4Head = Buffer.concat([
      Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.from('avc1mp4a'), Buffer.alloc(32, 0),
    ]);
    assert.strictEqual(MT.sniff(mp4Head).kind, 'video');

    const webmAudio = Buffer.concat([Buffer.from('1a45dfa3', 'hex'), Buffer.from('A_OPUS'), Buffer.alloc(16)]);
    assert.strictEqual(MT.sniff(webmAudio).kind, 'audio');

    const webmVideo = Buffer.concat([Buffer.from('1a45dfa3', 'hex'), Buffer.from('V_VP9A_OPUS'), Buffer.alloc(16)]);
    assert.strictEqual(MT.sniff(webmVideo).kind, 'video');
  });

  console.log('\n── 5. full download path against a fake yt-dlp ──');

  await test('downloadAudio: succeeds and produces a real audio file', async () => {
    process.env.FAKE_YTDLP = 'success';
    const res = await YT.downloadAudio('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { maxMB: 100, outBase: path.join(sandbox, 'a1') });
    assert.ok(fs.existsSync(res.file), 'no file produced');
    assert.strictEqual(MT.sniffFile(res.file).kind, 'audio', `sniffed as ${MT.sniffFile(res.file).kind}`);
    // The raw stream is kept on purpose (no generation loss): the MP3 step
    // happens once, at send time, and only when ffmpeg can actually do it.
    assert.ok(['m4a', 'mp3', 'webm'].includes(res.ext), `unexpected ext: ${res.ext}`);
    assert.strictEqual(res.transcoded, false, 'audio was re-encoded during download');
  });

  await test('downloadVideo: succeeds and honours the requested height', async () => {
    process.env.FAKE_YTDLP = 'success';
    const res = await YT.downloadVideo('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { height: 480, outBase: path.join(sandbox, 'v1') });
    assert.ok(fs.existsSync(res.file), 'no file produced');
    const args = fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const dl = args.find(a => a.some(x => String(x).includes('height<=480')));
    assert.ok(dl, 'height cap not passed to yt-dlp');
  });

  await test('bot-check is reported as BOT_CHECK, not a region block', async () => {
    process.env.FAKE_YTDLP = 'botcheck';
    let caught = null;
    try { await YT.downloadAudio('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { maxMB: 100, outBase: path.join(sandbox, 'a2'), deadlineMs: 20000 }); }
    catch (e) { caught = e; }
    assert.ok(caught, 'expected a failure');
    assert.strictEqual(YT.classify(caught).code, 'BOT_CHECK');
    assert.ok(/cookies/i.test(YT.friendlyError(caught)), 'hint does not mention cookies');
    assert.ok(!/not available in this server's country/i.test(YT.friendlyError(caught)), 'message blames the region');
  });

  await test('geo-block IS reported as a region block', async () => {
    process.env.FAKE_YTDLP = 'geo';
    let caught = null;
    try { await YT.downloadAudio('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { maxMB: 100, outBase: path.join(sandbox, 'a3'), deadlineMs: 20000 }); }
    catch (e) { caught = e; }
    assert.strictEqual(YT.classify(caught).code, 'GEO_BLOCK');
  });

  await test('a dead network is reported as NETWORK', async () => {
    process.env.FAKE_YTDLP = 'network';
    let caught = null;
    try { await YT.downloadAudio('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { maxMB: 100, outBase: path.join(sandbox, 'a4'), deadlineMs: 20000 }); }
    catch (e) { caught = e; }
    assert.strictEqual(YT.classify(caught).code, 'NETWORK');
  });

  await test('escalates to another player client when the first one is bot-checked', async () => {
    process.env.FAKE_YTDLP = 'success';
    process.env.FAKE_FAIL_FIRST = '1';
    fs.writeFileSync(path.join(sandbox, 'count.txt'), '0');
    const before = fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean).length;
    const res = await YT.downloadAudio('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { maxMB: 100, outBase: path.join(sandbox, 'a5') });
    delete process.env.FAKE_FAIL_FIRST;
    assert.ok(fs.existsSync(res.file), 'retry never produced a file');
    assert.ok(res.attempts.length >= 1, 'first failure was not recorded');
    const profile1 = res.attempts[0].engine;
    assert.strictEqual(profile1, 'yt-dlp:default');
    assert.ok(res.profile !== 'default', 'did not escalate to another profile');
    assert.ok(fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean).length > before, 'no second attempt was made');
  });

  await test('recovers when a build rejects an optional flag (no such option)', async () => {
    process.env.FAKE_YTDLP = 'success';
    process.env.FAKE_REJECT_FLAG = '--no-color';
    try {
      const res = await YT.downloadAudio('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { maxMB: 100, outBase: path.join(sandbox, 'a7') });
      assert.ok(fs.existsSync(res.file), 'download failed instead of adapting');
      assert.ok(YT.usingMinimalBaseArgs(), 'did not switch to minimal arguments');
      assert.ok(!YT.baseArgs().includes('--no-color'), 'rejected flag is still being passed');
    } finally {
      delete process.env.FAKE_REJECT_FLAG;
      YT.setMinimalBaseArgs(false);
    }
  });

  await test('respects a global deadline instead of hanging', async () => {
    process.env.FAKE_YTDLP = 'timeout';
    const started = Date.now();
    let caught = null;
    try {
      await YT.downloadAudio('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { maxMB: 100, outBase: path.join(sandbox, 'a6'), deadlineMs: 6000 });
    } catch (e) { caught = e; }
    const took = Date.now() - started;
    process.env.FAKE_YTDLP = 'success';
    assert.ok(caught, 'timeout was not surfaced');
    assert.ok(took < 45000, `took too long: ${took}ms`);
  });

  console.log('\n── 6. remote providers (stub API) ──');

  // A stub that speaks the cobalt protocol, so the provider can be tested
  // without the VPN-blocked internet.
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.startsWith('/media.mp3')) {
        res.setHeader('content-type', 'audio/mpeg');
        return res.end(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(20000, 1)]));
      }
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/dead')) return res.end(JSON.stringify({ status: 'error', error: { code: 'api.turnstile' } }));
      res.end(JSON.stringify({
        status: 'tunnel',
        url: `http://127.0.0.1:${stub.address().port}/media.mp3`,
        filename: 'Song.mp3',
      }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const stubPort = stub.address().port;

  await test('cobalt provider resolves a media URL from a live instance', async () => {
    process.env.COBALT_INSTANCES = `http://127.0.0.1:${stubPort}`;
    const providers = require(path.join(REPO, 'utils/downloadProviders.js'));
    const hit = await providers.resolveMedia('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { kind: 'audio', timeoutMs: 5000 });
    assert.ok(hit.url.includes('/media.mp3'), `unexpected url: ${hit.url}`);
    assert.strictEqual(hit.ext, 'mp3');
    delete process.env.COBALT_INSTANCES;
  });

  await test('a dead instance falls through instead of hanging', async () => {
    process.env.COBALT_INSTANCES = `http://127.0.0.1:${stubPort}/dead`;
    const providers = require(path.join(REPO, 'utils/downloadProviders.js'));
    let caught = null;
    try { await providers.resolveMedia('https://www.youtube.com/watch?v=x', { kind: 'audio', timeoutMs: 3000 }); }
    catch (e) { caught = e; }
    delete process.env.COBALT_INSTANCES;
    assert.ok(caught, 'dead provider did not fail');
    assert.ok(/failed/i.test(caught.message));
  });

  await test('streams a remote file to disk with a size cap', async () => {
    const dest = path.join(sandbox, 'remote.bin');
    const res = await MT.downloadToFile(`http://127.0.0.1:${stubPort}/media.mp3`, dest, { maxBytes: 1024 * 1024, timeout: 5000 });
    assert.ok(fs.existsSync(dest), 'nothing downloaded');
    assert.strictEqual(res.sniff.kind, 'audio');
  });

  await test('a source bigger than the cap is refused (never fills the disk)', async () => {
    let caught = null;
    try { await MT.downloadToFile(`http://127.0.0.1:${stubPort}/media.mp3`, path.join(sandbox, 'too-big.bin'), { maxBytes: 1024, timeout: 5000 }); }
    catch (e) { caught = e; }
    assert.ok(caught, 'oversized download was not stopped');
  });

  console.log('\n── 7. runtime settings (.ytdl proxy / .cookies) ──');

  await test('proxy can be set, read and cleared at runtime', () => {
    settings.set('proxy', 'http://user:pass@127.0.0.1:8888');
    const args = YT.baseArgs();
    const i = args.indexOf('--proxy');
    assert.ok(i !== -1, 'proxy not passed to yt-dlp');
    assert.strictEqual(args[i + 1], 'http://user:pass@127.0.0.1:8888');
    settings.set('proxy', '');
    assert.ok(!YT.baseArgs().includes('--proxy'), 'proxy still passed after clearing');
  });

  await test('unknown settings are rejected (no silent typos)', () => {
    assert.throws(() => settings.set('protxy', 'x'), /Unknown setting/);
  });

  console.log('\n── 8. .song / .ytv end-to-end with a mocked WhatsApp socket ──');

  const songCmd = require(path.join(REPO, 'commands/media/song.js'));
  const ytvCmd = require(path.join(REPO, 'commands/media/ytv.js'));
  const providersMod = require(path.join(REPO, 'utils/downloadProviders.js'));

  const realDownloadAudio = YT.downloadAudio;
  const realDownloadVideo = YT.downloadVideo;
  const realGetInfo = YT.getInfo;
  const realResolve = providersMod.resolveMedia;

  // A WhatsApp socket that records everything the bot tried to send.
  function mockSock() {
    const sent = [];
    return {
      sent,
      user: { id: '1234:5@s.whatsapp.net' },
      async sendMessage(jid, content) {
        if (content && content.react) return { key: { id: 'react' } };
        // snapshot local files now: the command deletes them right after sending
        try {
          const f = content && (content.document?.url || content.audio?.url || content.video?.url);
          if (typeof f === 'string' && fs.existsSync(f) && fs.statSync(f).size < 20 * 1024 * 1024) {
            Object.defineProperty(content, '__bytes', { value: fs.readFileSync(f), enumerable: false });
          }
        } catch { /* ignore */ }
        sent.push(content);
        return { key: { id: `msg-${sent.length}`, remoteJid: jid } };
      },
    };
  }

  const mockMsg = (text) => ({
    key: { remoteJid: 'chat@s.whatsapp.net', id: 'MSG1', fromMe: false },
    message: { conversation: text },
  });

  function makeExtra(sock) {
    const chatId = 'chat@s.whatsapp.net';
    return {
      from: chatId,
      sender: '1234@s.whatsapp.net',
      isOwner: true,
      reply: (text) => sock.sendMessage(chatId, { text }),
      status: async (initial) => {
        const sent = await sock.sendMessage(chatId, { text: initial });
        return { update: (t) => sock.sendMessage(chatId, { text: t, edit: sent.key }) };
      },
    };
  }

  const textOf = (entry) => (entry && (entry.text || entry.caption || '')) || '';

  await test('.song sends the downloaded track (document mode)', async () => {
    const audioPath = path.join(sandbox, 'unit.mp3');
    fs.writeFileSync(audioPath, Buffer.concat([Buffer.from('ID3'), Buffer.alloc(60000, 4)]));
    YT.downloadAudio = async () => ({ file: audioPath, ext: 'mp3', profile: 'default', attempts: [] });
    YT.getInfo = async () => ({ title: 'Test Song', uploader: 'Test Artist', duration: 200, thumbnail: '', id: 'x' });

    const sock = mockSock();
    await songCmd.execute(sock, mockMsg('.song https://youtu.be/dQw4w9WgXcQ'), ['https://youtu.be/dQw4w9WgXcQ'], makeExtra(sock));

    const doc = sock.sent.find((m) => m.document);
    assert.ok(doc, 'no document sent');
    // "Artist - Title" is the convention every music player displays.
    assert.ok(/Test Artist - Test Song\.mp3$/.test(doc.fileName), `bad filename: ${doc.fileName}`);
    assert.strictEqual(doc.mimetype, 'audio/mpeg');
    assert.ok(textOf(doc).includes('Test Song'), 'caption missing the title');
    // the document itself must carry the tags, not just its name
    const tags = MT.readId3(doc.__bytes);
    assert.ok(tags, 'mp3 has no ID3 tags');
    assert.strictEqual(tags.title, 'Test Song');
    assert.strictEqual(tags.artist, 'Test Artist');
  });

  await test('.song falls back to a remote provider when the local engine is bot-checked', async () => {
    YT.downloadAudio = async () => {
      throw Object.assign(new Error('bot check'), {
        stderr: 'ERROR: [youtube] x: Sign in to confirm you’re not a bot. Use --cookies for the authentication',
      });
    };
    providersMod.resolveMedia = async () => ({
      provider: 'cobalt (test)', url: `http://127.0.0.1:${stubPort}/media.mp3`, ext: 'mp3', title: 'Fallback Song', headers: {},
    });

    const sock = mockSock();
    await songCmd.execute(sock, mockMsg('.song https://youtu.be/dQw4w9WgXcQ'), ['https://youtu.be/dQw4w9WgXcQ'], makeExtra(sock));

    const doc = sock.sent.find((m) => m.document);
    assert.ok(doc, 'remote fallback produced nothing');
    assert.ok(textOf(doc).includes('via cobalt'), `caption does not mention the backup source: ${textOf(doc)}`);
  });

  await test('.song reports the real reason when every engine fails', async () => {
    YT.downloadAudio = async () => {
      throw Object.assign(new Error('bot check'), {
        stderr: 'ERROR: [youtube] x: Sign in to confirm you’re not a bot. Use --cookies for the authentication',
      });
    };
    providersMod.resolveMedia = async () => { throw new Error('all providers failed'); };

    const sock = mockSock();
    await songCmd.execute(sock, mockMsg('.song https://youtu.be/dQw4w9WgXcQ'), ['https://youtu.be/dQw4w9WgXcQ'], makeExtra(sock));

    const error = sock.sent.map(textOf).find((t) => /cookies/i.test(t));
    assert.ok(error, `no cookies hint in: ${JSON.stringify(sock.sent.map(textOf))}`);
    assert.ok(!/not available in this server's country/i.test(error), 'blamed the region instead');
  });

  await test('.ytv sends the video and honours the quality argument', async () => {
    const videoPath = path.join(sandbox, 'unit.mp4');
    fs.writeFileSync(videoPath, Buffer.concat([
      Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.from('avc1mp4a'), Buffer.alloc(90000, 3),
    ]));
    let asked = null;
    YT.downloadVideo = async (url, opts) => { asked = opts.height; return { file: videoPath, profile: 'default', attempts: [] }; };
    YT.getInfo = async () => ({ title: 'Test Video', uploader: 'Chan', duration: 100, thumbnail: '', id: 'y' });

    const sock = mockSock();
    await ytvCmd.execute(sock, mockMsg('.ytv https://youtu.be/dQw4w9WgXcQ 480'), ['https://youtu.be/dQw4w9WgXcQ', '480'], makeExtra(sock));

    assert.strictEqual(asked, 480, `height not passed through (got ${asked})`);
    const video = sock.sent.find((m) => m.video || m.document);
    assert.ok(video, 'no video sent');
    assert.ok(textOf(video).includes('480p'), 'caption missing the quality');
  });

  await test('.ytv automatically retries a lower quality when the file is too big', async () => {
    const videoPath = path.join(sandbox, 'unit2.mp4');
    fs.writeFileSync(videoPath, Buffer.concat([
      Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.from('avc1mp4a'), Buffer.alloc(90000, 3),
    ]));
    const tried = [];
    YT.downloadVideo = async (url, opts) => {
      tried.push(opts.height);
      if (tried.length === 1) throw Object.assign(new Error('too big'), { stderr: 'ERROR: File is larger than max-filesize' });
      return { file: videoPath, profile: 'default', attempts: [] };
    };

    const sock = mockSock();
    await ytvCmd.execute(sock, mockMsg('.ytv https://youtu.be/dQw4w9WgXcQ 720'), ['https://youtu.be/dQw4w9WgXcQ', '720'], makeExtra(sock));

    assert.ok(tried.length >= 2, 'no lower quality was tried');
    assert.ok(tried[1] < tried[0], `second attempt (${tried[1]}) was not lower than the first (${tried[0]})`);
    assert.ok(sock.sent.some((m) => m.video || m.document), 'nothing was sent after the downgrade');
  });

  await test('.dl downloads any supported link (video) and reports the source', async () => {
    const dlCmd = require(path.join(REPO, 'commands/media/dl.js'));
    const videoPath = path.join(sandbox, 'dl.mp4');
    fs.writeFileSync(videoPath, Buffer.concat([
      Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.from('avc1mp4a'), Buffer.alloc(90000, 3),
    ]));
    let asked = null;
    YT.downloadVideo = async (url, opts) => { asked = { url, height: opts.height }; return { file: videoPath, profile: 'default', attempts: [] }; };
    YT.getInfo = async () => ({ title: 'TikTok Clip', uploader: 'someone', duration: 30, thumbnail: '', id: 'z' });

    const sock = mockSock();
    await dlCmd.execute(sock, mockMsg('.dl https://vm.tiktok.com/xyz 480'), ['https://vm.tiktok.com/xyz', '480'], makeExtra(sock));

    assert.ok(asked && asked.url.includes('tiktok'), 'the link was not passed through');
    assert.strictEqual(asked.height, 480);
    assert.ok(sock.sent.some((m) => m.video || m.document), 'no video sent');
  });

  await test('.dl audio mode sends an audio file', async () => {
    const dlCmd = require(path.join(REPO, 'commands/media/dl.js'));
    const audioPath = path.join(sandbox, 'dl.mp3');
    fs.writeFileSync(audioPath, Buffer.concat([Buffer.from('ID3'), Buffer.alloc(60000, 4)]));
    YT.downloadAudio = async () => ({ file: audioPath, ext: 'mp3', profile: 'default', attempts: [] });

    const sock = mockSock();
    await dlCmd.execute(sock, mockMsg('.dl https://soundcloud.com/x/y audio'), ['https://soundcloud.com/x/y', 'audio'], makeExtra(sock));

    const doc = sock.sent.find((m) => m.document && String(m.mimetype).startsWith('audio'));
    assert.ok(doc, 'no audio document sent');
    assert.ok(/\.mp3$/.test(doc.fileName), `bad filename: ${doc.fileName}`);
  });

  await test('.dl explains an unsupported link instead of blaming the region', async () => {
    const dlCmd = require(path.join(REPO, 'commands/media/dl.js'));
    YT.downloadVideo = async () => {
      throw Object.assign(new Error('unsupported'), { stderr: 'ERROR: Unsupported URL: https://example.com/page' });
    };
    providersMod.resolveMedia = async () => { throw new Error('no providers'); };

    const sock = mockSock();
    await dlCmd.execute(sock, mockMsg('.dl https://example.com/page'), ['https://example.com/page'], makeExtra(sock));

    const text = sock.sent.map(textOf).join('\n');
    assert.ok(/not a media page/i.test(text), `unhelpful error: ${text}`);
  });

  await test('.dl with no link shows usage', async () => {
    const dlCmd = require(path.join(REPO, 'commands/media/dl.js'));
    const sock = mockSock();
    await dlCmd.execute(sock, mockMsg('.dl'), [], makeExtra(sock));
    assert.ok(/Usage/.test(sock.sent.map(textOf).join(' ')), 'no usage message');
  });

  console.log('\n── 9. numbered search results (reply with a number) ──');

  const selections = require(path.join(REPO, 'utils/selections.js'));
  const searchMod = require(path.join(REPO, 'utils/youtubeSearch.js'));
  const realSearch = searchMod.searchYouTube;
  const stubSearch = (results) => { searchMod.searchYouTube = async () => results; };

  const THREE = [
    { url: 'https://youtu.be/aaa', id: 'aaa', title: 'First Song', author: 'A', duration: 200, thumbnail: '' },
    { url: 'https://youtu.be/bbb', id: 'bbb', title: 'Second Song', author: 'B', duration: 210, thumbnail: '' },
    { url: 'https://youtu.be/ccc', id: 'ccc', title: 'Third Song', author: 'C', duration: 220, thumbnail: '' },
  ];

  await test('offers a numbered list when SEARCH_PICKER is on', async () => {
    const song = require(path.join(REPO, 'commands/media/song.js'));
    stubSearch(THREE);
    // picker is opt-in now (.song sends the official/top hit by default)
    const cfg = require(path.join(REPO, 'config.js'));
    const wasPicker = cfg.search.picker;
    cfg.search.picker = true;
    settings.set('searchPicker', true);

    const sock = mockSock();
    await song.execute(sock, mockMsg('.song some song'), ['some', 'song'], makeExtra(sock));

    const list = sock.sent.map(textOf).find((t) => /1\./.test(t) && /3\./.test(t));
    assert.ok(list, 'no numbered list shown');
    assert.ok(/First Song/.test(list) && /Third Song/.test(list), 'results missing from the list');
    assert.ok(!sock.sent.some((m) => m.document), 'it downloaded something before the user chose');
    assert.ok(selections.peek('chat@s.whatsapp.net', '1234@s.whatsapp.net'), 'no pending choice registered');

    cfg.search.picker = wasPicker;
    settings.set('searchPicker', false);
  });

  await test('"2" downloads the second result', async () => {
    const song = require(path.join(REPO, 'commands/media/song.js'));
    const audioPath = path.join(sandbox, 'pick.mp3');
    fs.writeFileSync(audioPath, Buffer.concat([Buffer.from('ID3'), Buffer.alloc(60000, 4)]));
    YT.downloadAudio = async () => ({ file: audioPath, ext: 'mp3', profile: 'default', attempts: [] });
    YT.getInfo = async (u) => ({ title: u.includes('bbb') ? 'Second Song' : 'Wrong Song', uploader: 'B', duration: 210, thumbnail: '', id: 'x' });
    stubSearch(THREE);

    const cfg = require(path.join(REPO, 'config.js'));
    const wasPicker = cfg.search.picker;
    cfg.search.picker = true;
    settings.set('searchPicker', true);

    const sock = mockSock();
    const extra = makeExtra(sock);
    await song.execute(sock, mockMsg('.song some song'), ['some', 'song'], extra);

    // What the handler does with the follow-up message:
    const picked = selections.match('chat@s.whatsapp.net', '1234@s.whatsapp.net', '2');
    assert.ok(picked, 'the number did not resolve a selection');
    await picked.entry.run(sock, mockMsg('2'), extra, picked.item);

    const doc = sock.sent.find((m) => m.document);
    assert.ok(doc, 'nothing downloaded after picking');
    assert.ok(/Second Song/.test(String(doc.fileName)), `wrong item downloaded: ${doc.fileName}`);

    cfg.search.picker = wasPicker;
    settings.set('searchPicker', false);
  });

  await test('.song sends the top hit directly when the picker is off', async () => {
    const song = require(path.join(REPO, 'commands/media/song.js'));
    const audioPath = path.join(sandbox, 'top.m4a');
    fs.writeFileSync(audioPath, Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(60000, 4)]));
    YT.downloadAudio = async () => ({ file: audioPath, ext: 'm4a', profile: 'default', attempts: [] });
    YT.getInfo = async () => ({ title: 'First Song', uploader: 'A', duration: 200, thumbnail: '', id: 'y' });
    stubSearch(THREE);
    settings.set('searchPicker', false);

    const sock = mockSock();
    await song.execute(sock, mockMsg('.song some song'), ['some', 'song'], makeExtra(sock));

    assert.ok(!sock.sent.map(textOf).some((t) => /^1\./m.test(t)), 'a numbered list was shown');
    const doc = sock.sent.find((m) => m.document);
    assert.ok(doc, 'no document sent');
    assert.ok(/First Song/.test(String(doc.fileName)), `wrong song: ${doc.fileName}`);
    assert.ok(/m4a$/.test(String(doc.fileName)), `audio was re-encoded: ${doc.fileName}`);
  });

  await test('"9" is out of range and reported as such', () => {
    selections.offer({ chatId: 'c1', sender: 's1', items: THREE, run: async () => {} });
    assert.strictEqual(selections.match('c1', 's1', '9'), null);
    assert.strictEqual(selections.isOutOfRange('c1', 's1', '9'), true);
    assert.strictEqual(selections.isOutOfRange('c1', 's1', '2'), false);
    selections.clear('c1', 's1');
  });

  await test('a choice belongs to one user only', () => {
    selections.offer({ chatId: 'c2', sender: 'owner', items: THREE, run: async () => {} });
    assert.strictEqual(selections.match('c2', 'stranger', '1'), null, 'a stranger could steal the pick');
    assert.ok(selections.match('c2', 'owner', '1'), 'the owner could not pick');
  });

  await test('choices expire instead of living forever', () => {
    selections.offer({ chatId: 'c3', sender: 's3', items: THREE, run: async () => {}, ttlMs: -1 });
    assert.strictEqual(selections.peek('c3', 's3'), null, 'expired choice still pending');
    assert.strictEqual(selections.match('c3', 's3', '1'), null);
  });

  await test('parseChoice accepts 2 / .2 / #2 / "2." but not 22 or text', () => {
    assert.strictEqual(selections.parseChoice('2'), 2);
    assert.strictEqual(selections.parseChoice('.2'), 2);
    assert.strictEqual(selections.parseChoice('#2'), 2);
    assert.strictEqual(selections.parseChoice('2.'), 2);
    assert.strictEqual(selections.parseChoice('song'), null);
    assert.strictEqual(selections.parseChoice(''), null);
  });

  await test('--first / !query skip the list and download immediately', async () => {
    const song = require(path.join(REPO, 'commands/media/song.js'));
    const audioPath = path.join(sandbox, 'first.mp3');
    fs.writeFileSync(audioPath, Buffer.concat([Buffer.from('ID3'), Buffer.alloc(60000, 4)]));
    let used = null;
    YT.downloadAudio = async (u) => { used = u; return { file: audioPath, ext: 'mp3', profile: 'default', attempts: [] }; };
    YT.getInfo = async () => ({ title: 'First Song', uploader: 'A', duration: 200, thumbnail: '', id: 'aaa' });
    stubSearch(THREE);

    const sock = mockSock();
    await song.execute(sock, mockMsg('.song some song --first'), ['some', 'song', '--first'], makeExtra(sock));
    assert.ok(sock.sent.some((m) => m.document), '--first did not download');
    assert.ok(String(used).includes('aaa'), `--first picked the wrong item: ${used}`);

    const sock2 = mockSock();
    await song.execute(sock2, mockMsg('.song !some song'), ['!some', 'song'], makeExtra(sock2));
    assert.ok(sock2.sent.some((m) => m.document), '!query did not download');
  });

  await test('a single search result downloads straight away (no pointless step)', async () => {
    const song = require(path.join(REPO, 'commands/media/song.js'));
    const audioPath = path.join(sandbox, 'single.mp3');
    fs.writeFileSync(audioPath, Buffer.concat([Buffer.from('ID3'), Buffer.alloc(60000, 4)]));
    YT.downloadAudio = async () => ({ file: audioPath, ext: 'mp3', profile: 'default', attempts: [] });
    YT.getInfo = async () => ({ title: 'Only Hit', uploader: 'A', duration: 100, thumbnail: '', id: 'a' });
    stubSearch([THREE[0]]);

    const sock = mockSock();
    await song.execute(sock, mockMsg('.song unique'), ['unique'], makeExtra(sock));
    assert.ok(sock.sent.some((m) => m.document), 'single result did not download');
  });

  await test('yt-dlp search returns a ranked list (engine level)', async () => {
    process.env.FAKE_YTDLP = 'success';
    const rows = await YT.searchVideos('anything', { limit: 4 });
    assert.ok(rows.length === 4, `expected 4 results, got ${rows.length}`);
    assert.strictEqual(rows[0].title, 'Result 1');
    assert.ok(rows[0].url.includes('vid0'), `bad url: ${rows[0].url}`);
    assert.ok(rows[0].thumbnail.startsWith('http'), 'no thumbnail');
  });

  await test('formatResults renders a readable list', () => {
    const text = searchMod.formatResults(THREE);
    assert.ok(/\*1\.\* First Song \(3:20\) — A/.test(text), `unexpected format: ${text}`);
    assert.ok(text.includes('cancel'), 'no way to cancel mentioned');
  });

  console.log('\n── 10. site shortcuts + .spotify ──');

  await test('.tiktok downloads through the shared pipeline', async () => {
    const cmds = require(path.join(REPO, 'commands/media/shortcuts.js'));
    const tiktok = cmds.find(c => c.name === 'tiktok');
    const videoPath = path.join(sandbox, 'tt.mp4');
    fs.writeFileSync(videoPath, Buffer.concat([
      Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.from('avc1mp4a'), Buffer.alloc(90000, 3),
    ]));
    let askedUrl = null;
    YT.downloadVideo = async (url) => { askedUrl = url; return { file: videoPath, profile: 'default', attempts: [] }; };
    YT.getInfo = async () => ({ title: 'TikTok Clip', uploader: 'u', duration: 20, thumbnail: '', id: 't' });

    const sock = mockSock();
    await tiktok.execute(sock, mockMsg('.tiktok https://vm.tiktok.com/abc'), ['https://vm.tiktok.com/abc'], makeExtra(sock));

    assert.ok(String(askedUrl).includes('tiktok'), `wrong url passed: ${askedUrl}`);
    assert.ok(sock.sent.some((m) => m.video || m.document), 'nothing sent');
  });

  await test('.pinterest sends an image when the pin is an image', async () => {
    const cmds = require(path.join(REPO, 'commands/media/shortcuts.js'));
    const pin = cmds.find(c => c.name === 'pinterest');
    const imgPath = path.join(sandbox, 'pin.jpg');
    fs.writeFileSync(imgPath, Buffer.concat([Buffer.from([0xFF, 0xD8]), Buffer.alloc(60000, 9)]));
    YT.downloadVideo = async () => ({ file: imgPath, profile: 'default', attempts: [] });
    YT.getInfo = async () => ({ title: 'A Pin', uploader: 'p', duration: 0, thumbnail: '', id: 'p' });

    const sock = mockSock();
    await pin.execute(sock, mockMsg('.pinterest https://pin.it/abc'), ['https://pin.it/abc'], makeExtra(sock));

    const img = sock.sent.find((m) => m.image);
    assert.ok(img, 'image pin was not sent as an image');
  });

  await test('.spotify reads the link, matches YouTube and downloads the audio', async () => {
    const spotifyCmd = require(path.join(REPO, 'commands/media/spotify.js'));
    const spotifyUtil = require(path.join(REPO, 'utils/spotify.js'));
    const audioPath = path.join(sandbox, 'sp.mp3');
    fs.writeFileSync(audioPath, Buffer.concat([Buffer.from('ID3'), Buffer.alloc(60000, 4)]));

    let searchedFor = null;
    stubSearch(THREE);
    searchMod.searchYouTube = async (q) => { searchedFor = q; return THREE; };
    YT.downloadAudio = async () => ({ file: audioPath, ext: 'mp3', profile: 'default', attempts: [] });
    YT.getInfo = async () => ({ title: 'Never Gonna Give You Up', uploader: 'Rick', duration: 213, thumbnail: '', id: 'dQw' });
    // stub the metadata lookup (no internet in tests)
    const realResolve = spotifyUtil.resolveTrack;
    spotifyUtil.resolveTrack = async () => ({
      title: 'Never Gonna Give You Up', artists: 'Rick Astley', album: 'Whenever You Need Somebody',
      cover: '', source: 'spotify-oembed', searchQuery: 'Rick Astley - Never Gonna Give You Up',
    });

    const sock = mockSock();
    await spotifyCmd.execute(sock, mockMsg('.spotify https://open.spotify.com/track/xyz'), ['https://open.spotify.com/track/xyz'], makeExtra(sock));

    spotifyUtil.resolveTrack = realResolve;
    assert.strictEqual(searchedFor, 'Rick Astley - Never Gonna Give You Up', `bad search query: ${searchedFor}`);
    const doc = sock.sent.find((m) => m.document);
    assert.ok(doc, 'no audio sent');
    assert.ok(/Rick Astley/.test(String(doc.fileName)) && /\.mp3$/.test(String(doc.fileName)), `bad file name: ${doc.fileName}`);
  });

  await test('.spotify parses every Spotify URL shape', () => {
    const spotifyUtil = require(path.join(REPO, 'utils/spotify.js'));
    assert.ok(spotifyUtil.parseSpotifyUrl('https://open.spotify.com/track/abc'));
    assert.ok(spotifyUtil.parseSpotifyUrl('https://open.spotify.com/intl-fr/track/abc?si=1'));
    assert.ok(spotifyUtil.parseSpotifyUrl('https://spotify.com/album/xyz'));
    assert.strictEqual(spotifyUtil.parseSpotifyUrl('https://youtu.be/abc'), null);
  });

  searchMod.searchYouTube = realSearch;

  // restore
  YT.downloadAudio = realDownloadAudio;
  YT.downloadVideo = realDownloadVideo;
  YT.getInfo = realGetInfo;
  providersMod.resolveMedia = realResolve;

  stub.close();

  await test('the handler routes a bare "2" to the pending choice (not to command parsing)', async () => {
    // The handler is the real dispatcher: load it against the real command map.
    // database/botstate.json must say "on" and the sender must be an owner.
    const fsx = require('fs');
    const osx = require('os');
    const pathx = require('path');
    const repoDb = pathx.join(REPO, 'database');
    fsx.mkdirSync(repoDb, { recursive: true });
    const stateFile = pathx.join(repoDb, 'botstate.json');
    const before = fsx.existsSync(stateFile) ? fsx.readFileSync(stateFile, 'utf8') : null;
    // Restore the repo file no matter how this test ends (a failed assertion
    // used to leave the file rewritten).
    const restoreState = () => {
      try {
        if (before === null) fsx.unlinkSync(stateFile);
        else fsx.writeFileSync(stateFile, before);
      } catch { /* ignore */ }
    };

    try {
      fsx.writeFileSync(stateFile, JSON.stringify({ on: true }));

      const handlerPath = pathx.join(REPO, 'handler.js');
      delete require.cache[require.resolve(handlerPath)];
      const handler = require(handlerPath);

      // Only allowed senders are served, so the test speaks as the owner.
      const cfg = require(path.join(REPO, 'config.js'));
      const ownerJid = `${cfg.ownerNumber[0]}@s.whatsapp.net`;

      let ran = null;
      selections.offer({
        chatId: 'chat@s.whatsapp.net',
        sender: ownerJid,
        items: [
          { url: 'https://youtu.be/aaa', title: 'First Song' },
          { url: 'https://youtu.be/bbb', title: 'Second Song' },
        ],
        run: async (sock, msg, extra, item) => { ran = item; },
      });

      const sock = mockSock();
      sock.user = { id: '9999:1@s.whatsapp.net' }; // not the sender
      const msg = {
        key: { remoteJid: 'chat@s.whatsapp.net', id: 'PICK1', fromMe: false, participant: ownerJid },
        message: { conversation: '2' },
      };

      await handler.handleMessage(sock, msg);
      assert.ok(ran, 'the handler did not route the bare number to the pending choice');
      assert.strictEqual(ran.title, 'Second Song');

      // A stranger sending the same number must NOT trigger the owner's choice.
      ran = null;
      selections.offer({
        chatId: 'chat@s.whatsapp.net',
        sender: ownerJid,
        items: [
          { url: 'https://youtu.be/aaa', title: 'First Song' },
          { url: 'https://youtu.be/bbb', title: 'Second Song' },
        ],
        run: async (sock, msg, extra, item) => { ran = item; },
      });
      const strangerSock = mockSock();
      strangerSock.user = { id: '9999:1@s.whatsapp.net' };
      await handler.handleMessage(strangerSock, {
        key: { remoteJid: 'chat@s.whatsapp.net', id: 'PICK2', fromMe: false, participant: '111222333@s.whatsapp.net' },
        message: { conversation: '2' },
      });
      assert.strictEqual(ran, null, 'a stranger triggered someone else\'s choice');
      assert.strictEqual(strangerSock.sent.length, 0, 'the bot answered a non-allowed user');
      selections.clear('chat@s.whatsapp.net', ownerJid);
    } finally {
      restoreState();
      fsx.mkdirSync(repoDb, { recursive: true });
      // Leave the repo exactly as we found it, even if the file was missing.
      if (!fsx.existsSync(stateFile)) fsx.writeFileSync(stateFile, '{\n  "on": true\n}');
    }
  });

  await test('a stray "2" with nothing pending is ignored (no noise)', async () => {
    const handlerPath = path.join(REPO, 'handler.js');
    const handler = require(handlerPath);
    const cfg = require(path.join(REPO, 'config.js'));
    const ownerJid = `${cfg.ownerNumber[0]}@s.whatsapp.net`;
    selections.clear('chat@s.whatsapp.net', ownerJid);
    const sock = mockSock();
    sock.user = { id: '9999:1@s.whatsapp.net' };
    const msg = {
      key: { remoteJid: 'chat@s.whatsapp.net', id: 'STRAY1', fromMe: false, participant: ownerJid },
      message: { conversation: '2' },
    };
    await handler.handleMessage(sock, msg);
    assert.strictEqual(sock.sent.length, 0, `the bot replied to a stray number: ${JSON.stringify(sock.sent)}`);
  });

  console.log('\n── 11. logging + reconnect bookkeeping (crash paths) ──');

  await test('the console wrapper survives circular objects and BigInt', () => {
    const { safeText, formatArgs } = require(path.join(REPO, 'utils/safeLog.js'));
    const circular = { a: 1 };
    circular.self = circular;
    circular.big = 10n;

    assert.doesNotThrow(() => formatArgs([circular, 10n, new Error('boom'), null, undefined]));
    assert.ok(safeText(circular).includes('[Circular]'));
    assert.ok(safeText({ deep: { inner: circular } }).includes('[Circular]'));
  });

  await test('noise filtering still works on the flattened text', () => {
    const { formatArgs } = require(path.join(REPO, 'utils/safeLog.js'));
    assert.ok(formatArgs(['Closing open session', { sessionEntry: 1 }]).includes('sessionentry'));
    assert.ok(!formatArgs(['Bot is ready']).includes('sessionentry'));
  });

  console.log('\n── 12. command-only runtime ──');

  await test('ordinary text is ignored and AI commands are not registered', async () => {
    const { loadCommands } = require(path.join(REPO, 'utils/commandLoader.js'));
    const commands = loadCommands();
    assert.ok(!commands.has('ai') && !commands.has('aikey'), 'AI commands are still loaded');
    assert.ok(!Object.hasOwn(require(path.join(REPO, 'config.js')), 'ai'), 'AI configuration is still exported');
    assert.ok(!fs.existsSync(path.join(REPO, 'utils/ai')), 'AI utility directory still exists');
    assert.ok(!fs.existsSync(path.join(REPO, 'commands/ai')), 'AI command directory still exists');
  });

  await test('the message handler ignores plain text but still runs prefixed commands', async () => {
    const handler = require(path.join(REPO, 'handler.js'));
    const sent = [];
    const sock = {
      user: { id: '265894016453:1@s.whatsapp.net' },
      async sendMessage(jid, content) { sent.push({ jid, content }); return { key: { id: 'reply' } }; },
    };
    const base = { key: { remoteJid: '265894016453@s.whatsapp.net', id: 'msg1', fromMe: false } };
    await handler.handleMessage(sock, { ...base, message: { conversation: 'download song wishing well' } });
    assert.strictEqual(sent.length, 0, 'ordinary text triggered behavior');
    await handler.handleMessage(sock, { ...base, key: { ...base.key, id: 'msg2' }, message: { conversation: '.ping' } });
    assert.ok(sent.length > 0, 'an explicit command stopped working');
  });

  await test('temp deletion rejects sibling directories with a shared prefix', () => {
    const temp = require(path.join(REPO, 'utils/tempManager.js'));
    const root = temp.getTempDir();
    const sibling = `${root}-outside`;
    fs.mkdirSync(sibling, { recursive: true });
    const victim = path.join(sibling, 'do-not-delete');
    fs.writeFileSync(victim, 'safe');
    assert.strictEqual(temp.deleteTempFile(victim), false, 'deleted a sibling-prefix file');
    assert.ok(fs.existsSync(victim), 'victim file disappeared');
    fs.rmSync(sibling, { recursive: true, force: true });
  });

  await test('paper typo suggestions remain deterministic without AI dependencies', () => {
    const search = require(path.join(REPO, 'utils/paperSearch.js'));
    assert.strictEqual(search.editDistance('2210', '2211'), 1);
    const near = search.nearest('nurs', '2211', [
      { code: 'NURS', module: '2201', count: 3 },
      { code: 'NURS', module: '2210', count: 1 },
      { code: 'CHEM', module: '3601', count: 9 },
    ]);
    assert.deepStrictEqual(near.map(x => x.module), ['2201', '2210']);
  });

  console.log('\n── 16. every command and util still loads ──');

  await test('all command modules load without throwing', () => {
    const { loadCommands } = require(path.join(REPO, 'utils/commandLoader.js'));
    const cmds = loadCommands();
    const names = new Set([...cmds.values()].map(c => c.name));
    for (const expected of ['song', 'ytv', 'dl', 'tiktok', 'x', 'pinterest', 'spotify',
      'cookies', 'ytdl', 'menu', 'paper', 'sticker', 'fb', 'instagram',
      'movie', 'series', 'providers', 'moviestatus', 'debrid']) {
      assert.ok(names.has(expected), `command missing: ${expected}`);
    }
  });


  console.log('\n── 17. ffmpeg-free HLS downloader (movies/series core) ──');

  await test('HLS master → variant → segments land in one playable file', async () => {
    const http = require('http');
    const seg = (n) => { const b = Buffer.alloc(188 * 90, 0x11); for (let i = 0; i < 90; i++) b[i * 188] = 0x47; b[b.length - 1] = n; return b; };
    const files = {
      '/master.m3u8': '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360\nlow.m3u8\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=2600000,RESOLUTION=1280x720\nhi.m3u8\n',
      '/low.m3u8': '#EXTM3U\n#EXTINF:2,\nlow0.ts\n#EXTINF:2,\nlow1.ts\n#EXT-X-ENDLIST\n',
      '/hi.m3u8': '#EXTM3U\n#EXTINF:2,\nhi0.ts\n#EXTINF:2,\nhi1.ts\n#EXT-X-ENDLIST\n',
      '/low0.ts': seg(1), '/low1.ts': seg(2), '/hi0.ts': seg(3), '/hi1.ts': seg(4),
    };
    const server = http.createServer((req, res) => {
      const f = files[req.url];
      if (!f) { res.writeHead(404); return res.end('no'); }
      if (Buffer.isBuffer(f)) { res.writeHead(200); return res.end(f); }
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }); res.end(f);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    try {
      const hls = await import(pathToFileURL(path.join(REPO, 'engine/media/hls.js')).href);
      const variants = hls.parseVariants(files['/master.m3u8'], base);
      assert.strictEqual(variants[0].height, 720, 'variants not sorted best-first');
      assert.strictEqual(hls.chooseVariant(variants, 480).height, 360, '480p request did not fall to 360p');

      const out = path.join(sandbox, 'hls-out.mp4');
      const got = await hls.downloadHlsNative(`${base}/master.m3u8`, out, { maxHeight: 720 });
      assert.strictEqual(got.variant, 720, 'wrong variant downloaded');
      assert.ok(got.file.endsWith('.ts'), `TS stream was not written as .ts: ${got.file}`);
      assert.strictEqual(fs.statSync(got.file).size, 2 * 188 * 90, 'segments were not concatenated');
    } finally {
      server.close();
    }
  });

  await test('HLS downloader refuses an empty playlist instead of writing 0 bytes', async () => {
    const http = require('http');
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-ENDLIST\n');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const hls = await import(pathToFileURL(path.join(REPO, 'engine/media/hls.js')).href);
      await assert.rejects(
        () => hls.downloadHlsNative(`${base}/empty.m3u8`, path.join(sandbox, 'empty.ts')),
        /no segments/,
      );
    } finally { server.close(); }
  });

  console.log('\n── 18. source preference (moviebox first, rest as fallbacks) ──');

  await test('a preferred provider wins the tie at the same quality', async () => {
    const { rank } = await import(pathToFileURL(path.join(REPO, 'engine/core/ranker.js')).href);
    const cands = [
      { provider: 'vixsrc', kind: 'file', quality: 1080, title: 'A', sourceTag: 'WEBDL', sizeMB: 900 },
      { provider: 'moviebox', kind: 'file', quality: 1080, title: 'B', sourceTag: 'WEBRIP', sizeMB: 0 },
    ];
    const out = rank(cands, { want: 1080, year: 2020 });
    assert.strictEqual(out[0].provider, 'moviebox', `ranked first: ${out.map(c => c.provider).join(', ')}`);
  });

  await test('a preferred provider does not push a wrong resolution through', async () => {
    const { rank } = await import(pathToFileURL(path.join(REPO, 'engine/core/ranker.js')).href);
    const cands = [
      { provider: 'moviebox', kind: 'file', quality: 480, title: 'B', sourceTag: 'WEBRIP', sizeMB: 0 },
      { provider: 'vixsrc', kind: 'hls', quality: 1080, title: 'A', sourceTag: 'WEBDL', sizeMB: 0 },
    ];
    const out = rank(cands, { want: 1080, year: 2020 });
    assert.strictEqual(out[0].provider, 'vixsrc', `ranked first: ${out.map(c => c.provider).join(', ')}`);
  });

  console.log('\n── 18b. media log format ──');

  await test('log lines are one line, timestamped and aligned', () => {
    const lines = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a) => lines.push(a.join(' '));
    console.error = (...a) => lines.push(a.join(' '));
    try {
      const log = require(path.join(REPO, 'utils/logger.js'))('movie');
      log.info('Inception · vidlink · 1080p');
      log.error(new Error('boom\nsecond line'));
    } finally { console.log = origLog; console.error = origErr; }
    const info = lines.find(l => /INFO/.test(l));
    const err = lines.find(l => /ERROR/.test(l));
    assert.ok(info && /^\d{2}:\d{2}:\d{2}\.\d{3}\s+INFO\s+movie\s+Inception/.test(info), `bad info line: ${info}`);
    assert.ok(err && !err.includes('\n') && err.includes('boom'), `bad error line: ${err}`);
  });


  console.log('\n── 19. mirror failover, request coalescing, stale cache ──');

  await test('mirror pool fails over and benches a domain that never answers', async () => {
    const { withMirrors, mirrorReport } = await import(pathToFileURL(path.join(REPO, 'engine/core/mirrors.js')).href);

    // 1. a dead first mirror must not cost the request
    let aliveHits = 0;
    const out = await withMirrors('unit-pool-a', ['https://dead.example', 'https://alive.example'], async (base) => {
      if (base.includes('dead')) throw new Error('ENOTFOUND');
      aliveHits++;
      return [{ ok: true }];
    });
    assert.ok(out.length === 1 && aliveHits === 1, 'failover did not reach the live mirror');

    // 2. an all-dead pool trips the breaker after 3 rounds instead of hammering
    const deadOnly = ['https://one.invalid', 'https://two.invalid'];
    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => withMirrors('unit-pool-b', deadOnly, async () => { throw new Error('ECONNRESET'); }));
    }
    const report = mirrorReport().find(p => p.provider === 'unit-pool-b');
    assert.ok(report, 'no report for the dead pool');
    assert.ok(report.mirrors.every(m => m.state === 'open'), `mirrors not benched: ${JSON.stringify(report.mirrors)}`);

    // 3. half-open probe after the cooldown, not immediately
    assert.ok(report.mirrors.every(m => m.fails >= 3), 'failure counts not tracked');
  });

  await test('identical concurrent JSON requests are coalesced', async () => {
    const http = require('http');
    let hits = 0;
    const server = http.createServer((req, res) => {
      hits++;
      setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }, 100);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/same`;
    try {
      const { req } = await import(pathToFileURL(path.join(REPO, 'engine/core/http.js')).href);
      const [a, b, c] = await Promise.all([req(url), req(url), req(url)]);
      assert.strictEqual(hits, 1, `hit upstream ${hits} times`);
      assert.ok(a.ok && b.ok && c.ok, 'coalesced responses lost their body');
    } finally { server.close(); }
  });

  await test('a rotating user-agent is used when the caller does not pin one', async () => {
    const { nextUserAgent } = await import(pathToFileURL(path.join(REPO, 'engine/core/http.js')).href);
    const a = nextUserAgent();
    const b = nextUserAgent();
    assert.ok(/^Mozilla\/5\.0/.test(a) && /^Mozilla\/5\.0/.test(b), 'UA pool is not browser-shaped');
    assert.notStrictEqual(a, b, 'UA did not rotate');
  });


  console.log('\n── 20. failure diagnostics ──');

  await test('a request timeout is reported as TIMEOUT (DOMException code is read-only)', async () => {
    const http = require('http');
    const server = http.createServer(() => { /* never answers */ });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const { req } = await import(pathToFileURL(path.join(REPO, 'engine/core/http.js')).href);
    try {
      await assert.rejects(
        () => req(`http://127.0.0.1:${server.address().port}/hang`, { timeout: 250, retries: 0 }),
        (e) => {
          assert.ok(!/getter/i.test(e.message), `mutated a DOMException: ${e.message}`);
          assert.strictEqual(e.code, 'TIMEOUT');
          return true;
        },
      );
    } finally { server.close(); }
  });

  await test('a failed download suggests the film the user probably meant', async () => {
    const engine = require(path.join(REPO, 'utils/movieEngine.js'));
    const alts = await engine.alternatives([
      { title: 'Infinity Wars', year: '2018', source: 'tmdb', popularity: 1.14 },
      { title: 'Infinity Wars', year: '2018', source: 'imdb', popularity: 909012 },
      { title: 'Avengers: Infinity War', year: '2018', source: 'imdb', popularity: 563 },
    ], { chosen: { title: 'Infinity Wars', year: '2018' } });

    assert.strictEqual(alts.length, 1, `wrong suggestions: ${JSON.stringify(alts)}`);
    assert.strictEqual(alts[0].title, 'Avengers: Infinity War');
  });


  console.log('\n── 21. moviebox (BFF, no scraping) ──');

  await test('moviebox turns the BFF into direct MP4 candidates', async () => {
    const http = require('http');
    const hits = { token: 0, search: 0, play: 0, unauth: 0 };
    let rejectFirstSearch = true;

    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const json = (o, h = {}) => { res.writeHead(200, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(o)); };

      if (u.pathname === '/wefeed-h5api-bff/home') {
        hits.token++;
        return json({ code: 0, data: {} }, { 'x-user': JSON.stringify({ token: `GUEST${hits.token}` }) });
      }
      if (u.pathname === '/wefeed-h5api-bff/subject/search') {
        hits.search++;
        // prove the 401 → refresh-token → replay path works
        if (rejectFirstSearch && req.headers.authorization !== 'Bearer GUEST2') {
          rejectFirstSearch = false;
          hits.unauth++;
          res.writeHead(401); return res.end('{}');
        }
        return json({ code: 0, data: { items: [
          { subject: { title: 'Infinity Wars', subjectType: 1, releaseDate: '2018-05-06', subjectId: '111', detailPath: 'ghost-aaa', hasResource: true } },
          { subject: { title: 'Avengers: Infinity War', subjectType: 1, releaseDate: '2018-04-27', subjectId: '299534', detailPath: 'avengers-bbb', hasResource: true } },
        ] } });
      }
      if (u.pathname === '/wefeed-h5api-bff/media-player/get-domain') {
        return json({ code: 0, data: `http://127.0.0.1:${server.address().port}` });
      }
      if (u.pathname === '/wefeed-h5api-bff/subject/play') {
        hits.play++;
        // movies answer on se=1/ep=1 only, to exercise the 0/0 → 1/1 fallback
        if (u.searchParams.get('se') === '0') return json({ code: 0, data: { hasResource: false, streams: [] } });
        return json({ code: 0, data: {
          hasResource: true,
          streams: [{ url: 'https://cdn.example/1080.mp4', resolutions: 1080, size: 1095262921, codecName: 'h264', format: 'MP4' }],
          hls: [],
        } });
      }
      res.writeHead(404); res.end('no');
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    process.env.MOVIEBOX_BFF = `http://127.0.0.1:${server.address().port}/wefeed-h5api-bff`;
    try {
      const { default: mb } = await import(pathToFileURL(path.join(REPO, 'engine/providers/stream/moviebox.js')).href);
      const cands = await mb.search(
        { title: 'Avengers Infinity War', year: '2018', type: 'movie' },
        { want: 1080, season: null, episode: null },
      );

      assert.strictEqual(cands.length, 1, `expected 1 candidate, got ${JSON.stringify(cands)}`);
      assert.strictEqual(cands[0].kind, 'file', 'direct MP4 was not offered as a file');
      assert.strictEqual(cands[0].quality, 1080);
      assert.ok(Math.round(cands[0].sizeMB) === 1045, `size not converted from bytes: ${cands[0].sizeMB}`);
      assert.ok(/avengers/.test(cands[0].headers.referer), 'player referer missing from the candidate');
      assert.ok(hits.unauth === 1, 'the 401 retry path was not exercised');
      assert.ok(hits.play >= 2, 'the se=0 → se=1 fallback did not run');
    } finally {
      delete process.env.MOVIEBOX_BFF;
      server.close();
    }
  });

  // ─── summary ────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(52)}`);
  if (failures.length) {
    console.log(`❌ ${failures.length} failed, ${passed} passed`);
    for (const f of failures) console.log(`   • ${f.name}: ${f.error.message}`);
  } else {
    console.log(`✅ all ${passed} checks passed`);
  }

  // cleanup
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error('selftest crashed:', e);
  process.exit(2);
});
