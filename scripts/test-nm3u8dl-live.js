#!/usr/bin/env node
'use strict';

/**
 * Live binary smoke test for `utils/nm3u8dl.js` + `engine/media/download.js`.
 *
 * Executed in CI (`ubuntu-latest`) where GitHub Releases are reachable:
 *   1. Auto-installs the real standalone `N_m3u8DL-RE` NativeAOT binary into a
 *      throwaway `bin/` directory via `ensureInstalled()`.
 *   2. Encodes a real multi-variant HLS VOD stream (`1920x1080` video, `1280x720`
 *      video, plus a separate `#EXT-X-MEDIA:TYPE=AUDIO` AAC rendition) with
 *      `ffmpeg` and serves it from a local HTTP server requiring a `Referer` header.
 *   3. Runs `hlsToFile(..., { maxHeight: 720, headers: { Referer } })` and verifies:
 *        - `engine === 'nm3u8dl-re'`
 *        - `1080p` playlist was dropped (`-dv`) and never requested
 *        - `720p` video + separate AAC audio were downloaded in parallel and muxed
 *          into a valid `.mp4` (`hasVideo === true && hasAudio === true`)
 *        - zero `.nm3u8_*` scratch directories remain after completion.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..');
const nm3u8dl = require(path.join(REPO, 'utils/nm3u8dl'));
const getFfmpeg = require(path.join(REPO, 'utils/ffmpeg'));
const { probeMedia } = require(path.join(REPO, 'utils/mediaTransfer'));

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'zafar-nm3u8-live-'));
  const binPath = path.join(work, 'bin', 'N_m3u8DL-RE');
  process.env.NM3U8DL_BIN = binPath;
  nm3u8dl._resetForTests();

  try {
    const installed = await nm3u8dl.ensureInstalled({ destPath: binPath });
    assert.ok(installed && fs.existsSync(installed), `N_m3u8DL-RE install failed: ${nm3u8dl.installError()}`);
    console.log(`✅ Installed real binary: ${nm3u8dl.version()} -> ${installed}`);

    const ff = getFfmpeg();
    assert.ok(getFfmpeg.works(), 'ffmpeg must be available');

    const streamDir = path.join(work, 'hls');
    fs.mkdirSync(path.join(streamDir, 'v1080'), { recursive: true });
    fs.mkdirSync(path.join(streamDir, 'v720'), { recursive: true });
    fs.mkdirSync(path.join(streamDir, 'audio'), { recursive: true });

    // Video-only 1080p variant (represented by small frame size for speed, tagged 1920x1080 in master)
    execFileSync(ff, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24:duration=3', '-an',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod',
      path.join(streamDir, 'v1080', 'index.m3u8'),
    ]);

    // Video-only 720p variant
    execFileSync(ff, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=3', '-an',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod',
      path.join(streamDir, 'v720', 'index.m3u8'),
    ]);

    // Separate AAC audio rendition
    execFileSync(ff, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=523:duration=3', '-vn',
      '-c:a', 'aac', '-b:a', '128k',
      '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod',
      path.join(streamDir, 'audio', 'index.m3u8'),
    ]);

    const hits = [];
    const srv = http.createServer((req, res) => {
      if (req.headers.referer !== 'https://vixsrc.to/') {
        res.writeHead(403).end('missing referer');
        return;
      }
      hits.push(req.url);
      if (req.url === '/master.m3u8') {
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        return res.end([
          '#EXTM3U',
          '#EXT-X-VERSION:3',
          '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="/audio/index.m3u8"',
          '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="aud"',
          '/v1080/index.m3u8',
          '#EXT-X-STREAM-INF:BANDWIDTH=2200000,RESOLUTION=1280x720,AUDIO="aud"',
          '/v720/index.m3u8',
        ].join('\n'));
      }
      const local = path.join(streamDir, req.url.replace(/^\/+/, ''));
      if (fs.existsSync(local) && fs.statSync(local).isFile()) {
        res.writeHead(200);
        return fs.createReadStream(local).pipe(res);
      }
      res.writeHead(404).end();
    });

    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${srv.address().port}`;

    try {
      const engineDl = await import(pathToFileURL(path.join(REPO, 'engine/media/download.js')).href);
      const outDir = path.join(work, 'out');
      fs.mkdirSync(outDir, { recursive: true });

      // Direct nm3u8dl.downloadHls smoke check (surfaces exact N_m3u8DL-RE stderr on failure)
      const directDest = path.join(outDir, 'Direct.720p.mp4');
      const directGot = await nm3u8dl.downloadHls(`${baseUrl}/master.m3u8`, directDest, {
        ffmpegPath: ff,
        headers: { Referer: 'https://vixsrc.to/' },
        maxHeight: 720,
      });
      assert.strictEqual(directGot.engine, 'nm3u8dl-re');
      assert.ok(fs.existsSync(directDest) && directGot.bytes > 10 * 1024);
      hits.length = 0;

      const dest = path.join(outDir, 'Test.Movie.720p.mp4');

      const got = await engineDl.hlsToFile(`${baseUrl}/master.m3u8`, dest, null, {
        headers: { Referer: 'https://vixsrc.to/' },
        maxHeight: 720,
      });

      assert.strictEqual(got.engine, 'nm3u8dl-re', `expected nm3u8dl-re engine, got: ${got.engine}`);
      assert.strictEqual(got.file, dest);
      assert.ok(!hits.some((u) => u.startsWith('/v1080/')), `1080p stream was fetched despite maxHeight=720: ${hits}`);
      assert.ok(hits.some((u) => u.startsWith('/v720/')), '720p video stream was not fetched');
      assert.ok(hits.some((u) => u.startsWith('/audio/')), 'separate audio rendition was not fetched');

      const probed = await probeMedia(dest);
      assert.strictEqual(probed.hasVideo, true, 'muxed MP4 missing video track');
      assert.strictEqual(probed.hasAudio, true, 'muxed MP4 missing audio track');

      const leftovers = fs.readdirSync(outDir).filter((n) => n.startsWith('.nm3u8_'));
      assert.strictEqual(leftovers.length, 0, `leftover scratch dirs: ${leftovers}`);
      assert.strictEqual(fs.existsSync(path.join(process.cwd(), 'Logs')), false, 'N_m3u8DL-RE created Logs/ folder');

      console.log(`✅ Real N_m3u8DL-RE muxed 720p video + separate AAC audio into ${(got.bytes / 1024).toFixed(1)} KB MP4!`);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  } finally {
    delete process.env.NM3U8DL_BIN;
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  }
})().catch((err) => {
  console.error('❌ Live N_m3u8DL-RE test failed:', err);
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::error title=Live N_m3u8DL-RE failed::${String(err.message).replace(/\r?\n/g, ' | ')}`);
  }
  process.exit(1);
});
