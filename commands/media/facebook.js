/**
 * Facebook Downloader - Download Facebook videos (with Progressive H.264 + Audio & WhatsApp codec fix)
 */

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');
const axios = require('axios');
const APIs = require('../../utils/api');
const { getTempDir, deleteTempFile } = require('../../utils/tempManager');
const getFfmpeg = require('../../utils/ffmpeg');

const execFileAsync = promisify(execFile);

// Shared resolver: system ffmpeg → user install → packaged fallback.
const ffmpegPath = getFfmpeg();
const ffmpegWorks = getFfmpeg.works();

const MAX_MEDIA_SIZE = 50 * 1024 * 1024;   // above this, send as document
const MAX_DOWNLOAD = 150 * 1024 * 1024;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Extract direct progressive H.264 + AAC streams from Facebook HTML (includes audio!)
const getDirectFacebookStreams = async (fbUrl) => {
  try {
    const res = await axios.get(fbUrl, {
      timeout: 25000,
      maxRedirects: 10,
      responseType: 'text',
      headers: {
        'User-Agent': 'curl/8.5.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    const html = String(res.data || '');
    const decodeJsonStr = (raw) => {
      if (!raw) return null;
      try {
        return JSON.parse(`"${raw}"`);
      } catch {
        return raw.replace(/\\\//g, '/');
      }
    };

    const hdMatch =
      html.match(/"browser_native_hd_url"\s*:\s*"([^"]+)"/) ||
      html.match(/"playable_url_quality_hd"\s*:\s*"([^"]+)"/);
    const sdMatch =
      html.match(/"browser_native_sd_url"\s*:\s*"([^"]+)"/) ||
      html.match(/"playable_url"\s*:\s*"([^"]+)"/);
    const titleMatch =
      html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) ||
      html.match(/<meta\s+name="description"\s+content="([^"]+)"/i) ||
      html.match(/<title[^>]*>([^<]+)<\/title>/i);

    const hd = decodeJsonStr(hdMatch?.[1]);
    const sd = decodeJsonStr(sdMatch?.[1]);
    const title = titleMatch?.[1]
      ? titleMatch[1]
          .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
          .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
          .replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"')
          .replace(/&#039;/g, "'")
          .trim()
      : null;

    return {
      title: title && title.toLowerCase() !== 'facebook' ? title : null,
      hd_video: hd && !hd.includes('lookaside.fbsbx.com') ? hd : null,
      sd_video: sd && !sd.includes('lookaside.fbsbx.com') ? sd : null
    };
  } catch (e) {
    return { title: null, hd_video: null, sd_video: null };
  }
};

// Download to disk (not memory) and make sure it is really a video file
const downloadToFile = async (url, outPath) => {
  const res = await axios.get(url, {
    responseType: 'stream',
    timeout: 120000,
    maxRedirects: 5,
    headers: { 'User-Agent': UA, 'Accept': '*/*', 'Referer': 'https://www.facebook.com/' }
  });
  const type = String(res.headers['content-type'] || '');
  if (type.includes('text/') || type.includes('json')) {
    res.data.destroy();
    throw new Error('Source returned a web page instead of a video');
  }
  let bytes = 0;
  res.data.on('data', c => {
    bytes += c.length;
    if (bytes > MAX_DOWNLOAD) res.data.destroy(new Error('Video too large'));
  });
  await pipeline(res.data, fs.createWriteStream(outPath));
  if (bytes < 10 * 1024) throw new Error('Downloaded file is too small');
  return bytes;
};

// Probe video/audio codecs via ffmpeg -i stderr
const probeStreams = async (file) => {
  let stderr = '';
  try {
    await execFileAsync(ffmpegPath, ['-hide_banner', '-i', file], { timeout: 30000 });
  } catch (e) {
    stderr = String(e.stderr || '');
  }
  const hasAudio = /Stream #\d+:\d+.*Audio:/i.test(stderr);
  const isH264 = /Stream #\d+:\d+.*Video:\s*h264\b/i.test(stderr);
  const isYuv420p = /yuv420p/i.test(stderr);

  // Also check raw MP4 atoms in case ffmpeg probe output is unavailable
  let rawIsAvc1 = false;
  let rawHasMp4a = false;
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(Math.min(65536, fs.statSync(file).size));
    fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    rawIsAvc1 = head.includes(Buffer.from('avc1')) && !head.includes(Buffer.from('av01')) && !head.includes(Buffer.from('vp09'));
    rawHasMp4a = head.includes(Buffer.from('mp4a'));
  } catch {}

  return {
    hasAudio: hasAudio || rawHasMp4a,
    isWhatsAppCompatibleH264: (isH264 && isYuv420p) || rawIsAvc1
  };
};

// Convert/remux into a WhatsApp-compatible H.264 (avc1) + AAC MP4
// CRITICAL: Never use `-c copy` on AV1 (av01) or VP9 (vp09) streams, as WhatsApp rejects them!
const makeWhatsAppMp4 = async (input, output) => {
  const info = await probeStreams(input);

  if (!ffmpegWorks) {
    // No usable ffmpeg: send the file as-is if it is already H.264, else explain
    if (info.isWhatsAppCompatibleH264) {
      fs.copyFileSync(input, output);
      return;
    }
    const err = new Error('ffmpeg is not available on this host');
    err.code = 'NO_FFMPEG';
    throw err;
  }

  if (info.isWhatsAppCompatibleH264) {
    try {
      await execFileAsync(ffmpegPath, [
        '-y', '-i', input, '-c', 'copy', '-movflags', '+faststart', output
      ], { timeout: 120000 });
      if (fs.existsSync(output) && fs.statSync(output).size > 10 * 1024) return;
    } catch {}
    deleteTempFile(output);
  }

  // Transcode AV1 / VP9 / HEVC / incompatible streams to H.264 + AAC for WhatsApp
  await execFileAsync(ffmpegPath, [
    '-y', '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.1',
    '-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart', output
  ], { timeout: 600000 });
};

module.exports = {
  name: 'fb',
  aliases: ['fbdl', 'facebookdl', 'facebook'],
  category: 'media',
  description: 'Download Facebook videos',
  usage: '.fb <Facebook video URL>',

  async execute(sock, msg, args) {
    const chatId = msg.key.remoteJid;
    const url = args.join(' ').trim();

    if (!url) {
      return sock.sendMessage(chatId, { text: 'Usage: .fb <Facebook video URL>' }, { quoted: msg });
    }
    if (!url.includes('facebook.com') && !url.includes('fb.watch')) {
      return sock.sendMessage(chatId, { text: '❌ Please provide a valid Facebook URL.' }, { quoted: msg });
    }

    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const tempDir = getTempDir();
    const files = [];
    try {
      // Fetch both direct progressive H.264+AAC streams and API fallback concurrently
      const [directData, apiData] = await Promise.all([
        getDirectFacebookStreams(url),
        APIs.getGiftedFacebookByUrl(url).catch(() => ({}))
      ]);

      // Title is only used for the file name — Facebook videos are sent without
      // a caption on purpose (the text under a reposted video is usually noise).
      const title = directData.title || apiData?.title || 'Facebook Video';
      const name = String(title).trim();

      // Prioritize direct progressive H.264+Audio URLs first, then API URLs
      const sources = [
        directData.hd_video,
        directData.sd_video,
        apiData?.hd_video,
        apiData?.sd_video
      ].filter(Boolean);

      if (!sources.length) {
        throw new Error('No video URLs returned');
      }

      let input = null;
      let fallbackInput = null;

      for (let i = 0; i < sources.length; i++) {
        const f = path.join(tempDir, `fb_in_${stamp}_${i}.mp4`);
        files.push(f);
        try {
          await downloadToFile(sources[i], f);
        } catch (e) {
          console.log('Facebook source failed:', e.message);
          continue;
        }
        if (!fallbackInput) fallbackInput = f;

        const info = await probeStreams(f);
        if (info.hasAudio) {
          input = f;
          break;
        }
      }

      input = input || fallbackInput;
      if (!input) throw new Error('No usable video source');

      const output = path.join(tempDir, `fb_out_${stamp}.mp4`);
      files.push(output);
      await makeWhatsAppMp4(input, output);

      // Send from disk: Baileys streams it, so a 150 MB video never sits in RAM
      // (the old build read the whole file into a Buffer on a 2 GB host).
      const size = fs.existsSync(output) ? fs.statSync(output).size : 0;
      if (!size) throw new Error('the converted video is empty');

      if (size > MAX_MEDIA_SIZE) {
        await sock.sendMessage(chatId, {
          document: { url: output },
          fileName: `${name.replace(/[^\w\s.-]/gi, '').trim() || 'facebook_video'}.mp4`,
          mimetype: 'video/mp4'
        }, { quoted: msg });
      } else {
        await sock.sendMessage(chatId, {
          video: { url: output },
          mimetype: 'video/mp4'
        }, { quoted: msg });
      }
    } catch (err) {
      console.error('Facebook command error:', err.message);
      await sock.sendMessage(chatId, {
        text: err.code === 'NO_FFMPEG'
          ? '❌ ffmpeg is not installed on this host (Termux: pkg install ffmpeg).'
          : '❌ Failed to fetch video. Check the link and try again.'
      }, { quoted: msg });
    } finally {
      files.forEach(f => deleteTempFile(f));
    }
  }
};
