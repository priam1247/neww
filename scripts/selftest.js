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
require(path.join(REPO, 'utils/telemetry.js'))._resetForTests(path.join(sandbox, 'telemetry.json'));
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
    // Regular users get a plain anti-bot explanation without owner-only commands;
    // owners get the .cookies / .ytdl admin hints.
    assert.ok(!/\.cookies|\.ytdl/i.test(YT.friendlyError(caught)), 'admin hint leaked to regular user');
    assert.ok(/anti-bot|automated access/i.test(YT.friendlyError(caught)), 'missing plain anti-bot message');
    assert.ok(/cookies/i.test(YT.friendlyError(caught, { isOwner: true })), 'owner hint missing cookies');
    assert.ok(!/not available in the server's region/i.test(YT.friendlyError(caught)), 'message blames the region');
  });

  await test('geo-block IS reported as a plain region block without admin hints for users', async () => {
    process.env.FAKE_YTDLP = 'geo';
    let caught = null;
    try { await YT.downloadAudio('https://www.youtube.com/watch?v=dQw4w9WgXcQ', { maxMB: 100, outBase: path.join(sandbox, 'a3'), deadlineMs: 20000 }); }
    catch (e) { caught = e; }
    assert.strictEqual(YT.classify(caught).code, 'GEO_BLOCK');
    assert.ok(/not available in the server's region/i.test(YT.friendlyError(caught)));
    assert.ok(!/\.ytdl/i.test(YT.friendlyError(caught)), 'leaked .ytdl proxy hint to regular user');
    assert.ok(/\.ytdl proxy/i.test(YT.friendlyError(caught, { isOwner: true })), 'owner geo-block hint missing');
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
    await songCmd.execute(sock, mockMsg('.song https://youtu.be/dQw4w9WgXcQ'), ['https://youtu.be/dQw4w9WgXcQ'], { ...makeExtra(sock), isOwner: false });

    const error = sock.sent.map(textOf).find((t) => /anti-bot|automated access/i.test(t));
    assert.ok(error, `no bot-check explanation in: ${JSON.stringify(sock.sent.map(textOf))}`);
    assert.ok(!/\.cookies|\.ytdl/i.test(error), `leaked admin hint to regular user: ${error}`);
    assert.ok(!/not available in the server's region/i.test(error), 'blamed the region instead');

    const ownerSock = mockSock();
    await songCmd.execute(ownerSock, mockMsg('.song https://youtu.be/dQw4w9WgXcQ'), ['https://youtu.be/dQw4w9WgXcQ'], makeExtra(ownerSock));
    assert.ok(ownerSock.sent.map(textOf).some((t) => /cookies/i.test(t)), 'owner missing cookies hint');
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


  console.log('\n── 16b. Phase 1 stability guards ──');

  await test('index.js has no heap re-exec, broken startAdminServer, or undefined store export', () => {
    const vm = require('vm');
    const src = fs.readFileSync(path.join(REPO, 'index.js'), 'utf8');
    new vm.Script(src, { filename: 'index.js' });
    assert.ok(!src.includes('respawnWithBiggerHeap'), 'respawnWithBiggerHeap still in index.js');
    assert.ok(!src.includes('heapPlan'), 'heapPlan still referenced in index.js');
    assert.ok(!src.includes('startAdminServer'), 'startAdminServer crash still in index.js');
    assert.ok(!/\bmodule\.exports\s*=\s*\{[^}]*\bstore\b/.test(src), 'undefined store still exported in index.js');
    assert.ok(/Session files .* were NOT deleted/i.test(src), 'logout notice missing');
  });

  await test('converter.ensureExecutable heals 0644 ffmpeg when npm allowScripts blocks postinstall', () => {
    const { ensureExecutable } = require(path.join(REPO, 'utils/converter.js'));
    const bin = path.join(sandbox, 'fake-ffmpeg-allowscripts');
    fs.writeFileSync(bin, '#!/bin/sh\necho "ffmpeg version 6.1"\n', { mode: 0o644 });
    fs.chmodSync(bin, 0o644);
    assert.strictEqual(ensureExecutable(bin), true);
    fs.accessSync(bin, fs.constants.X_OK);
  });

  await test('reconnector backs off and retries when startBot() throws', async () => {
    const { createReconnector, computeBackoffMs } = require(path.join(REPO, 'utils/reconnect.js'));
    assert.strictEqual(computeBackoffMs(0, { baseMs: 3000, maxMs: 60000 }), 3000);
    assert.strictEqual(computeBackoffMs(1, { baseMs: 3000, maxMs: 60000 }), 6000);
    assert.strictEqual(computeBackoffMs(2, { baseMs: 3000, maxMs: 60000 }), 12000);
    assert.strictEqual(computeBackoffMs(9, { baseMs: 3000, maxMs: 60000 }), 60000);

    const pendingTimers = [];
    let runs = 0;
    const rc = createReconnector({
      baseMs: 100,
      maxMs: 800,
      setTimer: (fn, delay) => { const t = { fn, delay }; pendingTimers.push(t); return t; },
      clearTimer: () => {},
      start: async () => {
        runs++;
        if (runs === 1) throw new Error('transient network error');
      },
    });

    assert.strictEqual(rc.schedule(), 100);
    assert.strictEqual(pendingTimers.length, 1);
    await pendingTimers.shift().fn(); // fails -> must schedule retry automatically!
    assert.strictEqual(pendingTimers.length, 1, 'failed reconnect left the bot dead instead of retrying');
    assert.strictEqual(pendingTimers[0].delay, 200);
    await pendingTimers.shift().fn(); // succeeds
    assert.strictEqual(runs, 2);
    rc.reset();
    assert.strictEqual(rc.attempts, 0);
  });

  await test('atomic JSON store keeps .bak and whitelist never treats corruption as "no users"', () => {
    const { writeJsonAtomic, readJsonSafe } = require(path.join(REPO, 'utils/jsonStore.js'));
    const ac = require(path.join(REPO, 'utils/accessControl.js'));
    const wlFile = path.join(sandbox, 'wl-test.json');

    ac.writeWL({ users: [{ number: '265991112222', addedAt: 1 }] }, { filePath: wlFile });
    assert.ok(fs.existsSync(`${wlFile}.bak`), '.bak backup was not created');

    // Corrupt primary -> must recover from .bak, NOT return empty users
    fs.writeFileSync(wlFile, '{corrupt-half-write', 'utf8');
    const recovered = ac.readWL({ force: true, filePath: wlFile });
    assert.strictEqual(recovered.users.length, 1);
    assert.strictEqual(recovered.users[0].number, '265991112222');

    // Corrupt BOTH primary and .bak -> must throw WHITELIST_CORRUPT, never { users: [] }
    const unrec = path.join(sandbox, 'wl-dead.json');
    fs.writeFileSync(unrec, '{broken', 'utf8');
    fs.writeFileSync(`${unrec}.bak`, '{also-broken', 'utf8');
    assert.throws(() => ac.readWL({ force: true, filePath: unrec }), /WHITELIST_CORRUPT|refusing to treat/);

    // Generic JSON helper test
    const stateFile = path.join(sandbox, 'state.json');
    writeJsonAtomic(stateFile, { on: false });
    fs.writeFileSync(stateFile, '', 'utf8');
    const res = readJsonSafe(stateFile, { defaultValue: { on: true } });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.recovered, true);
    assert.strictEqual(res.data.on, false);
  });

  await test('.on and .off follow the invoked command name (including disappearing messages)', async () => {
    const handler = require(path.join(REPO, 'handler.js'));
    const db = require(path.join(REPO, 'database.js'));
    const sent = [];
    const sock = {
      user: { id: '265894016453:1@s.whatsapp.net' },
      sendMessage: async (_jid, content) => { sent.push(content); return { key: { id: 'x' } }; },
    };
    // Disappearing message container: msg.message.conversation is undefined!
    await handler.handleMessage(sock, {
      key: { remoteJid: '265894016453@s.whatsapp.net', id: 'eph-off', fromMe: true },
      message: { ephemeralMessage: { message: { extendedTextMessage: { text: '.off' } } } },
    });
    assert.strictEqual(db.getBotState(), false, '.off inside ephemeralMessage did not turn bot off');

    await handler.handleMessage(sock, {
      key: { remoteJid: '265894016453@s.whatsapp.net', id: 'eph-on', fromMe: true },
      message: { ephemeralMessage: { message: { extendedTextMessage: { text: '.on' } } } },
    });
    assert.strictEqual(db.getBotState(), true, '.on inside ephemeralMessage did not turn bot on');
  });

  await test('editing a command message never re-runs the command', async () => {
    const handler = require(path.join(REPO, 'handler.js'));
    const sent = [];
    const sock = {
      user: { id: '265894016453:1@s.whatsapp.net' },
      sendMessage: async (_jid, content) => { sent.push(content); return { key: { id: 'x' } }; },
    };
    // Direct editedMessage wrapper
    await handler.handleMessage(sock, {
      key: { remoteJid: '265894016453@s.whatsapp.net', id: 'edit-1', fromMe: true },
      message: { editedMessage: { message: { protocolMessage: { editedMessage: { conversation: '.ping' } } } } },
    });
    // Ephemeral -> editedMessage wrapper
    await handler.handleMessage(sock, {
      key: { remoteJid: '265894016453@s.whatsapp.net', id: 'edit-2', fromMe: true },
      message: { ephemeralMessage: { message: { editedMessage: { message: { conversation: '.ping' } } } } },
    });
    // protocolMessage type 14 (MESSAGE_EDIT)
    await handler.handleMessage(sock, {
      key: { remoteJid: '265894016453@s.whatsapp.net', id: 'edit-3', fromMe: true },
      message: { protocolMessage: { type: 14, editedMessage: { conversation: '.ping' } } },
    });
    assert.strictEqual(sent.length, 0, 'an edited message triggered a command reply');
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

  console.log('\n── 22. dashboard bridge (admin API the web app calls) ──');

  await test('status / users / pair answer with the dashboard contract', async () => {
    const { startAdminApi } = require(path.join(REPO, 'utils/adminApi.js'));
    const port = 3311;
    const api = startAdminApi({
      port,
      token: 'selftest-token',
      hooks: {
        status: async () => ({ connected: true, botNumber: '265894016453' }),
        requestPair: async () => ({ code: 'ABCD-EFGH', expiresInSeconds: 60 }),
      },
    });
    const call = async (method, pathname, body, auth = true) => {
      const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(auth ? { Authorization: 'Bearer selftest-token' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: await res.json().catch(() => ({})) };
    };

    try {
      await new Promise((r) => setTimeout(r, 250));

      const status = await call('GET', '/admin/api/status');
      // lib/bot-proxy.ts reads exactly these two fields
      assert.strictEqual(status.status, 200);
      assert.strictEqual(status.json.connected, true);
      assert.strictEqual(status.json.botNumber, '265894016453');

      const denied = await call('GET', '/admin/api/status', null, false);
      assert.strictEqual(denied.status, 401, 'the API answers without a token');

      const added = await call('POST', '/admin/api/users', { number: '+265 99 777 8888', label: 'Test' });
      assert.strictEqual(added.status, 201);
      assert.strictEqual(added.json.user.number, '265997778888', 'number was not normalised');

      const off = await call('PATCH', '/admin/api/users/265997778888', { enabled: false });
      assert.strictEqual(off.json.user.enabled, false);

      const pair = await call('POST', '/admin/api/pair', { number: '265997778888' });
      assert.strictEqual(pair.json.code, 'ABCD-EFGH');
      assert.strictEqual(pair.json.expiresInSeconds, 60);

      const gone = await call('DELETE', '/admin/api/users/265997778888');
      assert.strictEqual(gone.status, 200);
      const list = await call('GET', '/admin/api/users');
      assert.ok(!list.json.users.some((u) => u.number === '265997778888'), 'user was not removed');
    } finally {
      await api.stop();
    }
  });

  await test('a disabled number is in the list but not allowed to use the bot', () => {
    const { readWL, writeWL, findUserIndex, findAllowedUserIndex } = require(path.join(REPO, 'utils/accessControl.js'));
    const wl = readWL();
    wl.users.push({ number: '265912345678', enabled: false, source: 'dashboard' });
    writeWL(wl);
    try {
      const jid = '265912345678@s.whatsapp.net';
      assert.ok(findUserIndex(readWL().users, jid) !== -1, 'entry should still exist');
      assert.strictEqual(findAllowedUserIndex(readWL().users, jid), -1, 'disabled number was allowed');
    } finally {
      const back = readWL();
      back.users = back.users.filter((u) => u.number !== '265912345678');
      writeWL(back);
    }
  });

  console.log('\n── 23. disk hygiene (nothing outlives a successful send) ──');

  await test('a delivered movie file is deleted after send', async () => {
    const host = require(path.join(REPO, 'utils/movieHost.js'));
    const { getTempDir } = require(path.join(REPO, 'utils/tempManager.js'));
    const file = path.join(getTempDir(), 'movies', `selftest_${Date.now()}.mp4`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(2048, 1));
    assert.ok(fs.existsSync(file));
    const freed = await host.release(file, { meta: { title: 'Selftest' }, quality: 720 });
    assert.strictEqual(freed, true, 'release() refused to delete');
    assert.ok(!fs.existsSync(file), 'file survived the delivery');
  });

  await test('cleanup sweeps temp/movies subfolders, not just loose files', () => {
    const { cleanupOldFiles } = require(path.join(REPO, 'utils/cleanup.js'));
    const { getTempDir, holdTemp } = require(path.join(REPO, 'utils/tempManager.js'));
    const dir = path.join(getTempDir(), 'movies', 'data');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = `fresh_${Date.now()}`;
    const stale = path.join(dir, `stale_${Date.now()}.part`);
    const fresh = path.join(dir, `${stamp}.part`);
    fs.writeFileSync(stale, Buffer.alloc(64, 1));
    fs.writeFileSync(fresh, Buffer.alloc(64, 1));
    const release = holdTemp(stamp);           // like a download still in flight
    try {
      // `now` is injectable, so the tree can be aged without touching clocks
      cleanupOldFiles(null, { now: Date.now() + 3 * 60 * 60 * 1000 });
      assert.ok(!fs.existsSync(stale), 'stale file inside temp/movies survived cleanup');
      assert.ok(fs.existsSync(fresh), 'a fresh download was deleted');
    } finally {
      release();
      try { fs.unlinkSync(fresh); } catch { /* ignore */ }
    }
  });

  console.log('\n── direct torrent download support ──');

  await test('pickTorrentFile selects the right video and excludes samples', async () => {
    const { pickTorrentFile } = await import(pathToFileURL(path.join(REPO, 'engine/media/torrent.js')).href);
    const MB = 1024 * 1024;
    const files = [
      { name: 'Film.mp4', length: 700 * MB },
      { name: 'Film.mkv', length: 900 * MB },
      { name: 'Film.sample.mkv', length: 1200 * MB },
      { name: 'Film.txt', length: 500 * MB },
      { name: 'tiny.mkv', length: 20 * MB },
    ];
    assert.strictEqual(pickTorrentFile(files), files[1], 'largest eligible video not selected');
    assert.strictEqual(pickTorrentFile([{ name: 'small.mkv', length: 29 * MB }]), null, 'video below 30 MB was selected');

    const episodes = [
      { name: 'Show.S01E01.mkv', length: 700 * MB },
      { name: 'Show.1x02.mp4', length: 500 * MB },
      { name: 'Show.S01.E02.webm', length: 800 * MB },
      { name: 'Show.S01E02.sample.mkv', length: 1200 * MB },
    ];
    assert.strictEqual(pickTorrentFile(episodes, { season: 1, episode: 2 }), episodes[2], 'matching episode was not preferred');
    assert.strictEqual(pickTorrentFile(files, { fileIdx: 0 }), files[0], 'valid fileIdx was ignored');
    assert.strictEqual(pickTorrentFile([{ name: 'readme.txt', length: 500 * MB }]), null, 'non-video was selected');
  });

  await test('downloader keeps HTTP downloads available without loading WebTorrent', async () => {
    const torrentSource = fs.readFileSync(path.join(REPO, 'engine/media/torrent.js'), 'utf8');
    assert.doesNotMatch(torrentSource, /^\s*import\s+.*\bfrom\s*['"]webtorrent['"]/m, 'WebTorrent is imported statically');

    const { download } = await import(pathToFileURL(path.join(REPO, 'engine/media/downloader.js')).href);
    const payload = Buffer.from('http download without torrent engine');
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-length': payload.length, 'content-type': 'video/mp4' });
      res.end(payload);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const file = path.join(sandbox, 'http-without-torrent.mp4');
    try {
      const result = await download({ kind: 'file', url: `http://127.0.0.1:${server.address().port}/video.mp4` }, file);
      assert.strictEqual(result.bytes, payload.length);
      assert.deepStrictEqual(fs.readFileSync(file), payload);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  await test('resolveCandidate returns seeded magnets without debrid and rejects low-seed torrents', async () => {
    const { default: resolver } = await import(pathToFileURL(path.join(REPO, 'engine/core/resolver.js')).href);
    const { default: debrid } = await import(pathToFileURL(path.join(REPO, 'engine/providers/debrid/index.js')).href);
    const { default: config } = await import(pathToFileURL(path.join(REPO, 'engine/config.js')).href);
    assert.strictEqual(config.torrentDirect, true, 'direct torrent downloads are disabled in this test');
    const originalActive = debrid.active;
    debrid.active = () => [];
    try {
      const candidate = {
        kind: 'torrent', provider: 'knaben', title: 'Sintel', seeds: config.torrentMinSeeds,
        magnet: 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10', fileIdx: 2, sizeMB: 100,
      };
      const out = await resolver.resolveCandidate(candidate, { season: 1, episode: 2, quality: 720 });
      assert.strictEqual(out.kind, 'torrent');
      assert.strictEqual(out.url, candidate.magnet);
      assert.strictEqual(out.magnet, candidate.magnet);
      assert.strictEqual(out.fileIdx, 2);
      assert.strictEqual(out.season, 1);
      assert.strictEqual(out.episode, 2);
      assert.strictEqual(out.verified, true);
      await assert.rejects(
        () => resolver.resolveCandidate({ ...candidate, seeds: config.torrentMinSeeds - 1 }, {}),
        /not enough torrent seeds/,
      );
    } finally {
      debrid.active = originalActive;
    }
  });

  await test('download routes torrent sources to torrentToFile with metadata', async () => {
    const { download, _setTorrentDownloaderForTests } = await import(pathToFileURL(path.join(REPO, 'engine/media/downloader.js')).href);
    const { default: config } = await import(pathToFileURL(path.join(REPO, 'engine/config.js')).href);
    let received;
    _setTorrentDownloaderForTests(async (...args) => {
      received = args;
      return { file: '/tmp/selected.mkv' };
    });
    try {
      const result = await download({
        kind: 'torrent', magnet: 'magnet:?xt=urn:btih:abc', fileIdx: 4, season: 2, episode: 3,
      }, '/tmp/movie.mp4', () => {});
      assert.deepStrictEqual(result, { file: '/tmp/selected.mkv' });
      assert.strictEqual(received[0], 'magnet:?xt=urn:btih:abc');
      assert.strictEqual(received[1], '/tmp/movie.mp4');
      assert.strictEqual(received[2].fileIdx, 4);
      assert.strictEqual(received[2].season, 2);
      assert.strictEqual(received[2].episode, 3);
      assert.strictEqual(received[2].maxMB, config.maxDownloadMB);
      assert.strictEqual(typeof received[2].onProgress, 'function');
    } finally {
      _setTorrentDownloaderForTests(null);
    }
  });

  await test('MKV media is sent as a document with Matroska MIME type', async () => {
    const host = require(path.join(REPO, 'utils/movieHost.js'));
    const file = path.join(sandbox, 'direct-torrent.mkv');
    fs.writeFileSync(file, 'mkv-data');
    let sent;
    await host.sendMedia({ sendMessage: async (_chat, content) => { sent = content; } }, 'chat', {}, {
      file, title: 'Sintel',
    });
    assert.ok(sent.document, 'MKV was not sent as a document');
    assert.strictEqual(sent.mimetype, 'video/x-matroska');
    assert.strictEqual(sent.fileName, 'Sintel.mkv');
  });

  // ─── silent-video regressions (real ffmpeg; skipped when unavailable) ───────
  console.log('\n▶ silent video guards');
  {
    const MT = require(path.join(REPO, 'utils', 'mediaTransfer'));
    const YT = require(path.join(REPO, 'utils', 'youtubedl'));
    const getFfmpeg = require(path.join(REPO, 'utils', 'ffmpeg'));
    const { execFileSync } = require('child_process');

    await test('findProduced ignores per-format DASH parts (base.f137.mp4)', async () => {
      const dir = fs.mkdtempSync(path.join(sandbox, 'fp-'));
      const base = path.join(dir, 'ytv_1');
      fs.writeFileSync(`${base}.f137.mp4`, 'v');
      fs.writeFileSync(`${base}.f251.webm`, 'a');
      assert.strictEqual(YT.findProduced(base), null, 'a video-only part was taken as the result');
      fs.writeFileSync(`${base}.mp4`, 'merged');
      assert.strictEqual(YT.findProduced(base), `${base}.mp4`);
    });

    await test('sniff: mp4 with moov at the end is not mistaken for audio', async () => {
      const head = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(4000, 0)]);
      assert.strictEqual(MT.sniff(head).kind, 'video');
      const m4a = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(4000, 0)]);
      assert.strictEqual(MT.sniff(m4a).kind, 'audio');
    });

    const ffOk = getFfmpeg.works() && (() => {
      try { execFileSync(getFfmpeg(), ['-hide_banner', '-encoders'], { stdio: 'pipe' }).toString().match(/libx264/) || (() => { throw 0; })(); return true; }
      catch { return false; }
    })();
    if (!ffOk) {
      console.log('  ⏭  ffmpeg/libx264 not available — skipping probe/transcode checks');
    } else {
      const dir = fs.mkdtempSync(path.join(sandbox, 'ff-'));
      const ff = (args) => execFileSync(getFfmpeg(), ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'pipe' });
      const silent = path.join(dir, 'silent.mp4');
      const opus = path.join(dir, 'opus.mp4');
      const unmergedBase = path.join(dir, 'unmerged');
      ff(['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10', '-t', '1', '-an',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', `${unmergedBase}.f134.mp4`]);
      ff(['-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', '-vn',
        '-c:a', 'aac', `${unmergedBase}.f140.m4a`]);
      ff(['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silent]);
      ff(['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440',
        '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-strict', '-2', '-shortest', opus]);

      await test('assertProduced merges one leftover video and audio part into an A/V MP4', async () => {
        const merged = YT.assertProduced(unmergedBase, '', 'video');
        assert.strictEqual(merged, `${unmergedBase}.mp4`);
        assert.ok(!fs.existsSync(`${unmergedBase}.f134.mp4`) && !fs.existsSync(`${unmergedBase}.f140.m4a`),
          'the source parts were not deleted after merging');
        const info = await MT.probeMedia(merged);
        assert.ok(info.probed && info.hasVideo && info.hasAudio, JSON.stringify(info));
      });

      await test('probeMedia tells a mute video from one with sound', async () => {
        const a = await MT.probeMedia(silent);
        assert.ok(a.probed && a.hasVideo && !a.hasAudio, JSON.stringify(a));
        const b = await MT.probeMedia(opus);
        assert.ok(b.probed && b.hasVideo && b.hasAudio && b.audioCodec === 'opus', JSON.stringify(b));
      });

      await test('ensureWhatsAppMp4 re-encodes Opus audio to AAC (WhatsApp plays Opus-in-mp4 mute)', async () => {
        const out = await MT.ensureWhatsAppMp4(opus, path.join(dir, 'opus_wa.mp4'));
        const info = await MT.probeMedia(out);
        assert.ok(out !== opus, 'file was passed through untouched');
        assert.strictEqual(info.audioCodec, 'aac', JSON.stringify(info));
        assert.strictEqual(info.videoCodec, 'h264', 'video should have been stream-copied');
      });
    }
  }

  // ─── cleanup / .movie length / per-command smoke ───────────────────────────
  console.log('\n▶ temp holds, fake movie clips, command smoke');
  {
    const TM = require(path.join(REPO, 'utils', 'tempManager'));
    const CL = require(path.join(REPO, 'utils', 'cleanup'));

    await test('cleanup never deletes a held job file, even when it looks old', async () => {
      const dir = fs.mkdtempSync(path.join(sandbox, 'cl-'));
      const f = path.join(dir, 'dl_123_abc_wa.mp4');
      const g = path.join(dir, 'junk.tmp');
      fs.writeFileSync(f, 'x'); fs.writeFileSync(g, 'x');
      const old = new Date(Date.now() - 5 * 3600 * 1000);
      fs.utimesSync(f, old, old); fs.utimesSync(g, old, old);
      const release = TM.holdTemp('dl_123_abc');
      CL.cleanupOldFiles(dir);
      assert.ok(fs.existsSync(f), 'held file was deleted');
      release();
      // utimes moved mtime back, but ctime is "now" → still too fresh to sweep
      CL.cleanupOldFiles(dir);
      assert.ok(fs.existsSync(f), 'a file written seconds ago was swept because of an old mtime');
    });

    await test('moviebox skips 2-minute "[Hindi] [Full movie]" fakes and music items', async () => {
      const { pickMatch, minStreamSeconds } = await import(pathToFileURL(path.join(REPO, 'engine/providers/stream/moviebox.js')).href);
      const items = [
        { subjectType: 6, title: 'Spider-Man Theme Song', releaseDate: '2026-01-01', hasResource: true, subjectId: '1', detailPath: 'a' },
        { subjectType: 1, title: 'Spider-Man: Brand New Day[Hindi] [Full movie]', releaseDate: '2026-07-31', hasResource: true, duration: 157, subjectId: '2', detailPath: 'b' },
        { subjectType: 1, title: 'Spider-Man: Brand New Day', releaseDate: '2026-07-31', hasResource: true, duration: 8100, subjectId: '3', detailPath: 'c' },
      ];
      assert.strictEqual(pickMatch(items, { title: 'Spider-Man: Brand New Day', year: '2026', type: 'movie' }).subjectId, '3');
      assert.ok(minStreamSeconds({ runtime: 0 }, false) >= 40 * 60);
      assert.ok(minStreamSeconds({ runtime: 148 }, false) > 80 * 60);
    });

    await test('moviebox rejects unrelated titles and prefers clean exact matches', async () => {
      const { pickMatch } = await import(pathToFileURL(path.join(REPO, 'engine/providers/stream/moviebox.js')).href);
      const dune = pickMatch([
        { subjectType: 1, title: 'Rebel Moon - Part Two: The Scargiver', releaseDate: '2024-04-19', duration: 7200, subjectId: 'rebel' },
      ], { title: 'Dune: Part Two', year: 2024, type: 'movie' });
      assert.strictEqual(dune, null);

      const spider = pickMatch([
        { subjectType: 1, title: 'Spider-Man: Brand New Day[Hindi] [Full movie]', releaseDate: '2026-07-31', duration: 7200, subjectId: 'junk' },
        { subjectType: 1, title: 'Spider-Man: Brand New Day', releaseDate: '2026-07-31', duration: 7200, subjectId: 'real' },
      ], { title: 'Spider-Man: Brand New Day', year: 2026, type: 'movie' });
      assert.strictEqual(spider.subjectId, 'real');

      const breakingBad = pickMatch([
        { subjectType: 2, title: 'Breaking Bad S1', subjectId: 'series' },
      ], { title: 'Breaking Bad', type: 'series' });
      assert.strictEqual(breakingBad.subjectId, 'series');
    });

    const movie = require(path.join(REPO, 'commands', 'media', 'movie'));
    await test('.movie: minimum playtime follows the real runtime', () => {
      assert.strictEqual(movie._minPlaySeconds(0), 40 * 60);
      assert.strictEqual(movie._minPlaySeconds(150), 150 * 60 * 0.6);
      assert.strictEqual(movie._minPlaySeconds(0, 'episode'), 5 * 60);
    });

    await test('disk preflight uses statfs and configured movie/media thresholds', () => {
      const disk = require(path.join(REPO, 'utils', 'diskSpace'));
      const statfs = (free) => () => ({ bavail: free, bsize: 1024 * 1024 });
      assert.throws(
        () => disk.requireMovieSpace('/fake', 2000, { minFreeMB: 800, diskSizeMultiplier: 2, diskOverheadMB: 500 }, statfs(4000)),
        /not enough disk \(3\.9 GB free/,
      );
      assert.doesNotThrow(() => disk.requireMovieSpace('/fake', 2000, {}, statfs(5000)));
      assert.throws(() => disk.requireMediaDownloadSpace('/fake', { diskMinFreeMB: 1500 }, statfs(1499)), /not enough disk/);
      assert.throws(() => disk.requireMediaCopySpace('/fake', 1000, { diskCopyMultiplier: 1.2, diskCopyOverheadMB: 300 }, statfs(1499)), /not enough disk/);

      const warnings = [];
      const oldError = console.error;
      console.error = (...args) => warnings.push(args.join(' '));
      try {
        const unavailable = () => { throw new Error('statfs unavailable'); };
        assert.strictEqual(disk.freeMB('/fake', unavailable), null);
        assert.doesNotThrow(() => disk.requireFreeSpace('/fake', 100, unavailable));
        assert.doesNotThrow(() => disk.requireMovieSpace('/fake', 2000, {}, unavailable));
        assert.doesNotThrow(() => disk.requireMediaDownloadSpace('/fake', {}, unavailable));
        assert.doesNotThrow(() => disk.requireMediaCopySpace('/fake', 100, {}, unavailable));
      } finally {
        console.error = oldError;
      }
      assert.strictEqual(warnings.length, 1);
    });

    await test('disk guard enforces 9 GB folder budget, flags host-node statfs, and reserves per-job space', () => {
      const disk = require(path.join(REPO, 'utils', 'diskSpace'));
      const guard = require(path.join(REPO, 'utils', 'diskGuard'));
      const fakeRoot = fs.mkdtempSync(path.join(sandbox, 'botroot-'));
      fs.writeFileSync(path.join(fakeRoot, 'payload.bin'), Buffer.alloc(1024 * 1024, 1)); // 1 MB

      // Host node claims 400 GB free out of 500 GB, while bot quota is 9000 MB
      const hostNodeStatfs = () => ({ bavail: 400 * 1024, blocks: 500 * 1024, bsize: 1024 * 1024 });
      const info = disk.inspectDisk(fakeRoot, { rootDir: fakeRoot, budget: 9000, statfsSync: hostNodeStatfs });
      assert.strictEqual(info.statfsSeesHostNode, true, 'did not detect shared host-node statfs');
      assert.ok(info.effectiveFreeMB < 9000 && info.effectiveFreeMB > 8990, `unexpected effectiveFreeMB: ${info.effectiveFreeMB}`);
      assert.match(guard.formatBootComparison(info), /sees host node disk, NOT panel quota/);

      // Concurrent reservation test: two 5 GB movie jobs cannot over-commit a 9 GB budget
      const r1 = disk.reserveSpace(fakeRoot, 5000, { label: 'movie-1', rootDir: fakeRoot, budget: 9000, statfsSync: hostNodeStatfs });
      assert.throws(
        () => disk.reserveSpace(fakeRoot, 5000, { label: 'movie-2', rootDir: fakeRoot, budget: 9000, statfsSync: hostNodeStatfs }),
        /not enough disk.*reserved by 1 running job/,
      );
      r1.release();
      const r2 = disk.reserveSpace(fakeRoot, 5000, { label: 'movie-2', rootDir: fakeRoot, budget: 9000, statfsSync: hostNodeStatfs });
      r2.release();
      disk._clearReservationsForTests();
    });

    await test('heavy concurrency is capped at 1–2 and boot sweep removes leftover partials', () => {
      const cfg = require(path.join(REPO, 'config'));
      const jq = require(path.join(REPO, 'utils', 'jobQueue'));
      const cleanup = require(path.join(REPO, 'utils', 'cleanup'));
      assert.ok(cfg.queue.heavy >= 1 && cfg.queue.heavy <= 2, `heavy queue limit ${cfg.queue.heavy} exceeds 1–2`);
      assert.ok(cfg.movies.queueConcurrency >= 1 && cfg.movies.queueConcurrency <= 2, `movie concurrency ${cfg.movies.queueConcurrency} exceeds 1–2`);
      assert.ok(jq.stats().heavy.limit <= 2, 'jobQueue heavy limit exceeds 2');
      assert.strictEqual(cleanup.configuredTempMaxMB(), 2048);

      const bootTemp = fs.mkdtempSync(path.join(sandbox, 'boottemp-'));
      fs.mkdirSync(path.join(bootTemp, 'movies'), { recursive: true });
      const partFile = path.join(bootTemp, 'ytv_123.mp4.part');
      const strandedMovie = path.join(bootTemp, 'movies', 'Dune.1080p.mp4');
      const keepCache = path.join(bootTemp, 'movies', 'cache.json');
      fs.writeFileSync(partFile, 'partial');
      fs.writeFileSync(strandedMovie, 'partial-movie');
      fs.writeFileSync(keepCache, '{}');

      const swept = cleanup.sweepBootPartials(bootTemp);
      assert.strictEqual(swept.files, 2);
      assert.strictEqual(fs.existsSync(partFile), false);
      assert.strictEqual(fs.existsSync(strandedMovie), false);
      assert.strictEqual(fs.existsSync(keepCache), true, 'boot sweep deleted cache.json');
    });

    const getFfmpeg = require(path.join(REPO, 'utils', 'ffmpeg'));
    if (getFfmpeg.works()) {
      await test('.movie rejects a downloaded trailer-length file', async () => {
        const clip = path.join(sandbox, 'clip.mp4');
        require('child_process').execFileSync(getFfmpeg(), ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=5', '-t', '3', '-pix_fmt', 'yuv420p', clip]);
        await assert.rejects(() => movie._assertFullLength(clip, 120), /trailer\/fake/);
      });
    }
  }

  // ─── concurrency, quality picker, no cache ─────────────────────────────────
  console.log('\n▶ 20 downloads at once, quality menu, nothing cached');
  {
    const jobQueue = require(path.join(REPO, 'utils', 'jobQueue'));
    const selections = require(path.join(REPO, 'utils', 'selections'));

    await test('20 link downloads run at the same time', async () => {
      let running = 0;
      let peak = 0;
      const waiting = [];
      const jobs = Array.from({ length: 20 }, () => jobQueue.runInLane('light', async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => waiting.push(resolve));
        running -= 1;
      }));
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.strictEqual(peak, 20, `only ${peak} of 20 downloads started together`);
      while (waiting.length) waiting.shift()();
      await Promise.all(jobs);
    });

    await test('a 21st download waits for a free slot instead of failing', async () => {
      const running = [];
      const waiting = [];
      const holders = Array.from({ length: 20 }, () => jobQueue.runInLane('light', () => new Promise((resolve) => {
        running.push(resolve);
        waiting.push(resolve);
      })));
      await new Promise((resolve) => setTimeout(resolve, 120));

      let started = false;
      const extra = jobQueue.runInLane('light', async () => { started = true; });
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.strictEqual(started, false, 'the 21st job ignored the lane limit');

      waiting.shift()();                       // exactly one slot freed
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.strictEqual(started, true, 'the waiting job did not start when a slot freed');

      waiting.forEach((resolve) => resolve());
      running.forEach((resolve) => resolve());
      await Promise.all([...holders, extra]);
    });

    await test('a WhatsApp list tap resolves by row id', async () => {
      const items = [{ quality: 1080 }, { quality: 720 }];
      selections.offer({
        chatId: 'list@s.whatsapp.net', sender: 'u1@s.whatsapp.net',
        items, ids: ['q1080', 'q720'], run: () => {},
      });
      const picked = selections.match('list@s.whatsapp.net', 'u1@s.whatsapp.net', 'q720');
      assert.ok(picked, 'the row id was not matched');
      assert.strictEqual(picked.item.quality, 720);
      assert.strictEqual(selections.match('list@s.whatsapp.net', 'u1@s.whatsapp.net', '2'), null,
        'a finished choice was matched twice');
    });

    const movie = require(path.join(REPO, 'commands', 'media', 'movie'));
    const engine = require(path.join(REPO, 'utils', 'movieEngine'));

    await test('.movie records an explicitly typed quality', () => {
      assert.strictEqual(movie._parseArgs(['dune', '2021', '1080']).explicitQuality, true);
      assert.strictEqual(movie._parseArgs(['dune', '2021']).explicitQuality, false);
      assert.strictEqual(movie._parseArgs(['dune', '2021', '1080']).quality, 1080);
    });

    await test('.movie offers every quality with its size', async () => {
      const original = engine.qualityOptions;
      engine.qualityOptions = async () => ({
        options: [
          { quality: 1080, sizeMB: 2100, provider: 'moviebox', candidates: 2 },
          { quality: 720, sizeMB: 900, provider: 'moviebox', candidates: 1 },
        ],
      });
      const sent = [];
      const sock = { sendMessage: async (_jid, content) => { sent.push(content); return { key: { id: 'k' } }; } };
      const msg = { key: { remoteJid: 'q@s.whatsapp.net', id: 'm1' } };
      const extra = { from: 'q@s.whatsapp.net', sender: 'u@s.whatsapp.net' };
      try {
        await movie._askQuality(sock, msg, extra, { title: 'Spider-Man', year: 2026 }, { quality: 720, matches: [] });
      } finally {
        engine.qualityOptions = original;
        selections.clear('q@s.whatsapp.net', 'u@s.whatsapp.net');
      }
      assert.ok(!sent.some((m) => Array.isArray(m.sections)), 'broken WhatsApp sections list message was sent');
      assert.ok(sent.some((m) => m.poll && Array.isArray(m.poll.values)), 'quality picker did not send a WhatsApp poll');
      const body = sent.map((m) => m.text || [m.poll?.name, ...(m.poll?.values || [])].filter(Boolean).join('\n')).join('\n');
      assert.match(body, /1080p/);
      assert.match(body, /2\.1 GB/);
      assert.match(body, /720p/);
    });

    await test('.movie falls back to a numbered list when the client rejects polls', async () => {
      const original = engine.qualityOptions;
      engine.qualityOptions = async () => ({
        options: [
          { quality: 1080, sizeMB: 2100, provider: 'moviebox', candidates: 1 },
          { quality: 480, sizeMB: 300, provider: 'moviebox', candidates: 1 },
        ],
      });
      const sent = [];
      const sock = {
        sendMessage: async (_jid, content) => {
          if (content.poll) throw new Error('polls unsupported');
          sent.push(content);
          return { key: { id: 'k' } };
        },
      };
      const msg = { key: { remoteJid: 'f@s.whatsapp.net', id: 'm2' } };
      const extra = { from: 'f@s.whatsapp.net', sender: 'u@s.whatsapp.net' };
      try {
        await movie._askQuality(sock, msg, extra, { title: 'Dune', year: 2021 }, { quality: 720, matches: [] });
      } finally {
        engine.qualityOptions = original;
        selections.clear('f@s.whatsapp.net', 'u@s.whatsapp.net');
      }
      const text = sent.map((m) => m.text || '').join('\n');
      assert.match(text, /1\.\*?\s*1080p/);
      assert.match(text, /480p/);
    });

    await test('Phase 3: encrypted WhatsApp poll votes decrypt & trigger choice, while quoting unrelated messages is ignored', async () => {
      const crypto = require('crypto');
      const { proto } = require('@whiskeysockets/baileys');
      const { hmacSign, aesEncryptGCM } = require('@whiskeysockets/baileys/lib/Utils/crypto');

      let chosen = null;
      let pollPayload = null;
      const botJid = '265894016453@s.whatsapp.net';
      const voterJid = '265997564836@s.whatsapp.net';
      const sock = {
        user: { id: '265894016453:12@s.whatsapp.net' },
        sendMessage: async (_jid, content) => {
          pollPayload = content.poll;
          return { key: { id: 'POLL_MSG_1', remoteJid: 'grp@g.us' } };
        },
      };
      const msg = { key: { id: 'REQ_1', remoteJid: 'grp@g.us', participant: voterJid } };
      const extra = { from: 'grp@g.us', sender: voterJid };

      await selections.sendPollOrText(sock, msg, extra, {
        pollName: 'Choose quality',
        optionLabels: ['1080p · ~2.0 GB', '720p · ~900 MB'],
        fallbackText: 'fallback',
        items: [{ quality: 1080 }, { quality: 720 }],
        run: async (_s, _m, _e, item) => { chosen = item; },
      });

      // 1. Quoting a DIFFERENT message in the group with "2" must NOT hijack the picker
      assert.strictEqual(
        selections.match('grp@g.us', voterJid, '2', { quotedMessageId: 'FRIEND_MSG_999' }),
        null,
        'quoting a friend hijacked the pending picker',
      );
      // 2. Build a real WhatsApp AES-GCM encrypted pollUpdateMessage vote for option #2
      const optHash = crypto.createHash('sha256').update(pollPayload.values[1], 'utf8').digest();
      const votePlain = proto.Message.PollVoteMessage.encode({ selectedOptions: [optHash] }).finish();
      const sign = Buffer.concat([
        Buffer.from('POLL_MSG_1'),
        Buffer.from(botJid),
        Buffer.from(voterJid),
        Buffer.from('Poll Vote'),
        Buffer.from([1]),
      ]);
      const key0 = hmacSign(pollPayload.messageSecret, new Uint8Array(32), 'sha256');
      const decKey = hmacSign(sign, key0, 'sha256');
      const aad = Buffer.from(`POLL_MSG_1\u0000${voterJid}`);
      const iv = crypto.randomBytes(12);
      const encPayload = aesEncryptGCM(votePlain, decKey, iv, aad);

      // Stranger voting on someone else's poll is ignored
      assert.strictEqual(selections.resolvePollVote(sock, {
        key: { id: 'V_STRANGER', remoteJid: 'grp@g.us', participant: '265111222333@s.whatsapp.net' },
        message: {
          pollUpdateMessage: {
            pollCreationMessageKey: { id: 'POLL_MSG_1', remoteJid: 'grp@g.us' },
            vote: { encPayload, encIv: iv },
          },
        },
      }), null, 'stranger was allowed to vote on another user poll');

      // Real requester's vote decrypts & resolves option #2, and clears typed fallback
      const hit = selections.resolvePollVote(sock, {
        key: { id: 'V_OWNER', remoteJid: 'grp@g.us', participant: voterJid },
        message: {
          pollUpdateMessage: {
            pollCreationMessageKey: { id: 'POLL_MSG_1', remoteJid: 'grp@g.us' },
            vote: { encPayload, encIv: iv },
          },
        },
      });
      assert.ok(hit && hit.item.quality === 720, 'encrypted poll vote did not resolve to 720p');
      await hit.entry.run(sock, msg, extra, hit.item);
      assert.deepStrictEqual(chosen, { quality: 720 });
      assert.strictEqual(selections.peek('grp@g.us', voterJid), null, 'poll vote left typed fallback alive');

      // 3. Send failure clears stale choices instead of leaving ghosts
      selections.offer({ chatId: 'grp@g.us', sender: voterJid, items: [{ a: 1 }], run: () => {} });
      await assert.rejects(() => selections.sendTextPrompt(
        { sendMessage: async () => { throw new Error('socket closed'); } },
        msg,
        extra,
        { text: 'hi', items: [{ a: 2 }], run: () => {} },
      ));
      assert.strictEqual(selections.peek('grp@g.us', voterJid), null, 'stale choice survived send failure');
    });

    await test('Phase 3: .series parses "Full House", "9-1-1", and "the boys 2" accurately', () => {
      const series = require(path.join(REPO, 'commands', 'media', 'series'));

      const fhBare = series._parseArgs(['Full', 'House']);
      assert.strictEqual(fhBare.title, 'Full House');
      assert.strictEqual(fhBare.pack, false);
      assert.strictEqual(fhBare.hasTarget, false);

      const fhEp = series._parseArgs(['Full', 'House', 's01e03', '720']);
      assert.strictEqual(fhEp.title, 'Full House');
      assert.strictEqual(fhEp.season, 1);
      assert.strictEqual(fhEp.from, 3);
      assert.strictEqual(fhEp.pack, false);
      assert.strictEqual(fhEp.hasTarget, true);
      assert.strictEqual(fhEp.quality, 720);

      const n11Bare = series._parseArgs(['9-1-1']);
      assert.strictEqual(n11Bare.title, '9-1-1');
      assert.strictEqual(n11Bare.hasTarget, false);

      const n11Range = series._parseArgs(['9-1-1', 's02', '1-5']);
      assert.strictEqual(n11Range.title, '9-1-1');
      assert.strictEqual(n11Range.season, 2);
      assert.strictEqual(n11Range.from, 1);
      assert.strictEqual(n11Range.to, 5);
      assert.strictEqual(n11Range.hasTarget, true);

      const boys2 = series._parseArgs(['the', 'boys', '2']);
      assert.strictEqual(boys2.title, 'the boys');
      assert.strictEqual(boys2.season, 2);
      assert.strictEqual(boys2.bareNumber, 2);
      assert.strictEqual(boys2.hasTarget, true);
    });

    await test('Phase 3: error sanitizer, per-user cooldown, .paper pagination, .menu/.status/.instagram/.fb/.viewonce, Gifted warning', async () => {
      const { safeErrorMessage } = require(path.join(REPO, 'utils', 'userErrors'));
      const handler = require(path.join(REPO, 'handler'));
      const ac = require(path.join(REPO, 'utils', 'accessControl'));
      const menu = require(path.join(REPO, 'commands', 'general', 'menu'));
      const [paperCmd] = require(path.join(REPO, 'commands', 'general', 'paper'));
      const { loadCommands } = require(path.join(REPO, 'utils', 'commandLoader'));
      const APIs = require(path.join(REPO, 'utils', 'api'));

      // 1. Raw internal error strings never leak to WhatsApp chat
      const leaked = safeErrorMessage(new Error('ENOENT: no such file /home/user/neww/secret.json'));
      assert.ok(!/ENOENT|\/home\/user|secret\.json/.test(leaked), `leaked path: ${leaked}`);

      // 2. Per-user cooldown throttles rapid commands from regular allowed users
      const wl = ac.readWL();
      const testUser = '265888111222@s.whatsapp.net';
      ac.writeWL({ users: [...wl.users, { number: '265888111222', enabled: true }] });
      handler.resetCooldowns();
      const sentMsgs = [];
      const cdSock = {
        user: { id: '265894016453:1@s.whatsapp.net' },
        sendMessage: async (_jid, content) => { sentMsgs.push(content); return { key: { id: 'p' } }; },
      };
      try {
        await handler.handleMessage(cdSock, {
          key: { id: 'cd-1', remoteJid: testUser },
          message: { conversation: '.ping' },
        });
        await handler.handleMessage(cdSock, {
          key: { id: 'cd-2', remoteJid: testUser },
          message: { conversation: '.ping' },
        });
      } finally {
        ac.writeWL(wl);
        handler.resetCooldowns();
      }
      const pongs = sentMsgs.filter((m) => /Pinging|Pong/.test(m.text || ''));
      const waitReacts = sentMsgs.filter((m) => m.react?.text === '⏳');
      assert.ok(pongs.length >= 1 && waitReacts.length === 1, 'second rapid command was not rate-limited by cooldown');

      // 3. .paper filters false-positive month codes ("APRIL 2023") and paginates .paper browse
      const parsedApril = paperCmd._parsePaper('APRIL 2023 NURS 2201 END OF SEMESTER.pdf');
      assert.strictEqual(parsedApril.courseCode, 'NURS');
      assert.strictEqual(parsedApril.moduleNumber, '2201');
      assert.strictEqual(paperCmd.MAX_PAPERS_PER_QUERY, 10, 'papers per query default should be 10');

      const prevVault = paperCmd._getVaultForTests();
      const fakeVaultFiles = Array.from({ length: 60 }, (_, idx) => ({
        id: idx + 1,
        hash: `h${idx + 1}`,
        name: `BIOL ${1100 + idx} 2024 END OF SEMESTER.pdf`,
        size: 1024,
        created_at: '2025-01-01T00:00:00Z',
      }));
      paperCmd._setVaultFilesForTests(fakeVaultFiles);
      const browseSock = { sendMessage: async () => ({ key: { id: 'b' } }) };
      let browseOut = '';
      try {
        await paperCmd.execute(browseSock, { key: { remoteJid: 'c@s.whatsapp.net' } }, ['browse', 'b'], {
          from: 'c@s.whatsapp.net',
          reply: async (t) => { browseOut = t; },
          status: async () => ({ update: async (t) => { browseOut = t; } }),
        });
      } finally {
        if (prevVault?.files) paperCmd._setVaultFilesForTests(prevVault.files);
        else paperCmd._setVaultFilesForTests(null);
      }
      assert.ok(browseOut.length > 0 && browseOut.length < 4500, `.paper browse b too huge (${browseOut.length} chars)`);
      assert.match(browseOut, /page 1\/3/i);

      // 4. .menu hides admin + .health from non-owners, fixes .on/.off description, honours prefix & botName
      const userCard = menu._buildCard(menu._buildGroups('!', { isOwner: false }), 'alice', { prefix: '!', botName: 'CustomBot' });
      assert.ok(userCard.includes('CustomBot') && userCard.includes('!movie') && userCard.includes('prefix !'));
      assert.ok(!userCard.includes('ADMIN') && !userCard.includes('.health') && !userCard.includes('!health') && !userCard.includes('refreshpapers'));

      const ownerCard = menu._buildCard(menu._buildGroups('!', { isOwner: true }), 'boss', { prefix: '!', botName: 'CustomBot' });
      assert.ok(ownerCard.includes('ADMIN') && ownerCard.includes('!status') && ownerCard.includes('enable/disable the bot globally'));
      assert.ok(!ownerCard.includes('!health') && !ownerCard.includes('.health'));

      // 5. .status is primary with .update alias; .instagram & .fb come from shortcuts; .viewonce is open to allowed users
      const cmds = loadCommands();
      assert.strictEqual(cmds.get('status')?.name, 'status');
      assert.strictEqual(cmds.get('update')?.name, 'status');
      assert.ok(cmds.get('instagram') && cmds.get('ig') && cmds.get('fb') && cmds.get('facebook'));
      assert.ok(!cmds.get('viewonce')?.ownerOnly, '.viewonce must remain open to allowed users');

      // 6. Gifted API warns visibly when key is missing/revoked without printing the key
      const cfg = require(path.join(REPO, 'config'));
      const savedKey = cfg.giftedApi.apiKey;
      const warns = [];
      const origWarn = console.warn;
      console.warn = (...a) => warns.push(a.join(' '));
      try {
        APIs._resetKeyWarnForTests();
        cfg.giftedApi.apiKey = '';
        await assert.rejects(() => APIs.getGiftedAudioByUrl('https://youtu.be/dQw4w9WgXcQ'));
      } finally {
        cfg.giftedApi.apiKey = savedKey;
        console.warn = origWarn;
      }
      assert.ok(warns.some((w) => /Gifted API fallback failed.*GIFTED_API_KEY/.test(w)), 'missing Gifted key warning');
    });

    await test('Phase 4: dead files/packages/listeners removed while webtorrent is preserved', () => {
      for (const removed of [
        'admin-server.js',
        'utils/heapPlan.js',
        'utils/memoryWatchdog.js',
        'commands/media/instagram.js',
        'commands/media/facebook.js',
        'engine/core/locker.js',
      ]) {
        assert.strictEqual(fs.existsSync(path.join(REPO, removed)), false, `${removed} should be deleted`);
      }
      const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
      assert.ok(!pkg.dependencies?.['ruhend-scraper'], 'ruhend-scraper still in dependencies');
      assert.ok(!pkg.devDependencies?.nodemon, 'nodemon still in devDependencies');
      assert.ok(!pkg.scripts?.['install:no-puppeteer'] && !pkg.scripts?.check && !pkg.scripts?.dev, 'unused scripts remain');
      assert.ok(pkg.optionalDependencies?.webtorrent, 'webtorrent must remain in optionalDependencies');

      const idxSrc = fs.readFileSync(path.join(REPO, 'index.js'), 'utf8');
      assert.ok(!idxSrc.includes('cleanupPuppeteerCache'), 'Puppeteer cache cleanup still in index.js');
      assert.ok(!idxSrc.includes('store.bind'), 'in-memory store still in index.js');
      assert.ok(!idxSrc.includes('message-receipt.update'), 'empty receipt listener still in index.js');
      assert.ok(!idxSrc.includes("sock.ev.on('messages.update'"), 'empty messages.update listener still in index.js');
    });

    await test('Phase 5: adminApi CORS allowlist, dashboard JWT guard, local D1 auth, rate-limit, fast offline probe', async () => {
      const { startAdminApi } = require(path.join(REPO, 'utils/adminApi.js'));
      const port = 3390 + Math.floor(Math.random() * 500);
      const api = startAdminApi({
        port,
        token: 'cors-test-token',
        allowedOrigins: ['https://portal.example.com'],
        hooks: { status: async () => ({ connected: true, botNumber: '265991234567' }) },
      });
      try {
        await new Promise((r) => setTimeout(r, 80));
        // Server-to-server: no wildcard CORS
        const s2s = await fetch(`http://127.0.0.1:${port}/admin/api/status`, {
          headers: { Authorization: 'Bearer cors-test-token' },
        });
        assert.strictEqual(s2s.status, 200);
        assert.strictEqual(s2s.headers.get('access-control-allow-origin'), null);

        // Disallowed browser origin preflight -> 403
        const badPreflight = await fetch(`http://127.0.0.1:${port}/admin/api/status`, {
          method: 'OPTIONS',
          headers: { Origin: 'https://evil.example.org' },
        });
        assert.strictEqual(badPreflight.status, 403);

        // Allowed browser origin -> echoed origin + Vary: Origin
        const okOrigin = await fetch(`http://127.0.0.1:${port}/admin/api/status`, {
          headers: {
            Authorization: 'Bearer cors-test-token',
            Origin: 'https://portal.example.com',
          },
        });
        assert.strictEqual(okOrigin.status, 200);
        assert.strictEqual(okOrigin.headers.get('access-control-allow-origin'), 'https://portal.example.com');
        assert.match(String(okOrigin.headers.get('vary')), /Origin/i);
      } finally {
        await api.stop();
      }

      const jwtSrc = fs.readFileSync(path.join(REPO, 'dashboard/lib/jwt.ts'), 'utf8');
      assert.match(jwtSrc, /JWT_SECRET_KEY environment variable is required in production/);
      assert.ok(fs.existsSync(path.join(REPO, 'dashboard/instrumentation.ts')));
      assert.ok(fs.existsSync(path.join(REPO, 'dashboard/scripts/check-prod-env.mjs')));

      const authSrc = fs.readFileSync(path.join(REPO, 'dashboard/lib/auth-engine.ts'), 'utf8');
      assert.ok(!authSrc.includes('bloody-brigitta-ahzafar'), 'hardcoded Koyeb URL still in auth-engine.ts');

      const loginSrc = fs.readFileSync(path.join(REPO, 'dashboard/app/api/auth/login/route.ts'), 'utf8');
      assert.match(loginSrc, /checkRateLimit/);
      assert.match(loginSrc, /status:\s*429/);

      const proxySrc = fs.readFileSync(path.join(REPO, 'dashboard/lib/bot-proxy.ts'), 'utf8');
      assert.match(proxySrc, /STATUS_TIMEOUT_MS\s*=\s*3_000/);
    });

    await test('Phase 6 & Secrets: CI selftest gate, Procfile alignment, log redaction, and clean config defaults', async () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
      const procfile = fs.readFileSync(path.join(REPO, 'Procfile'), 'utf8').trim();
      assert.strictEqual(procfile, `web: ${pkg.scripts.start}`, 'Procfile and package.json start script drifted');

      const wf = fs.readFileSync(path.join(REPO, '.github/workflows/deploy-panel.yml'), 'utf8');
      assert.match(wf, /npm ci/);
      assert.match(wf, /npm run selftest/);
      assert.match(wf, /needs:\s*selftest/);
      assert.match(wf, /database\/\*\.json/);
      assert.ok(!wf.includes('"http://$BASE_HOST"'), 'deploy workflow must not try cleartext HTTP with PANEL_API_KEY');

      const { redactSecrets } = require(path.join(REPO, 'utils/safeLog.js'));
      const dirty =
        'Authorization: Bearer superSecretToken12345 ptlc_abcdef1234567890 token=mySecret99 ' +
        '58989|qn4Jom8CnuscD7WDvp7FHLH3v1B7dzNOYgCe0l3i372d67fe http://user:myPass@proxy.local:8080';
      const clean = redactSecrets(dirty);
      assert.ok(!clean.includes('superSecretToken12345'), 'Bearer token leaked');
      assert.ok(!clean.includes('abcdef1234567890'), 'ptlc_ key leaked');
      assert.ok(!clean.includes('mySecret99'), 'query token leaked');
      assert.ok(!clean.includes('qn4Jom8Cnusc'), 'Sanctum token leaked');
      assert.ok(!clean.includes('myPass'), 'proxy password leaked');

      const cfgSrc = fs.readFileSync(path.join(REPO, 'config.js'), 'utf8');
      const engCfgSrc = fs.readFileSync(path.join(REPO, 'engine/config.js'), 'utf8');
      for (const leaked of ['_0u5aff45', '98bb6b66ece431fbea8a0ee9c18ac712', 'qn4Jom8Cnusc']) {
        assert.ok(!cfgSrc.includes(leaked), `hardcoded key still in config.js: ${leaked}`);
        assert.ok(!engCfgSrc.includes(leaked), `hardcoded key still in engine/config.js: ${leaked}`);
      }
      assert.strictEqual(require(path.join(REPO, 'config.js')).pairNumber, '');
    });

    await test('nothing is cached: a delivered movie file is deleted', async () => {
      const host = require(path.join(REPO, 'utils', 'movieHost'));
      const file = path.join(host.tempDir(), `no-cache-${Date.now()}.mp4`);
      fs.writeFileSync(file, 'x');
      const deleted = await host.release(file);
      assert.strictEqual(deleted, true);
      assert.strictEqual(fs.existsSync(file), false, 'the file survived release()');
    });

    await test('yt-dlp can repair itself and is watched while running', () => {
      const YT = require(path.join(REPO, 'utils', 'youtubedl'));
      assert.strictEqual(typeof YT.selfHeal, 'function');
      assert.strictEqual(typeof YT.healthCheck, 'function');
      assert.strictEqual(typeof YT.startWatchdog, 'function');
      assert.strictEqual(typeof YT.stopWatchdog, 'function');
    });

    await test('.ytv never sends a silent video', async () => {
      const ff = require(path.join(REPO, 'utils', 'ffmpeg'));
      if (!ff.works()) return;                     // no ffmpeg → no fixture
      const dir = fs.mkdtempSync(path.join(sandbox, 'silent-'));
      const silent = path.join(dir, 'silent.mp4');
      require('child_process').execFileSync(ff(), [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-t', '6', '-an',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silent,
      ]);
      const YT = require(path.join(REPO, 'utils', 'youtubedl'));
      const pipeline = require(path.join(REPO, 'utils', 'mediaPipeline'));
      const original = YT.downloadVideo;
      YT.downloadVideo = async () => ({ file: silent, profile: 'test', attempts: [], hasAudio: false });
      const sent = [];
      const sock = { sendMessage: async (_jid, content) => { sent.push(content); return { key: { id: 'x' } }; } };
      const msg = { key: { remoteJid: 's@s.whatsapp.net', id: 'm3' }, message: { conversation: '.ytv x' } };
      try {
        const out = await pipeline.downloadAndSend(sock, msg, { from: 's@s.whatsapp.net' },
          { url: 'https://example.com/v', kind: 'video', title: 'silent', height: 720 });
        assert.strictEqual(out.sent, false, 'a silent video was reported as sent');
        assert.ok(!sent.some((m) => m.video || m.document), 'a silent video was sent to the chat');
        assert.ok(sent.some((m) => /audio/i.test(m.text || '')), 'the user was not told about the missing audio');
      } finally {
        YT.downloadVideo = original;
      }
    });

    console.log('\n── 23. outbound dashboard sync & hydrodactyl panel client ──');

    await test('safeLog redacts Hydrodactyl (hydro_) and Pterodactyl (ptlc_/ptla_) keys', () => {
      const { redactSecrets } = require(path.join(REPO, 'utils', 'safeLog'));
      const out = redactSecrets('key=hydro_TestVector99 and ptlc_abcdefghijklmnop');
      assert.ok(!out.includes('TestVector99'), `hydro_ secret leaked: ${out}`);
      assert.ok(out.includes('hydro_[REDACTED]'), `missing hydro_ redaction: ${out}`);
      assert.ok(out.includes('ptlc_[REDACTED]'), `missing ptlc_ redaction: ${out}`);
    });

    await test('panelClient auto-discovers server ID via GET /api/client and sends restart over HTTPS', async () => {
      const { panelRestart } = require(path.join(REPO, 'utils', 'panelClient'));
      const calls = [];
      const fakeFetch = async (url, init = {}) => {
        calls.push({ url, method: init.method || 'GET', body: init.body });
        if (url.endsWith('/api/client')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: [{ attributes: { identifier: 'srv99abc', uuid: 'srv99abc-1111' } }],
            }),
          };
        }
        if (url.endsWith('/api/client/servers/srv99abc/power')) {
          return { ok: true, status: 204, json: async () => ({}) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      };

      const res = await panelRestart({
        env: {
          PANEL_URL: 'https://panel.xsystemshosting.com',
          PANEL_API_KEY: 'hydro_SyntheticTestKey01',
          PANEL_SERVER_ID: '',
          P_SERVER_UUID: '',
        },
        fetchImpl: fakeFetch,
      });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.serverId, 'srv99abc');
      assert.strictEqual(calls.length, 2);

      const httpRejected = await panelRestart({
        env: {
          PANEL_URL: 'http://panel.xsystemshosting.com',
          PANEL_API_KEY: 'hydro_SyntheticTestKey01',
          PANEL_SERVER_ID: 'srv99abc',
        },
        fetchImpl: fakeFetch,
      });
      assert.strictEqual(httpRejected.ok, false);
      assert.ok(/https:\/\//i.test(httpRejected.reason));
    });

    await test('dashboardSync signs HMAC requests, applies whitelist deltas, and answers queued pair commands', async () => {
      const crypto = require('crypto');
      const { startDashboardSync } = require(path.join(REPO, 'utils', 'dashboardSync'));
      const wlTemp = path.join(sandbox, 'sync-wl.json');
      fs.writeFileSync(wlTemp, JSON.stringify({ users: [] }));

      const secret = 'sync-secret-for-selftest-123456';
      const receivedBodies = [];

      const fakeFetch = async (url, init = {}) => {
        assert.strictEqual(url, 'https://portal.example.test/api/bot/sync');
        const ts = init.headers['X-Bot-Timestamp'];
        const nonce = init.headers['X-Bot-Nonce'];
        const sig = init.headers['X-Bot-Signature'];
        const expected =
          'sha256=' +
          crypto
            .createHmac('sha256', secret)
            .update(`${ts}.${nonce}.${init.body}`)
            .digest('hex');
        assert.strictEqual(sig, expected, 'HMAC signature mismatch');

        const parsed = JSON.parse(init.body);
        receivedBodies.push(parsed);

        if (receivedBodies.length === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              nextPollMs: 2000,
              whitelistVersion: 'v-abc123',
              whitelistChanged: true,
              users: [
                { number: '265991112233', label: 'Portal Member', addedBy: 'm@example.com', enabled: true },
              ],
              commands: [
                { id: 'cmd_pair_1', type: 'pair', payload: { number: '265998887766', label: 'Pair Me' } },
              ],
            }),
          };
        }

        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            nextPollMs: 10000,
            whitelistVersion: 'v-abc123',
            whitelistChanged: false,
            commands: [],
          }),
        };
      };

      const sync = startDashboardSync({
        manualOnly: true,
        dashboardUrl: 'https://portal.example.test',
        token: secret,
        wlFile: wlTemp,
        fetchImpl: fakeFetch,
        getStatus: () => ({ connected: false, botNumber: null }),
        requestPairing: async (num) => ({ code: `ABCD-${num.slice(-4)}`, expiresInSeconds: 60 }),
      });

      await sync.syncNow();
      // Second tick delivers completedResults for cmd_pair_1
      await sync.syncNow();
      sync.stop();

      assert.strictEqual(receivedBodies.length, 2);
      assert.strictEqual(receivedBodies[1].whitelistVersion, 'v-abc123');
      assert.strictEqual(receivedBodies[1].completedResults.length, 1);
      assert.strictEqual(receivedBodies[1].completedResults[0].id, 'cmd_pair_1');
      assert.strictEqual(receivedBodies[1].completedResults[0].ok, true);
      assert.strictEqual(receivedBodies[1].completedResults[0].result.code, 'ABCD-7766');

      const savedWl = JSON.parse(fs.readFileSync(wlTemp, 'utf8'));
      const nums = savedWl.users.map((u) => u.number);
      assert.ok(nums.includes('265991112233'), 'whitelist delta not applied');
      assert.ok(nums.includes('265998887766'), 'paired number not added to whitelist');
    });

    await test('.providers lists active providers cleanly and telemetry syncs live counters', async () => {
      const [providersCmd] = require(path.join(REPO, 'commands/general/providers.js'));
      const telemetry = require(path.join(REPO, 'utils/telemetry.js'));
      const { startDashboardSync } = require(path.join(REPO, 'utils/dashboardSync.js'));

      let outText = '';
      await providersCmd.execute(
        {},
        { key: { remoteJid: 'c@s.whatsapp.net' } },
        [],
        { reply: async (t) => { outText = String(t); } },
      );
      const lines = outText.trim().split('\n').filter(Boolean);
      assert.ok(lines[0].startsWith('*Providers ('), `missing clean header: ${outText}`);
      for (const p of ['moviebox', 'eztv', 'nyaa', 'solidtorrents', 'apibay', 'torrentio', 'yts']) {
        assert.ok(outText.includes(p), `missing provider ${p}`);
      }
      assert.ok(!/Metadata|TMDB|debrid|trust\s+\d|hdhub4u/i.test(outText), `.providers still contains verbose metadata: ${outText}`);

      const telFile = path.join(sandbox, 'telemetry-check.json');
      telemetry._resetForTests(telFile);
      telemetry.recordCommand('song');
      telemetry.recordCommand('paper');
      telemetry.recordDownloadSuccess('audio', 1);
      telemetry.recordDownloadSuccess('paper', 3);
      telemetry.recordFailure('ytv', 1);
      telemetry.flushNow();

      const snap = telemetry.snapshot();
      assert.strictEqual(snap.commandsTotal, 2);
      assert.strictEqual(snap.downloadsSuccess, 4);
      assert.strictEqual(snap.failedTotal, 1);
      assert.ok(snap.ramUsedMB > 0);

      let syncPayload = null;
      const sync = startDashboardSync({
        manualOnly: true,
        dashboardUrl: 'https://portal.example.test',
        token: 'sync_secret_telemetry',
        wlFile: path.join(sandbox, 'wl-tel.json'),
        fetchImpl: async (_url, opts) => {
          syncPayload = JSON.parse(opts.body);
          return { ok: true, status: 200, json: async () => ({ ok: true, commands: [] }) };
        },
        getStatus: () => ({ connected: true, botNumber: '265894016453' }),
      });
      await sync.syncNow();
      sync.stop();

      assert.strictEqual(syncPayload.commandsTotal, 2);
      assert.strictEqual(syncPayload.downloadsSuccess, 4);
      assert.strictEqual(syncPayload.failedTotal, 1);
      assert.strictEqual(typeof syncPayload.uptimeSeconds, 'number');
      assert.strictEqual(typeof syncPayload.ramUsedMB, 'number');
    });

    await test('hotReload purges cached commands/handler from disk when panel power API returns 404', () => {
      const { onReload, reloadRuntime } = require(path.join(REPO, 'utils', 'hotReload'));
      const telemetry = require(path.join(REPO, 'utils', 'telemetry'));
      const beforeHandler = require(path.join(REPO, 'handler'));
      let notified = null;
      const off = onReload((h) => { notified = h; });
      const res = reloadRuntime();
      off();
      assert.strictEqual(res.ok, true);
      assert.ok(res.evicted > 10, `expected >10 evicted modules, got ${res.evicted}`);
      assert.ok(notified && typeof notified.handleMessage === 'function');
      assert.notStrictEqual(notified, beforeHandler, 'handler should be reloaded fresh from disk');
      assert.strictEqual(telemetry.snapshot().commandsTotal, 2, 'telemetry singleton must survive hotReload');
    });
  }

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
