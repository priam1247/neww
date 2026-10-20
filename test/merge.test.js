// test/merge.test.js — tests for everything merged from Zafar-bot-main:
// store, access, selections, pending, webpExif, ytdlp (pure parts),
// remote (cobalt picker), spotify (link parse), papers (parsing/suggest),
// transfer (sniff), handler gates + selection routing.
// NOTE: env vars are set BEFORE module imports — config.js is frozen at load.
process.env.DATA_DIR = './temp/test-data';
process.env.OWNER_NUMBER = '265999000111';
process.env.ACCESS_MODE = 'open';
process.env.JOB_DIR = './temp/test-jobs';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// ── top-level imports (ESM top-level await) ──────────────────────────────────
const { store } = await import('../src/core/store.js');
const access = (await import('../src/bot/access.js')).default;
const sel = await import('../src/bot/selections.js');
const pending = await import('../src/bot/pending.js');
const { withStickerMetadata, readStickerMetadata } = await import('../src/media/webpExif.js');
const YT = (await import('../src/providers/local/ytdlp.js')).default;
const remote = await import('../src/providers/local/remote.js');
const { parseSpotifyUrl } = await import('../src/providers/local/spotify.js');
const papers = await import('../src/media/papers.js');
const t = await import('../src/media/transfer.js');
const { handle, parse, ROUTES } = await import('../src/bot/handler.js');
const watchdog = (await import('../src/core/watchdog.js')).default;

// ── store ────────────────────────────────────────────────────────────────────
describe('core/store', () => {
  test('set/get round-trip persists to disk', () => {
    store.set('t1', 'k', { v: 42 });
    assert.equal(store.get('t1', 'k').v, 42);
    assert.equal(JSON.parse(fs.readFileSync(store.file, 'utf8')).t1.k.v, 42);
  });

  test('missing keys fall back', () => {
    assert.equal(store.get('nope', 'nothing', 'dflt'), 'dflt');
    assert.equal(store.bucket('also-nope', { x: 1 }).x, 1);
  });

  test('buckets are namespaced', () => {
    store.set('a', 'shared', 1);
    store.set('b', 'shared', 2);
    assert.equal(store.get('a', 'shared'), 1);
    assert.equal(store.get('b', 'shared'), 2);
  });
});

// ── access ───────────────────────────────────────────────────────────────────
describe('bot/access', () => {
  test('numberOf strips device ids and servers', () => {
    assert.equal(access.numberOf('265894016453:12@s.whatsapp.net'), '265894016453');
    assert.equal(access.numberOf('265894016453@lid'), '265894016453');
    assert.equal(access.numberOf('garbage'), null);
  });

  test('senderNumbers collects every known form', () => {
    const nums = access.senderNumbers({ key: { participant: '265111222@s.whatsapp.net', remoteJidAlt: '265222333@lid' } }, 'x');
    assert.deepEqual(nums.sort(), ['265111222', '265222333']);
  });

  test('owner matches via OWNER_NUMBER — and ONLY via it', () => {
    assert.equal(access.isOwnerSender(['265999000111']), true);
    assert.equal(access.isOwnerSender(['265999000112']), false);
    assert.equal(access.isOwnerSender(['265000']), false);
    // security: a sender can never grant themselves ownership
    assert.equal(access.isOwnerSender(['265777000']), false);
  });

  test('whitelist add/remove/list', () => {
    assert.equal(access.whitelistAdd('265888777666'), true);
    assert.equal(access.whitelistAdd('265888777666'), false);   // dup
    assert.ok(access.readWhitelist().users.some(u => u.number === '265888777666'));
    assert.equal(access.whitelistRemove('265888777666'), true);
    assert.equal(access.whitelistRemove('265888777666'), false);
  });

  test('open mode allows everyone; whitelist mode gates', () => {
    const me = { numbers: ['265555000'], owner: false };
    access.whitelistAdd('265555000');
    assert.equal(access.isAllowedSender(me), true);             // open mode
    store.set('state', 'accessMode', 'whitelist');
    assert.equal(access.isAllowedSender(me), true);             // whitelisted
    assert.equal(access.isAllowedSender({ numbers: ['265777000'], owner: false }), false);
    assert.equal(access.isAllowedSender({ numbers: ['265777000'], owner: true }), true);  // owner bypass
    store.set('state', 'accessMode', 'open');
    access.whitelistRemove('265555000');
  });

  test('bot on/off state (order-independent)', () => {
    access.setBotOn(true);
    assert.equal(access.botOn(), true);
    access.setBotOn(false);
    assert.equal(access.botOn(), false);
    access.setBotOn(true);
  });
});

// ── selections ───────────────────────────────────────────────────────────────
describe('bot/selections', () => {
  test('parseChoice accepts common shapes, rejects junk', () => {
    assert.equal(sel.parseChoice('2'), 2);
    assert.equal(sel.parseChoice('.3'), 3);
    assert.equal(sel.parseChoice('#4'), 4);
    assert.equal(sel.parseChoice('5.'), 5);
    assert.equal(sel.parseChoice('6)'), 6);
    assert.equal(sel.parseChoice('  7  '), 7);
    assert.equal(sel.parseChoice('22'), 22);
    assert.equal(sel.parseChoice('movie'), null);
    assert.equal(sel.parseChoice('0'), null);
    assert.equal(sel.parseChoice('-1'), null);
    assert.equal(sel.parseChoice('2x'), null);
  });

  test('offer → match runs with the right item and clears', () => {
    sel._clearAll();
    const items = [{ id: 'a' }, { id: 'b' }];
    sel.offer({ chatId: 'c1', sender: 's1', items, run: () => {}, label: 'song' });
    const m = sel.match('c1', 's1', '2');
    assert.equal(m.item.id, 'b');
    assert.equal(m.index, 1);
    assert.equal(sel.peek('c1', 's1'), null);   // consumed
  });

  test('picks are sender-isolated (nobody steals another pick)', () => {
    sel._clearAll();
    sel.offer({ chatId: 'c2', sender: 'alice', items: [1, 2], run: () => {} });
    assert.equal(sel.match('c2', 'mallory', '1'), null);   // wrong sender
    assert.equal(sel.match('c2', 'alice', '1').item, 1);
  });

  test('entries expire after ttl', async () => {
    sel._clearAll();
    sel.offer({ chatId: 'c4', sender: 's4', items: [1], run: () => {}, ttlMs: 20 });
    assert.ok(sel.peek('c4', 's4'));
    await new Promise(r => setTimeout(r, 40));
    assert.equal(sel.peek('c4', 's4'), null);
  });

  test('isOutOfRange explains bad picks', () => {
    sel._clearAll();
    sel.offer({ chatId: 'c5', sender: 's5', items: [1, 2], run: () => {} });
    assert.equal(sel.isOutOfRange('c5', 's5', '9'), true);
    assert.equal(sel.isOutOfRange('c5', 's5', '1'), false);
    assert.equal(sel.isOutOfRange('c5', 's5', 'banana'), false);
    sel._clearAll();
  });
});

// ── pending (bare-number compat) ─────────────────────────────────────────────
describe('bot/pending', () => {
  test('tryBarePick re-dispatches the owning command', () => {
    pending.setPending('j1', { kind: 'movie', matches: [{ title: 'A' }, { title: 'B' }] });
    assert.equal(pending.tryBarePick('j1', '2', '/'), '/movie pick 2');
    assert.equal(pending.getPending('j1'), null);   // consumed
    assert.equal(pending.tryBarePick('j1', '2', '/'), null);
  });

  test('prefix-wrapped numbers and out-of-range are rejected', () => {
    pending.setPending('j2', { kind: 'series', matches: [1] });
    assert.equal(pending.tryBarePick('j2', '.1', '/'), '/series pick 1');
    pending.clearPending('j2');
    pending.setPending('j3', { kind: 'movie', matches: [1] });
    assert.equal(pending.tryBarePick('j3', '5', '/'), null);
    assert.equal(pending.tryBarePick('j3', 'banana', '/'), null);
    pending.clearPending('j3');
  });
});

// ── webpExif ─────────────────────────────────────────────────────────────────
describe('media/webpExif', () => {
  // minimal valid webp: RIFF/WEBP + VP8X chunk
  const makeWebp = () => {
    const payload = Buffer.alloc(8 + 10);
    payload.write('VP8X', 0, 'ascii');
    payload.writeUInt32LE(10, 4);
    const head = Buffer.from('RIFF\0\0\0\0WEBP', 'ascii');
    const buf = Buffer.concat([head, payload]);
    buf.writeUInt32LE(buf.length - 8, 4);
    return buf;
  };

  test('metadata round-trip', () => {
    const out = withStickerMetadata(makeWebp(), { packName: 'ZaFar Test Pack', publisher: 'tester' });
    const meta = readStickerMetadata(out);
    assert.equal(meta['sticker-pack-name'], 'ZaFar Test Pack');
    assert.equal(meta['sticker-pack-publisher'], 'tester');
    assert.ok(Array.isArray(meta.emojis));
  });

  test('re-embedding replaces the EXIF chunk (idempotent)', () => {
    const once = withStickerMetadata(makeWebp(), { packName: 'A' });
    const twice = withStickerMetadata(once, { packName: 'B' });
    assert.equal(readStickerMetadata(twice)['sticker-pack-name'], 'B');
    assert.equal(twice.toString('ascii', 0, 4), 'RIFF');
    assert.equal(twice.toString('ascii', 8, 12), 'WEBP');
  });

  test('non-webp or malformed input passes through untouched', () => {
    const junk = Buffer.from('not a webp at all');
    assert.equal(withStickerMetadata(junk, { packName: 'X' }), junk);
    assert.equal(readStickerMetadata(junk), null);
  });
});

// ── ytdlp (pure parts — no binary needed) ────────────────────────────────────
describe('providers/local/ytdlp (pure)', () => {
  test('url/id helpers', () => {
    assert.equal(YT.extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s'), 'dQw4w9WgXcQ');
    assert.equal(YT.extractVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(YT.extractVideoId('https://youtu.be/ab'), null);   // too short for an 11-char id
    assert.equal(YT.extractUrl('check this https://vm.tiktok.com/abc. nice'), 'https://vm.tiktok.com/abc');
    assert.equal(YT.isYouTubeUrl('https://music.youtube.com/watch?v=x'), true);
    assert.equal(YT.isYouTubeUrl('https://tiktok.com/@x'), false);
    assert.equal(YT.normalizeYouTubeUrl('watch this https://youtu.be/dQw4w9WgXcQ out'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  test('classify() maps real failures to honest codes', () => {
    const c = (text) => YT.classify({ stderr: text }).code;
    assert.equal(c("ERROR: Sign in to confirm you're not a bot"), 'BOT_CHECK');
    assert.equal(c('ERROR: Sign in to confirm your age'), 'AGE_RESTRICTED');
    assert.equal(c('ERROR: This video is available in your country'), 'GEO_BLOCK');
    assert.equal(c('ERROR: This video is private'), 'PRIVATE');
    assert.equal(c('ERROR: Members-only content'), 'MEMBERS_ONLY');
    assert.equal(c('ERROR: This live event will begin in 3 hours'), 'LIVE_EVENT');
    assert.equal(c('ERROR: This video is DRM protected'), 'DRM');
    assert.equal(c('ERROR: requires a po token'), 'PO_TOKEN');
    assert.equal(c('ERROR: Video unavailable'), 'UNAVAILABLE');
    assert.equal(c('ERROR: HTTP Error 429: Too Many Requests'), 'RATE_LIMIT');
    assert.equal(c('ERROR: Unsupported URL'), 'UNSUPPORTED_URL');
    assert.equal(c('ERROR: Requested format is not available'), 'NO_FORMATS');
    assert.equal(c('ERROR: unable to download webpage: timed out'), 'NETWORK');
    assert.equal(c('ERROR: ffmpeg not found'), 'FFMPEG_MISSING');
    assert.equal(c('ERROR: no such option: --js-runtimes'), 'BAD_ARGS');
    assert.equal(c('some totally novel failure'), 'UNKNOWN');
  });

  test('age-gate wording never masquerades as a bot-check', () => {
    const info = YT.classify({ stderr: 'ERROR: Sign in to confirm your age. This video may be inappropriate for some users.' });
    assert.equal(info.code, 'AGE_RESTRICTED');
  });

  test('friendlyError + attemptsSummary produce actionable text', () => {
    const msg = YT.friendlyError({ stderr: "ERROR: Sign in to confirm you're not a bot" });
    assert.match(msg, /not a bot/);
    assert.match(msg, /\.cookies set/);
    const summary = YT.attemptsSummary([{ engine: 'yt-dlp:tv', code: 'BOT_CHECK' }, { engine: 'yt-dlp:ios', code: 'NETWORK' }]);
    assert.match(summary, /yt-dlp:tv: BOT_CHECK/);
    assert.equal(YT.attemptsSummary([]), '');
  });

  test('attemptProfiles: non-YouTube gets one profile, YouTube escalates', () => {
    assert.equal(YT.attemptProfiles('https://vm.tiktok.com/x').length, 1);
    const yt = YT.attemptProfiles('https://www.youtube.com/watch?v=x');
    assert.ok(yt.length >= 4);
    assert.equal(yt[0].name, 'default');
    const names = yt.map(p => p.name);
    assert.ok(names.includes('tv'));
    assert.ok(names.includes('ios'));
  });

  test('retryability rules', () => {
    assert.equal(YT.isRetryable('BOT_CHECK'), true);
    assert.equal(YT.isRetryable('NETWORK'), true);
    assert.equal(YT.isRetryable('UNSUPPORTED_URL'), false);   // final: no client change helps
    assert.equal(YT.isRetryable('PRIVATE'), false);
  });

  test('cookies: Netscape / base64 / JSON all normalise', () => {
    const netscape = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1999999999\tVISITOR_INFO\tabc\n';
    assert.equal(YT.normaliseCookieText(netscape), netscape);
    const b64 = Buffer.from(netscape).toString('base64');
    assert.equal(YT.normaliseCookieText(b64), netscape);
    const json = JSON.stringify([{ domain: '.youtube.com', name: 'Y', value: 'v', expirationDate: 1999999999, secure: true }]);
    const fromJson = YT.normaliseCookieText(json);
    assert.match(fromJson, /# Netscape/);
    assert.equal(YT.countCookies(fromJson), 1);
    assert.equal(YT.normaliseCookieText('definitely not cookies'), null);
    assert.equal(YT.countCookies('# just a comment\n'), 0);
  });

  test('jsonCookiesToNetscape converts browser exports', () => {
    const out = YT.jsonCookiesToNetscape(JSON.stringify([
      { domain: '.example.com', name: 'a', value: '1', path: '/', secure: true, expirationDate: 123 },
      { domain: '.example.com', name: 'b', value: '2', path: '/', secure: false },
    ]));
    assert.ok(out.startsWith('# Netscape HTTP Cookie File'));
    assert.match(out, /\.example\.com\tTRUE\t\/\tTRUE\t123\ta\t1/);
    assert.match(out, /\.example\.com\tTRUE\t\/\tFALSE\t0\tb\t2/);
    assert.equal(YT.jsonCookiesToNetscape('[]'), null);
    assert.equal(YT.jsonCookiesToNetscape('not json'), null);
  });
});

// ── remote (cobalt picker) ───────────────────────────────────────────────────
describe('providers/local/remote', () => {
  test('pickCobaltUrl extracts tunnel / picker / audio urls', () => {
    assert.equal(remote.pickCobaltUrl({ status: 'tunnel', url: 'https://x/v.mp4' }), 'https://x/v.mp4');
    assert.equal(remote.pickCobaltUrl({ status: 'picker', picker: [{ type: 'photo', url: 'https://x/i' }, { type: 'video', url: 'https://x/v' }] }), 'https://x/v');
    assert.equal(remote.pickCobaltUrl({ status: 'stream', audio: 'https://x/a.mp3' }), 'https://x/a.mp3');
    assert.equal(remote.pickCobaltUrl({ status: 'error' }), null);
    assert.equal(remote.pickCobaltUrl(null), null);
  });

  test('provider list shapes', () => {
    const list = remote.listProviders();
    assert.ok(list.length >= 1);
    for (const p of list) assert.deepEqual(Object.keys(p).sort(), ['enabled', 'kinds', 'name']);
  });
});

// ── spotify (link parse) ─────────────────────────────────────────────────────
describe('providers/local/spotify', () => {
  test('parses track/album links incl. intl paths', () => {
    const t2 = parseSpotifyUrl('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT');
    assert.equal(t2.type, 'track');
    assert.equal(t2.id, '4cOdK2wGLETKBW3PvgPWqT');
    assert.equal(parseSpotifyUrl('https://open.spotify.com/intl-de/album/1DFixLWuPkv3KT3TnV35m3').type, 'album');
    assert.equal(parseSpotifyUrl('not a link'), null);
  });
});

// ── papers (parsing, dedupe, suggestions) ────────────────────────────────────
describe('media/papers', () => {
  test('parsePaper extracts code/module/type/year/month', () => {
    const p = papers.parsePaper('NURS_2210_Supp_October_2023.pdf');
    assert.equal(p.courseCode, 'NURS');
    assert.equal(p.moduleNumber, '2210');
    assert.equal(p.subjectName, 'Nursing');
    assert.equal(p.type, 'Supplementary');
    assert.equal(p.year, '2023');
    assert.equal(p.monthDisplay, 'October');
  });

  test('parsePaper recognises ODL / deferred / end-of-semester', () => {
    assert.equal(papers.parsePaper('chem 3601 odl 2021.pdf').type, 'ODL');
    assert.equal(papers.parsePaper('BIOL301_deferred_2020.pdf').type, 'Deferred');
    assert.equal(papers.parsePaper('MATH105 end-of-semester 2019.pdf').type, 'End of Semester');
    assert.equal(papers.parsePaper('unknownfile.pdf').courseCode, '');
  });

  test('editDistance + nearest suggest typos deterministically', () => {
    assert.equal(papers.editDistance('nurs', 'nurs'), 0);
    assert.equal(papers.editDistance('nurs', 'kurs'), 1);
    const entries = [
      { code: 'NURS', module: '2210', count: 5 },
      { code: 'CHEM', module: '3601', count: 2 },
    ];
    const near = papers.nearest('NURSE', null, entries);
    assert.equal(near[0].code, 'NURS');
  });

  test('deduplicateFiles drops same-size content and wrong courses', () => {
    const mk = (id, name, size) => ({ id, name, size });
    const files = [
      mk(1, 'CHEM3601_2020.pdf', 100),
      mk(2, 'CHEM3601_2020_copy.pdf', 100),        // same size → dropped
      mk(3, 'CHEM3601_Supp_2020.pdf', 200),        // different type → kept
      mk(4, 'GEOG101_2021.pdf', 300),              // wrong course → dropped
    ];
    const out = papers.deduplicateFiles(files, 'CHEM', '3601');
    assert.equal(out.length, 2);
    assert.deepEqual(out.map(f => f.id).sort(), [1, 3]);
  });

  test('isYear guards', () => {
    assert.equal(papers.isYear('2023'), true);
    assert.equal(papers.isYear('2210'), false);
    assert.equal(papers.isYear('99'), false);
  });
});

// ── transfer (sniffing) ──────────────────────────────────────────────────────
describe('media/transfer', () => {
  test('sniff identifies containers from magic bytes', () => {
    // an mp4 header with no video codec tag in the first bytes is an m4a
    assert.equal(t.sniff(Buffer.from('\0\0\0 ftypisom....')).kind, 'audio');
    assert.equal(t.sniff(Buffer.concat([Buffer.from('\0\0\0 ftypisom'), Buffer.from('avc1'), Buffer.alloc(16)])).kind, 'video');
    assert.equal(t.sniff(Buffer.from('ID3\x03')).kind, 'audio');
    assert.equal(t.sniff(Buffer.from('OggS')).ext, 'ogg');
    assert.equal(t.sniff(Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBP')).kind, 'image');
    assert.equal(t.sniff(Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVE')).ext, 'wav');
    assert.equal(t.sniff(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0])).ext, 'jpg');
    assert.equal(t.sniff(Buffer.from([0x89, 0x50, 0x4E, 0x47])).ext, 'png');
    assert.equal(t.sniff(Buffer.from('GIF8')).ext, 'gif');
    assert.equal(t.sniff(Buffer.from('fLaC')).ext, 'flac');
    assert.equal(t.sniff(Buffer.from('junkdata')).kind, 'unknown');
  });

  test('safeName sanitises filenames', () => {
    assert.equal(t.safeName('My: Song/Track <live>?'), 'My SongTrack live');
    assert.equal(t.safeName(''), 'media');
    assert.ok(t.safeName('x'.repeat(200)).length <= 90);
  });

  test('bar renders a progress bar', () => {
    assert.equal(t.bar(0), '░░░░░░░░░░');
    assert.equal(t.bar(50), '█████░░░░░');
    assert.equal(t.bar(100), '██████████');
  });
});

// ── handler (gates + selection routing) ──────────────────────────────────────
describe('bot/handler (merged gates + routing)', () => {
  const mkTransport = () => {
    const said = [];
    return {
      said,
      async say(_j, text) { said.push(text); return { key: { id: 'k1' } }; },
      async edit(_j, text) { said.push(text); return { key: { id: 'k1' } }; },
      async sendDoc() {},
      statusCard(_j, initial) {
        said.push(initial);
        return { update: async () => {}, final: async (t2) => { said.push(t2); } };
      },
    };
  };
  const senderMsg = { key: { participant: '265999000111@s.whatsapp.net', remoteJid: '265999000111@s.whatsapp.net' } };

  // keep tests order-independent (earlier tests may toggle state)
  test('setup: bot is on and mode is open', () => {
    access.setBotOn(true);
    store.set('state', 'accessMode', 'open');
  });

  test('parse: prefix, empty prefix, non-prefixed', () => {
    assert.deepEqual(parse('/ping'), { cmd: 'ping', args: [] });
    assert.deepEqual(parse('/'), { cmd: 'help', args: [] });
    assert.equal(parse('ping'), null);
  });

  test('merged routes exist', () => {
    for (const r of ['song', 'ytv', 'dl', 'spotify', 'sticker', 'viewonce', 'tgsticker', 'tgpack', 'paper', 'countpapers', 'refreshpapers', 'ping', 'allow', 'disallow', 'listusers', 'on', 'off', 'mode', 'broadcast', 'restart', 'cookies', 'ytdl', 'tiktok', 'x', 'pinterest', 'instagram', 'fb', 'movie', 'series', 'netflix', 'help']) {
      assert.ok(ROUTES[r], `route missing: ${r}`);
    }
  });

  test('owner can use owner-only commands; strangers cannot', async () => {
    const t1 = mkTransport();
    await handle(t1, '265999000111@s.whatsapp.net', '/listusers', senderMsg);
    assert.ok(t1.said.some(s => s.includes('Allowed Users')));

    const t2 = mkTransport();
    await handle(t2, '265777000@s.whatsapp.net', '/listusers', { key: { participant: '265777000@s.whatsapp.net' } });
    assert.ok(t2.said.some(s => s.includes('owner')));
  });

  test('bot off: strangers get silence, owner still works', async () => {
    access.setBotOn(false);
    const t1 = mkTransport();
    await handle(t1, '265888000@s.whatsapp.net', '/ping', { key: { participant: '265888000@s.whatsapp.net' } });
    assert.equal(t1.said.length, 0);   // silent

    const t2 = mkTransport();
    await handle(t2, '265999000111@s.whatsapp.net', '/ping', senderMsg);
    assert.ok(t2.said.some(s => s.includes('Pong')));
    access.setBotOn(true);
  });

  test('bare number resolves an open song picker', async () => {
    sel._clearAll();
    let ran = null;
    sel.offer({
      chatId: 'chat-x', sender: '265999000111', items: [{ url: 'u1' }, { url: 'u2' }], label: 'song',
      run: (ctx, item) => { ran = item; },
    });
    const t1 = mkTransport();
    await handle(t1, 'chat-x', '2', senderMsg);
    assert.deepEqual(ran, { url: 'u2' });
    assert.equal(sel.peek('chat-x', '265999000111'), null);
  });

  test('cancel clears an open picker', async () => {
    sel._clearAll();
    sel.offer({ chatId: 'chat-y', sender: '265999000111', items: [1], run: () => {} });
    const t1 = mkTransport();
    await handle(t1, 'chat-y', 'cancel', senderMsg);
    assert.equal(sel.peek('chat-y', '265999000111'), null);
    assert.ok(t1.said.some(s => s.includes('Cancelled')));
  });

  test('out-of-range numbers get a hint, not a crash', async () => {
    sel._clearAll();
    sel.offer({ chatId: 'chat-z', sender: '265999000111', items: [1, 2], run: () => {} });
    const t1 = mkTransport();
    await handle(t1, 'chat-z', '99', senderMsg);
    assert.ok(t1.said.some(s => s.includes('between 1 and 2')));
    sel._clearAll();
  });

  test('bare number re-dispatches movie pending picks', async () => {
    pending.setPending('chat-p', { kind: 'movie', matches: [{ title: 'A' }, { title: 'B' }] });
    const t1 = mkTransport();
    await handle(t1, 'chat-p', '2', senderMsg);
    assert.ok(t1.said.length >= 1);
    pending.clearPending('chat-p');
  });

  test('unknown command still explains itself', async () => {
    const t1 = mkTransport();
    await handle(t1, 'chat-u', '/definitelynotacommand', senderMsg);
    assert.ok(t1.said.some(s => s.includes('Unknown command')));
  });

  test('command errors are contained, not thrown', async () => {
    const t1 = mkTransport();
    await handle(t1, 'chat-e', '/paper', senderMsg);   // papers not configured → friendly message
    assert.ok(t1.said.length >= 1);
  });
});

// ── watchdog ─────────────────────────────────────────────────────────────────
describe('core/watchdog', () => {
  test('ENOSPC handler sweeps and never throws', () => {
    assert.doesNotThrow(() => watchdog.handleNoSpace('test'));
  });

  test('guards install without crashing', () => {
    assert.doesNotThrow(() => watchdog.installProcessGuards());
  });
});
