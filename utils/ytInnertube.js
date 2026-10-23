'use strict';

/**
 * ZaFar Bot — Native YouTube Innertube + BotGuard PoToken + SABR Engine
 *
 * Clean, disk-streaming port of levanter's `youtubei.js` v18 + `bgutils-js`
 * + `googlevideo` (`SabrStream`) pipeline:
 *   • Mints real BotGuard Proof-of-Origin (`PoToken`) tokens locally via JSDOM
 *     (serialized with a mutex so concurrent jobs never race on globals), with
 *     automatic `generateColdStartToken` fallback.
 *   • Supports Google TV OAuth2 credentials saved by `.ytlogin` (`ytAuth.js`)
 *     with automatic refresh-token persistence, plus Netscape cookies from
 *     `.cookies set`.
 *   • Streams SABR (`SabrStream`) and standard Innertube media directly to disk
 *     under strict `maxBytes` + timeout caps — never buffering full files in RAM.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const getFfmpeg = require('./ffmpeg');
const { getTempDir } = require('./tempManager');
const ytAuth = require('./ytAuth');

const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo';
const VIDEO_QUALITIES = ['1080p', '720p', '480p', '360p', '240p', '144p'];
const AUDIO_QUALITIES = ['AUDIO_QUALITY_HIGH', 'AUDIO_QUALITY_MEDIUM', 'AUDIO_QUALITY_LOW'];
const UNAUTH_CLIENTS = ['ANDROID_VR', 'IOS', 'TV', 'WEB', 'MWEB', 'ANDROID', 'TV_EMBEDDED'];
const AUTH_CLIENTS = ['TV', 'TV_EMBEDDED'];

const VIDEO_ID_RE = /(?:[?&]v=|\/embed\/|\/shorts\/|\/live\/|youtu\.be\/|\/v\/)([-_0-9A-Za-z]{11})/;

function extractVideoId(input) {
  const s = String(input || '').trim();
  if (/^[-_0-9A-Za-z]{11}$/.test(s)) return s;
  const m = s.match(VIDEO_ID_RE);
  return m ? m[1] : null;
}

let _deps = null;
let _platformLoaded = false;

async function loadDeps() {
  if (_deps) return _deps;
  try {
    const yt = await import('youtubei.js');
    if (!_platformLoaded && yt.Platform?.load) {
      _platformLoaded = true;
      yt.Platform.load({
        ...yt.Platform.shim,
        eval: (data) => {
          const code = typeof data === 'string' ? data : data?.output;
          // eslint-disable-next-line no-new-func
          return new Function(code)();
        },
      });
    }
    const { BG } = require('bgutils-js');
    const { SabrStream } = require('googlevideo/sabr-stream');
    const { buildSabrFormat, EnabledTrackTypes } = require('googlevideo/utils');
    const { JSDOM } = require('jsdom');
    _deps = { yt, BG, SabrStream, buildSabrFormat, EnabledTrackTypes, JSDOM };
    return _deps;
  } catch (err) {
    throw Object.assign(
      new Error(`Innertube dependencies unavailable: ${err.message}`),
      { code: 'NO_INNERTUBE_DEPS' }
    );
  }
}

// ─── COOKIE HEADER BRIDGE (.cookies set -> Innertube) ─────────────────────────

function readYoutubeCookieHeader() {
  try {
    const YT = require('./youtubedl');
    const file = YT.cookieFile();
    if (!file || !fs.existsSync(file)) return undefined;
    const raw = fs.readFileSync(file, 'utf8');
    const pairs = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const parts = t.split('\t');
      if (parts.length < 7) continue;
      const domain = parts[0].toLowerCase();
      if (!domain.includes('youtube.com') && !domain.includes('google.com')) continue;
      const name = parts[5].trim();
      const val = parts[6].trim();
      if (name) pairs.push(`${name}=${val}`);
    }
    return pairs.length ? pairs.join('; ') : undefined;
  } catch {
    return undefined;
  }
}

// ─── BOTGUARD POTOKEN GENERATION (MUTEX-SERIALIZED) ──────────────────────────

const _poCache = new Map();
const PO_CACHE_TTL_MS = 15 * 60 * 1000;
let _bgQueue = Promise.resolve();

function decodeVisitorIdentifier(identifier) {
  let clean = String(identifier || '');
  if (clean.length > 60) {
    try {
      const b64 = clean.replace(/-/g, '+').replace(/_/g, '/').replace(/%3D/gi, '=');
      const buf = Buffer.from(b64, 'base64');
      if (buf[0] === 0x0a && buf.length > 2) {
        const len = buf[1];
        const inner = buf.slice(2, 2 + len).toString('utf8');
        if (inner && inner.length < 110) clean = inner;
      }
    } catch { /* keep original */ }
  }
  return clean.slice(0, 110);
}

async function generatePoToken(identifier, customFetch) {
  if (!identifier) throw new Error('No visitorData identifier for PoToken');

  const now = Date.now();
  const cached = _poCache.get(identifier);
  if (cached && now - cached.ts < PO_CACHE_TTL_MS) {
    return { visitorData: identifier, poToken: cached.poToken };
  }

  const { BG, JSDOM } = await loadDeps();

  const runTask = async () => {
    const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
      url: 'https://www.youtube.com/',
    });
    const prevWindow = globalThis.window;
    const prevDocument = globalThis.document;
    const prevNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    try {
      Object.defineProperty(globalThis, 'navigator', {
        value: dom.window.navigator,
        configurable: true,
        writable: true,
      });
    } catch { /* Node 22 read-only navigator getter is already valid */ }

    const fetchFn = customFetch || ((u, o) => fetch(u, o));
    try {
      const bgConfig = {
        fetch: fetchFn,
        globalObj: globalThis,
        identifier,
        requestKey: REQUEST_KEY,
      };
      const challenge = await Promise.race([
        BG.Challenge.create(bgConfig),
        new Promise((_, rej) => {
          const t = setTimeout(() => rej(new Error('BotGuard challenge timeout')), 8000);
          t.unref?.();
        }),
      ]);
      const script = challenge?.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
      if (!challenge || !script) throw new Error('Empty BotGuard challenge script');

      // eslint-disable-next-line no-new-func
      new Function(script)();

      const generated = await Promise.race([
        BG.PoToken.generate({
          program: challenge.program,
          globalName: challenge.globalName,
          bgConfig,
        }),
        new Promise((_, rej) => {
          const t = setTimeout(() => rej(new Error('BotGuard mint timeout')), 8000);
          t.unref?.();
        }),
      ]);

      if (!generated?.poToken) throw new Error('BotGuard did not return poToken');
      _poCache.set(identifier, { poToken: generated.poToken, ts: Date.now() });
      while (_poCache.size > 40) _poCache.delete(_poCache.keys().next().value);
      return { visitorData: identifier, poToken: generated.poToken };
    } catch {
      const coldId = decodeVisitorIdentifier(identifier);
      const fallbackToken = BG.PoToken.generateColdStartToken(coldId);
      return { visitorData: identifier, poToken: fallbackToken, coldStart: true };
    } finally {
      if (prevWindow === undefined) delete globalThis.window;
      else globalThis.window = prevWindow;
      if (prevDocument === undefined) delete globalThis.document;
      else globalThis.document = prevDocument;
      if (prevNavigator) {
        try { Object.defineProperty(globalThis, 'navigator', prevNavigator); } catch { /* ignore */ }
      }
      try { dom.window.close(); } catch { /* ignore */ }
    }
  };

  const next = _bgQueue.then(runTask, runTask);
  _bgQueue = next.catch(() => {});
  return next;
}

// ─── CLIENT POOL ──────────────────────────────────────────────────────────────

const _clientCache = new Map();
ytAuth.onAuthChange(() => _clientCache.clear());

async function getClient(clientType = 'WEB', oauthCreds = null) {
  const { yt } = await loadDeps();
  const cookie = oauthCreds ? undefined : readYoutubeCookieHeader();
  const cacheKey = `${oauthCreds ? 'oauth' : (cookie ? 'cookie' : 'anon')}:${clientType}`;
  if (_clientCache.has(cacheKey)) return _clientCache.get(cacheKey);

  const client = await yt.Innertube.create({
    cache: new yt.UniversalCache(false),
    cookie,
    generate_session_locally: true,
    client_type: clientType,
  });

  if (oauthCreds) {
    client.session.on('credentials-update', ({ credentials }) => {
      try { ytAuth.saveYtCreds(credentials, { notify: false }); } catch { /* ignore */ }
    });
    await client.session.signIn(oauthCreds);
  }

  _clientCache.set(cacheKey, client);
  return client;
}

async function fetchPlayerRaw(innertube, videoId, poToken) {
  const payload = {
    videoId,
    playbackContext: {
      adPlaybackContext: { pyv: true },
      contentPlaybackContext: {
        vis: 0,
        splay: false,
        lactMilliseconds: '-1',
        signatureTimestamp: innertube.session?.player?.signature_timestamp,
      },
    },
    ...(poToken ? { serviceIntegrityDimensions: { poToken } } : {}),
    contentCheckOk: true,
    racyCheckOk: true,
    parse: true,
  };
  return innertube.actions.execute('/player', payload);
}

function pickClosestLabel(requested, available, ladder) {
  if (!available.length) return requested;
  if (available.includes(requested)) return requested;
  const idx = ladder.indexOf(requested);
  if (idx === -1) return available[0];
  for (let i = idx + 1; i < ladder.length; i++) {
    if (available.includes(ladder[i])) return ladder[i];
  }
  for (let i = idx - 1; i >= 0; i--) {
    if (available.includes(ladder[i])) return ladder[i];
  }
  return available[0];
}

// ─── DISK STREAMING & MUXING ──────────────────────────────────────────────────

async function streamWebReadableToFile(readable, filePath, { maxBytes = 500 * 1024 * 1024, timeoutMs = 240000 } = {}) {
  const reader = readable.getReader();
  const ws = fs.createWriteStream(filePath, { flags: 'w' });
  let written = 0;
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    try { reader.cancel(new Error('stream timed out')); } catch { /* ignore */ }
    ws.destroy(new Error('Innertube stream timed out'));
  }, timeoutMs);
  timer.unref?.();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || !value.byteLength) continue;
      written += value.byteLength;
      if (written > maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw Object.assign(new Error('File exceeds maximum allowed size'), { code: 'TOO_BIG' });
      }
      if (!ws.write(Buffer.from(value.buffer, value.byteOffset, value.byteLength))) {
        await new Promise((resolve, reject) => {
          ws.once('drain', resolve);
          ws.once('error', reject);
        });
      }
    }
    await new Promise((resolve, reject) => {
      ws.end((err) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    ws.destroy();
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    if (timedOut) throw Object.assign(new Error('Innertube stream timed out'), { code: 'NETWORK' });
    throw err;
  } finally {
    clearTimeout(timer);
    try { reader.releaseLock(); } catch { /* ignore */ }
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    throw Object.assign(new Error('Innertube produced an empty stream'), { code: 'NO_FORMATS' });
  }
  return filePath;
}

function mergeTracksWithFfmpeg(videoPath, audioPath, outputPath) {
  const ffmpeg = getFfmpeg();
  if (!getFfmpeg.works()) {
    throw Object.assign(new Error('ffmpeg is required to merge adaptive SABR tracks'), { code: 'FFMPEG_MISSING' });
  }
  try {
    execFileSync(ffmpeg, [
      '-y', '-nostdin',
      '-i', videoPath,
      '-i', audioPath,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-movflags', '+faststart',
      outputPath,
    ], {
      timeout: 8 * 60 * 1000,
      stdio: ['ignore', 'ignore', 'pipe'],
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (err) {
    try { fs.unlinkSync(outputPath); } catch { /* ignore */ }
    throw err;
  }
  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
    try { fs.unlinkSync(outputPath); } catch { /* ignore */ }
    throw Object.assign(new Error('Merged video output is empty'), { code: 'NO_FORMATS' });
  }
  return outputPath;
}

// ─── DOWNLOAD EXECUTION ───────────────────────────────────────────────────────

let _testOverride = null;
function _setTestOverride(fn) {
  _testOverride = fn;
}

async function downloadWithClient(videoId, clientType, oauthCreds, mode, {
  outBase,
  height = 720,
  maxBytes = 300 * 1024 * 1024,
  timeoutMs = 180000,
}) {
  const { yt, SabrStream, buildSabrFormat, EnabledTrackTypes } = await loadDeps();
  const innertube = await getClient(clientType, oauthCreds);
  const visitorData = innertube.session?.context?.client?.visitorData || videoId;
  const poData = await generatePoToken(visitorData, (u, o) => innertube.session.http.fetch(u, o));

  const info = await innertube.getBasicInfo(videoId);
  const page = Array.isArray(info.page) ? info.page[0] : info.page;
  const metadata = {
    id: info.basic_info?.id || videoId,
    title: info.basic_info?.title || '',
    author: info.basic_info?.author || '',
    duration: Number(info.basic_info?.duration) || 0,
    views: Number(info.basic_info?.view_count) || 0,
  };

  const sabrRawUrl = page?.streaming_data?.server_abr_streaming_url;
  const sabrUrl = sabrRawUrl && innertube.session?.player
    ? await innertube.session.player.decipher(sabrRawUrl)
    : sabrRawUrl;
  const adaptiveRaw = page?.streaming_data?.adaptive_formats || [];

  let videoStream = null;
  let audioStream = null;

  if (sabrUrl && adaptiveRaw.length) {
    const sabrFormats = adaptiveRaw.map(buildSabrFormat);
    const playerCfg = page?.player_config || page?.playerConfig;
    const commonCfg = playerCfg?.media_common_config || playerCfg?.mediaCommonConfig;
    const ustreamerCfg = commonCfg?.media_ustreamer_request_config || commonCfg?.mediaUstreamerRequestConfig;
    const playbackUstreamer = ustreamerCfg?.video_playback_ustreamer_config || ustreamerCfg?.videoPlaybackUstreamerConfig;

    const clientNameStr = innertube.session?.context?.client?.clientName;
    const clientNameId = parseInt(yt.Constants?.CLIENT_NAME_IDS?.[clientNameStr], 10) || 1;
    const clientVersion = innertube.session?.context?.client?.clientVersion || '2.20260101.00.00';

    const sabr = new SabrStream({
      formats: sabrFormats,
      serverAbrStreamingUrl: sabrUrl,
      videoPlaybackUstreamerConfig: playbackUstreamer,
      poToken: poData.poToken,
      clientInfo: {
        clientName: clientNameId,
        clientVersion,
      },
      fetch: (u, o) => innertube.session.http.fetch(u, o),
    });

    sabr.on('reloadPlayerResponse', async () => {
      try {
        const refreshed = await fetchPlayerRaw(innertube, videoId, poData.poToken);
        const nextRawUrl = refreshed?.streaming_data?.server_abr_streaming_url;
        const nextUrl = nextRawUrl && innertube.session?.player
          ? await innertube.session.player.decipher(nextRawUrl)
          : nextRawUrl;
        const nextUstreamer = refreshed?.player_config?.media_common_config
          ?.media_ustreamer_request_config?.video_playback_ustreamer_config;
        if (nextUrl && nextUstreamer) {
          sabr.setStreamingURL(nextUrl);
          sabr.setUstreamerConfig(nextUstreamer);
        }
      } catch { /* SabrStream handles retry/error */ }
    });

    const availVideo = [...new Set(
      sabrFormats.filter((f) => f.mimeType?.includes('video')).map((f) => f.qualityLabel).filter(Boolean)
    )];
    const availAudio = [...new Set(
      sabrFormats.filter((f) => f.mimeType?.includes('audio')).map((f) => f.audioQuality).filter(Boolean)
    )];

    const targetVideoLabel = `${Number(height) || 720}p`;
    const chosenVideo = availVideo.length
      ? pickClosestLabel(targetVideoLabel, availVideo, VIDEO_QUALITIES)
      : targetVideoLabel;
    const chosenAudio = availAudio.length
      ? pickClosestLabel('AUDIO_QUALITY_HIGH', availAudio, AUDIO_QUALITIES)
      : 'AUDIO_QUALITY_HIGH';

    const started = await sabr.start({
      preferWebM: false,
      preferOpus: false,
      videoQuality: chosenVideo,
      audioQuality: chosenAudio,
      enabledTrackTypes: mode === 'audio'
        ? EnabledTrackTypes.AUDIO_ONLY
        : EnabledTrackTypes.VIDEO_AND_AUDIO,
    });
    videoStream = started.videoStream;
    audioStream = started.audioStream;
  } else {
    const stream = await innertube.download(videoId, {
      type: mode === 'audio' ? 'audio' : 'video+audio',
      quality: mode === 'audio' ? 'best' : `${Number(height) || 720}p`,
      format: 'mp4',
    });
    if (mode === 'audio') audioStream = stream;
    else videoStream = stream;
  }

  if (mode === 'audio') {
    if (!audioStream) throw new Error('No audio stream returned by Innertube');
    const audioFile = `${outBase}_it.m4a`;
    await streamWebReadableToFile(audioStream, audioFile, { maxBytes, timeoutMs });
    return { file: audioFile, ext: 'm4a', client: clientType, metadata };
  }

  // Video mode
  if (!videoStream) throw new Error('No video stream returned by Innertube');
  if (audioStream) {
    const vTmp = `${outBase}_it_v.mp4`;
    const aTmp = `${outBase}_it_a.m4a`;
    const mergedOut = `${outBase}_it.mp4`;
    try {
      await Promise.all([
        streamWebReadableToFile(videoStream, vTmp, { maxBytes, timeoutMs }),
        streamWebReadableToFile(audioStream, aTmp, { maxBytes: Math.min(maxBytes, 150 * 1024 * 1024), timeoutMs }),
      ]);
      mergeTracksWithFfmpeg(vTmp, aTmp, mergedOut);
      return { file: mergedOut, ext: 'mp4', client: clientType, metadata };
    } finally {
      try { fs.unlinkSync(vTmp); } catch { /* ignore */ }
      try { fs.unlinkSync(aTmp); } catch { /* ignore */ }
    }
  }

  const progOut = `${outBase}_it.mp4`;
  await streamWebReadableToFile(videoStream, progOut, { maxBytes, timeoutMs });
  return { file: progOut, ext: 'mp4', client: clientType, metadata };
}

function isEnabled(opts = {}) {
  if (_testOverride) return true;
  if (opts._allowInFakeYtdlp) return true;
  if (process.env.FAKE_YTDLP) return false;
  if (process.env.YT_INNERTUBE_DISABLED === '1') return false;
  return true;
}

async function runCascade(urlOrId, mode, opts = {}) {
  if (_testOverride) return _testOverride(urlOrId, mode, opts);
  if (!isEnabled(opts)) {
    throw Object.assign(new Error('Innertube disabled in mock yt-dlp test mode'), { code: 'INNERTUBE_SKIPPED' });
  }

  const videoId = extractVideoId(urlOrId);
  if (!videoId) {
    throw Object.assign(new Error('Not a valid YouTube video URL/ID'), { code: 'UNSUPPORTED_URL' });
  }

  const { yt } = await loadDeps();
  const base = opts.outBase || path.join(getTempDir(), `it_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
  const maxBytes = Math.max(1, Number(opts.maxMB) || 200) * 1024 * 1024;
  const timeoutMs = Number(opts.timeoutMs) || 120000;
  const startedAt = Date.now();
  const errors = [];

  const oauthCreds = ytAuth.getYtCreds();
  if (oauthCreds) {
    const authList = AUTH_CLIENTS.filter((c) => yt.Constants?.CLIENTS?.[c]);
    for (const clientType of authList) {
      if (Date.now() - startedAt > timeoutMs - 5000) break;
      try {
        const res = await downloadWithClient(videoId, clientType, oauthCreds, mode, {
          outBase: base,
          height: opts.height,
          maxBytes,
          timeoutMs: Math.max(15000, timeoutMs - (Date.now() - startedAt)),
        });
        return { ...res, authenticated: true };
      } catch (err) {
        errors.push(`oauth:${clientType}: ${err.message}`);
        if (opts.onAttempt) opts.onAttempt(`innertube:${clientType}(oauth)`, err);
        if (err.code === 'TOO_BIG') throw err;
      }
    }
  }

  const anonList = UNAUTH_CLIENTS.filter((c) => yt.Constants?.CLIENTS?.[c]);
  for (const clientType of anonList) {
    if (Date.now() - startedAt > timeoutMs - 5000) break;
    try {
      const res = await downloadWithClient(videoId, clientType, null, mode, {
        outBase: base,
        height: opts.height,
        maxBytes,
        timeoutMs: Math.max(15000, timeoutMs - (Date.now() - startedAt)),
      });
      return { ...res, authenticated: false };
    } catch (err) {
      errors.push(`${clientType}: ${err.message}`);
      if (opts.onAttempt) opts.onAttempt(`innertube:${clientType}`, err);
      if (err.code === 'TOO_BIG') throw err;
    }
  }

  const err = new Error(`Innertube clients failed (${errors.slice(0, 3).join('; ') || 'no clients'})`);
  err.code = errors.some((e) => /bot|login|sign in|confirm/i.test(e)) ? 'BOT_CHECK' : 'NO_FORMATS';
  err.attempts = errors;
  throw err;
}

async function downloadAudio(urlOrId, opts = {}) {
  return runCascade(urlOrId, 'audio', opts);
}

async function downloadVideo(urlOrId, opts = {}) {
  return runCascade(urlOrId, 'video', opts);
}

async function getVideoInfo(urlOrId, opts = {}) {
  if (process.env.FAKE_YTDLP && !opts._allowInFakeYtdlp) throw new Error('Innertube disabled in mock test mode');
  if (!isEnabled(opts)) throw new Error('Innertube disabled');
  const videoId = extractVideoId(urlOrId);
  if (!videoId) throw new Error('Invalid YouTube video ID');
  const oauthCreds = ytAuth.getYtCreds();
  const client = oauthCreds ? await getClient('TV', oauthCreds) : await getClient('WEB', null);
  const raw = await fetchPlayerRaw(client, videoId);
  const details = raw?.video_details || {};
  const thumb = Array.isArray(details.thumbnails) && details.thumbnails.length
    ? details.thumbnails[details.thumbnails.length - 1]?.url || details.thumbnails[0]?.url || ''
    : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  return {
    id: videoId,
    title: String(details.title || '').trim(),
    duration: Number(details.duration) || 0,
    uploader: String(details.author || '').trim(),
    thumbnail: thumb,
  };
}

async function searchVideos(query, { limit = 5, _allowInFakeYtdlp = false } = {}) {
  if (!isEnabled({ _allowInFakeYtdlp })) return [];
  const q = String(query || '').trim();
  if (!q) return [];
  try {
    const client = await getClient('WEB', null);
    const search = await client.search(q, { type: 'video' });
    const items = search?.videos || search?.results || [];
    const out = [];
    for (const v of items) {
      const id = v?.id || v?.video_id;
      if (!id || !/^[-_0-9A-Za-z]{11}$/.test(String(id))) continue;
      const title = String(v?.title?.text || v?.title || '').trim();
      const author = String(v?.author?.name || v?.channel?.name || '').trim();
      const durSec = Number(v?.duration?.seconds) || 0;
      const thumb = v?.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
      out.push({
        id: String(id),
        url: `https://www.youtube.com/watch?v=${id}`,
        title: title || 'Unknown title',
        uploader: author,
        author,
        duration: durSec,
        thumbnail: thumb,
      });
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    return [];
  }
}

module.exports = {
  extractVideoId,
  loadDeps,
  generatePoToken,
  streamWebReadableToFile,
  mergeTracksWithFfmpeg,
  downloadAudio,
  downloadVideo,
  getVideoInfo,
  searchVideos,
  isEnabled,
  _setTestOverride,
};
