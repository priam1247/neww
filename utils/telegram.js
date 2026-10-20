/**
 * Telegram sticker helpers - fetch Telegram sticker packs and convert
 * stickers into WhatsApp-ready webp (with pack metadata)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const axios = require('axios');
const webp = require('node-webpmux');
const getFfmpeg = require('./ffmpeg');
const { tgsToWebp } = require('./tgs');
const config = require('../config');
const { getTempDir, deleteTempFile } = require('./tempManager');

const execFileAsync = promisify(execFile);
const API = 'https://api.telegram.org';
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_WA_ANIMATED = 1000 * 1024;

const getToken = () => {
  const t = String(config.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(t)) throw new Error('NO_TOKEN');
  return t;
};

// Curated starter packs for keyword lookups (every candidate is verified against
// Telegram before use, so a name that no longer exists is simply skipped)
const CURATED_PACKS = {
  animal: ['Animals', 'CatamineCat', 'Hamsters_Stickers'],
  animals: ['Animals', 'CatamineCat', 'Hamsters_Stickers'],
  cat: ['CatamineCat', 'BlueCatpack', 'cat_farsi', 'Catcula'],
  cats: ['CatamineCat', 'BlueCatpack', 'cat_farsi', 'Catcula'],
  meme: ['MemeS1ick3r', 'PEPEtop', 'monkey_stickroom'],
  memes: ['MemeS1ick3r', 'PEPEtop', 'monkey_stickroom'],
  funny: ['MemeS1ick3r', 'monkey_stickroom', 'PEPEtop', 'Hamsters_Stickers'],
  video: ['MemeS1ick3r', 'GifSpace'],
  gif: ['MemeS1ick3r', 'GifSpace'],
  pepe: ['PEPEtop'],
  frog: ['PEPEtop'],
  monkey: ['monkey_stickroom'],
  hamster: ['Hamsters_Stickers'],
  default: ['Animals', 'MemeS1ick3r', 'PEPEtop', 'CatamineCat', 'Hamsters_Stickers', 'monkey_stickroom'],
};

const CACHE_TTL = 15 * 60 * 1000;
const packCache = new Map();      // lowercased pack name -> { data, at }
const keywordCache = new Map();   // keyword -> [pack names]
const lastChatPack = new Map();   // chatId -> last pack name used in that chat

// t.me/addstickers/Name, t.me/addemoji/Name, telegram.me / telegram.dog, tg://addstickers?set=Name
const parsePackLink = (input) => {
  if (!input || typeof input !== 'string') return null;
  const m =
    input.match(/(?:https?:\/\/)?(?:t\.me|telegram\.me|telegram\.dog)\/(?:addstickers|addemoji)\/([A-Za-z0-9_]+)/i) ||
    input.match(/tg:\/\/addstickers\?set=([A-Za-z0-9_]+)/i);
  return m ? m[1] : null;
};

const getQuotedText = (msg) => {
  const ctx = msg?.message?.extendedTextMessage?.contextInfo
    || msg?.message?.imageMessage?.contextInfo
    || msg?.message?.videoMessage?.contextInfo;
  const q = ctx?.quotedMessage;
  if (!q) return '';
  return q.conversation || q.extendedTextMessage?.text || q.imageMessage?.caption || q.videoMessage?.caption || '';
};

// Never let the token leak through error messages
const tgCall = async (method, params) => {
  const token = getToken();
  try {
    const res = await axios.get(`${API}/bot${token}/${method}`, { params, timeout: 20000 });
    return res.data.result;
  } catch (e) {
    const d = e.response && e.response.data;
    if (d && d.description) throw new Error(d.description);
    throw new Error(e.code || 'Telegram request failed');
  }
};

const getStickerSet = async (name) => {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Empty sticker pack name');
  const key = clean.toLowerCase();
  const hit = packCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data;

  const set = await tgCall('getStickerSet', { name: clean });
  if (!set || !set.stickers || !set.stickers.length) throw new Error('Sticker pack not found');
  const data = { name: set.name || clean, title: set.title || clean, stickers: set.stickers };
  packCache.set(key, { data, at: Date.now() });
  return data;
};

// Keyword -> candidate pack names (curated list + tlgrm.eu + DuckDuckGo)
const searchPacksByKeyword = async (query) => {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return CURATED_PACKS.default;
  if (keywordCache.has(q)) return keywordCache.get(q);

  const candidates = new Set();
  if (CURATED_PACKS[q]) CURATED_PACKS[q].forEach(p => candidates.add(p));
  for (const [k, list] of Object.entries(CURATED_PACKS)) {
    if (k !== 'default' && (q.includes(k) || k.includes(q))) list.forEach(p => candidates.add(p));
  }
  if (/^[a-z0-9_]{3,60}$/i.test(q)) candidates.add(query.trim());

  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0' };
  await Promise.allSettled([
    axios.get(`https://tlgrm.eu/stickers?q=${encodeURIComponent(q)}`, { timeout: 8000, headers })
      .then(r => { for (const m of String(r.data || '').matchAll(/tlgrm\.eu\/stickers\/([A-Za-z0-9_]+)/g)) candidates.add(m[1]); }),
    axios.get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(`site:t.me/addstickers ${q}`)}`, { timeout: 8000, headers })
      .then(r => { for (const m of String(r.data || '').matchAll(/addstickers(?:\/|%2F)([A-Za-z0-9_]+)/gi)) candidates.add(m[1]); }),
  ]);

  const list = [...candidates].slice(0, 12);
  if (list.length) keywordCache.set(q, list);
  return list.length ? list : CURATED_PACKS.default;
};

// Split ".cmd cat 3" into { query: 'cat', num: 3 } ("3" alone -> no query)
const splitArgs = (args) => {
  const clean = (args || []).map(a => String(a || '').trim()).filter(Boolean);
  let num = null;
  if (clean.length && /^\d+$/.test(clean[clean.length - 1])) {
    num = parseInt(clean.pop(), 10);
  }
  return { query: clean.join(' ').trim(), num };
};

const loadRandomCurated = async () => {
  const shuffled = [...CURATED_PACKS.default].sort(() => Math.random() - 0.5);
  for (const c of shuffled) {
    try { return await getStickerSet(c); } catch {}
  }
  throw new Error('Could not load a sticker pack right now');
};

// Link / quoted link -> keyword search -> remembered pack -> random pack
const resolvePack = async (args, msg, chatId, { useRemembered }) => {
  const { query, num } = splitArgs(args);
  const linkName = parsePackLink(query) || (!query ? parsePackLink(getQuotedText(msg)) : null);
  let pack = null;
  let fromLink = false;

  if (linkName) {
    pack = await getStickerSet(linkName);
    fromLink = true;
  } else if (query) {
    for (const c of await searchPacksByKeyword(query)) {
      try { pack = await getStickerSet(c); break; } catch {}
    }
    if (!pack) throw new Error(`No sticker pack found for "${query}"`);
  } else {
    const remembered = lastChatPack.get(chatId);
    if (remembered && useRemembered) {
      try { pack = await getStickerSet(remembered); } catch {}
    }
    if (!pack) pack = await loadRandomCurated();
  }
  lastChatPack.set(chatId, pack.name);
  return { pack, num, query, fromLink };
};

// Telegram video sticker (webm) -> animated webp under WhatsApp's size limit
const webmToWebp = async (buffer) => {
  const tempDir = getTempDir();
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const input = path.join(tempDir, `tg_in_${id}.webm`);
  const output = path.join(tempDir, `tg_out_${id}.webp`);
  fs.writeFileSync(input, buffer);
  const vf = (fps) =>
    `fps=${fps},scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000`;
  const run = (decoder, fps, q) => execFileAsync(getFfmpeg(), [
    '-y', ...(decoder ? ['-c:v', 'libvpx-vp9'] : []), '-i', input,
    '-vf', vf(fps), '-c:v', 'libwebp', '-loop', '0', '-an', '-t', '6',
    '-q:v', String(q), '-preset', 'default', output
  ], { timeout: 60000 });
  try {
    // libvpx-vp9 decoder keeps transparency; fall back to the default decoder
    try { await run(true, 15, 50); } catch { await run(false, 15, 50); }
    if (fs.statSync(output).size > MAX_WA_ANIMATED) await run(false, 10, 30);
    return fs.readFileSync(output);
  } finally {
    deleteTempFile(input);
    deleteTempFile(output);
  }
};

const downloadSticker = async (sticker) => {
  const file = await tgCall('getFile', { file_id: sticker.file_id });
  if (!file || !file.file_path) throw new Error('Sticker file not found');
  const res = await axios.get(`${API}/file/bot${getToken()}/${file.file_path}`, {
    responseType: 'arraybuffer',
    timeout: 30000,
    maxContentLength: MAX_FILE_BYTES
  }).catch(e => { throw new Error(e.code || 'Download failed'); });
  const buf = Buffer.from(res.data);
  if (sticker.is_animated) return tgsToWebp(buf);
  return sticker.is_video ? webmToWebp(buf) : buf;
};

// Embed pack name / publisher so WhatsApp shows it on the sticker
const withMetadata = async (webpBuffer, packTitle, emoji) => {
  const img = new webp.Image();
  await img.load(webpBuffer);
  const json = {
    'sticker-pack-id': crypto.randomBytes(32).toString('hex'),
    'sticker-pack-name': packTitle || config.packname || 'Made by',
    'sticker-pack-publisher': config.packname || config.botName || '',
    emojis: [emoji || '📖'],
  };
  const exifAttr = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
  ]);
  const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
  const exif = Buffer.concat([exifAttr, jsonBuffer]);
  exif.writeUIntLE(jsonBuffer.length, 14, 4);
  img.exif = exif;
  return img.save(null);
};

// Full pipeline: Telegram sticker -> WhatsApp sticker buffer
const buildWhatsAppSticker = async (sticker, packTitle) =>
  withMetadata(await downloadSticker(sticker), packTitle, sticker.emoji);

const friendlyError = (e) => {
  const m = String(e.message || '');
  if (m === 'NO_TOKEN') return '❌ Telegram bot token not set. Add `telegramBotToken` in config.js (get one from @BotFather).';
  if (/No sticker pack found/i.test(m)) return `❌ ${m}. Try: cat, meme, funny, pepe, or paste a t.me/addstickers link.`;
  if (/STICKERSET_INVALID|not found/i.test(m)) return '❌ Sticker pack not found. Check the link.';
  if (/Cannot find module.*rlottie/i.test(m)) return '❌ Missing package. Run: npm install';
  if (/ENOENT|ffmpeg/i.test(m)) return '❌ ffmpeg is not installed on this host (Termux: pkg install ffmpeg).';
  if (/Unauthorized|401/i.test(m)) return '❌ Telegram bot token is invalid.';
  return `❌ Telegram error: ${m || 'request failed'}`;
};

module.exports = {
  parsePackLink, getStickerSet, searchPacksByKeyword, resolvePack, buildWhatsAppSticker, friendlyError,
};
