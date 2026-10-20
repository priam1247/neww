/**
 * TGS (Telegram animated sticker) -> animated WebP
 * A .tgs file is gzipped Lottie JSON. It is rendered frame by frame with
 * rlottie (WebAssembly, no browser needed) and piped into ffmpeg.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { once } = require('events');
const { pathToFileURL } = require('url');
const getFfmpeg = require('./ffmpeg');
const { getTempDir, deleteTempFile } = require('./tempManager');

const SIZE = 512;
const MAX_SECONDS = 6;
const MAX_WA_ANIMATED = 1000 * 1024;

let rlottiePromise = null;

// rlottie is an ES module; load it once and bind the wasm functions we need
const loadRlottie = () => {
  if (rlottiePromise) return rlottiePromise;
  rlottiePromise = (async () => {
    const wasmPath = require.resolve('rlottie/wasm');
    const jsPath = path.join(path.dirname(wasmPath), 'rlottie.js');
    const mod = await import(pathToFileURL(jsPath).href);
    const M = await mod.default({ wasmBinary: fs.readFileSync(wasmPath) });
    return {
      M,
      init: M.cwrap('lottie_init', 'number', []),
      destroy: M.cwrap('lottie_destroy', null, ['number']),
      load: M.cwrap('lottie_load_from_data', 'number', ['number', 'number']),
      resize: M.cwrap('lottie_resize', null, ['number', 'number', 'number']),
      buffer: M.cwrap('lottie_buffer', 'number', ['number']),
      render: M.cwrap('lottie_render', null, ['number', 'number']),
    };
  })().catch(e => { rlottiePromise = null; throw e; });
  return rlottiePromise;
};

const renderToWebp = async (jsonBuf, lottieFps, outFps, quality, output) => {
  const R = await loadRlottie();
  const ctx = R.init();
  try {
    const ptr = R.M._malloc(jsonBuf.length + 1);
    R.M.HEAPU8.set(jsonBuf, ptr);
    R.M.HEAPU8[ptr + jsonBuf.length] = 0;
    const totalFrames = R.load(ctx, ptr);
    if (!totalFrames || totalFrames < 1) throw new Error('Invalid animated sticker');
    R.resize(ctx, SIZE, SIZE);

    const seconds = Math.min(MAX_SECONDS, totalFrames / lottieFps);
    const outFrames = Math.max(1, Math.round(seconds * outFps));

    const ff = spawn(getFfmpeg(), [
      '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${SIZE}x${SIZE}`,
      '-framerate', String(outFps), '-i', '-',
      '-c:v', 'libwebp', '-lossless', '0', '-q:v', String(quality),
      '-loop', '0', '-an', '-preset', 'default', output
    ], { stdio: ['pipe', 'ignore', 'pipe'] });

    let stderr = '';
    ff.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
    const closed = new Promise((resolve, reject) => {
      ff.on('error', reject);
      ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${stderr.trim().split('\n').pop()}`)));
    });
    ff.stdin.on('error', () => {}); // surfaced through the close handler

    for (let i = 0; i < outFrames; i++) {
      const frame = Math.min(totalFrames - 1, Math.floor((i * lottieFps) / outFps));
      R.render(ctx, frame);
      const start = R.buffer(ctx);
      // copy out of wasm memory before writing
      const rgba = Buffer.from(R.M.HEAPU8.slice(start, start + SIZE * SIZE * 4));
      if (!ff.stdin.write(rgba)) await once(ff.stdin, 'drain');
    }
    ff.stdin.end();
    await closed;
  } finally {
    R.destroy(ctx);
  }
};

const tgsToWebp = async (tgsBuffer) => {
  const jsonBuf = zlib.gunzipSync(tgsBuffer);
  const lottieFps = Number(JSON.parse(jsonBuf.toString('utf8')).fr) || 60;
  const output = path.join(getTempDir(), `tgs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.webp`);
  try {
    await renderToWebp(jsonBuf, lottieFps, 15, 50, output);
    // WhatsApp rejects animated stickers over ~1 MB: retry smaller
    if (fs.statSync(output).size > MAX_WA_ANIMATED) {
      await renderToWebp(jsonBuf, lottieFps, 10, 30, output);
    }
    return fs.readFileSync(output);
  } finally {
    deleteTempFile(output);
  }
};

module.exports = { tgsToWebp };
