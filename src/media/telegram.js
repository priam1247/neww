// src/media/telegram.js — merged from Zafar-bot-main: fetch Telegram sticker
// packs and convert stickers into WhatsApp-ready webp. Static (webp) and video
// (webm→webp via ffmpeg) are supported; animated .tgs needs a native lottie
// runtime, so those get an honest "unsupported" instead of a crash.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import config from '../config.js';
import { req } from '../core/http.js';
import ffmpeg from '../utils/ffmpeg.js';
import { withStickerMetadata } from './webpExif.js';
import { tempPath, removeTemp } from './transfer.js';

const API = 'https://api.telegram.org';
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_WA_ANIMATED = 1000 * 1024;

const getToken = () => {
  const t = String(config.telegramBotToken || '').trim();
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(t)) throw new Error('NO_TOKEN');
  return t;
};

// Curated starter packs for keyword lookups (each is verified against Telegram
// before use, so a pack that no longer exists is simply skipped)
export const CURATED_PACKS = {
  animal: ['Animals', 'CatamineCat', 'Hamsters_Stickers'],
  animals: ['Animals', 'CatamineCat', 'Hamsters_Stickers'],
  cat: ['CatamineCat', 'BlueCatpack', 'Catcula'],
  cats: ['CatamineCat', 'BlueCatpack', 'Catcula'],
  meme: ['MemeS1ick3r', 'PEPEtop', 'monkey_stickroom'],
  memes: ['MemeS1ick3r', 'PEPEtop', 'monkey_stickroom'],
  funny: ['MemeS1ick3r', 'monkey_stickroom', 'PEPEtop', 'Hamsters_Stickers'],
  gif: ['MemeS1ick3r', 'GifSpace'],
  pepe: ['PEPEtop'],
  frog: ['PEPEtop'],
  monkey: ['monkey_stickroom'],
  hamster: ['Hamsters_Stickers'],
  default: ['Animals', 'MemeS1ick3r', 'PEPEtop', 'CatamineCat', 'Hamsters_Stickers', 'monkey_stickroom'],
};

const CACHE_TTL = 15 * 60_000;
const packCache = new Map();

// t.me/addstickers/Name, t.me/addemoji/Name, telegram.me / telegram.dog, tg://addstickers?set=Name
export const parsePackLink = (input) => {
  const m = String(input || '').match(
    /(?:https?:\/\/)?(?:t\.me|telegram\.me|telegram\.dog)\/(?:addstickers|addemoji)\/([A-Za-z0-9_]+)/i
  ) || String(input || '').match(/tg:\/\/addstickers\?set=([A-Za-z0-9_]+)/i);
  return m ? m[1] : null;
};

const tgCall = async (method, params) => {
  const token = getToken();
  const data = await req(`${API}/bot${token}/${method}`, {
    retries: 0, timeout: 20_000, json: true,
    headers: { accept: 'application/json' },
    ...params,
    ...(params.body ? {} : {}),
  }).catch(e => {
    const m = String(e.message || '');
    if (/STICKERSET_INVALID|not found/i.test(m)) throw new Error('Sticker pack not found');
    if (/Unauthorized|401/.test(m)) throw new Error('Telegram bot token is invalid');
    throw new Error(m.replace(/bot\d+:[A-Za-z0-9_-]+/, 'bot***') || 'Telegram request failed');
  });
  return data?.result;
};

export async function getStickerSet(name) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Empty sticker pack name');
  const key = clean.toLowerCase();
  const hit = packCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data;
  const set = await tgCall('getStickerSet', { name: clean });
  if (!set?.stickers?.length) throw new Error('Sticker pack not found');
  const data = { name: set.name || clean, title: set.title || clean, stickers: set.stickers };
  packCache.set(key, { data, at: Date.now() });
  return data;
}

/** Keyword → candidate pack names (curated list + tlgrm.eu). */
export async function searchPacksByKeyword(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return CURATED_PACKS.default;
  const candidates = new Set();
  if (CURATED_PACKS[q]) CURATED_PACKS[q].forEach(p => candidates.add(p));
  for (const [k, list] of Object.entries(CURATED_PACKS)) {
    if (k !== 'default' && (q.includes(k) || k.includes(q))) list.forEach(p => candidates.add(p));
  }
  if (/^[a-z0-9_]{3,60}$/i.test(q)) candidates.add(query.trim());
  try {
    const res = await fetch(`https://tlgrm.eu/stickers?q=${encodeURIComponent(q)}`, {
      headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000),
    });
    const html = await res.text();
    for (const m of html.matchAll(/tlgrm\.eu\/stickers\/([A-Za-z0-9_]+)/g)) candidates.add(m[1]);
  } catch { /* curated list still applies */ }
  return [...candidates].slice(0, 12);
}

export async function resolvePack(args) {
  const clean = (args || []).map(a => String(a || '').trim()).filter(Boolean);
  let num = null;
  if (clean.length && /^\d+$/.test(clean[clean.length - 1])) num = parseInt(clean.pop(), 10);
  const query = clean.join(' ').trim();

  const linkName = parsePackLink(query);
  let pack = null;
  if (linkName) pack = await getStickerSet(linkName);
  else if (query) {
    for (const c of await searchPacksByKeyword(query)) {
      try { pack = await getStickerSet(c); break; } catch { /* next */ }
    }
    if (!pack) throw new Error(`No sticker pack found for "${query}"`);
  } else {
    const shuffled = [...CURATED_PACKS.default].sort(() => Math.random() - 0.5);
    for (const c of shuffled) { try { pack = await getStickerSet(c); break; } catch { /* next */ } }
    if (!pack) throw new Error('Could not load a sticker pack right now');
  }
  return { pack, num, query };
}

// Telegram video sticker (webm) → animated webp under WhatsApp's size limit
async function webmToWebp(buffer) {
  const input = tempPath('tg_in', 'webm');
  const output = tempPath('tg_out', 'webp');
  fs.writeFileSync(input, buffer);
  const vf = (fps) =>
    `fps=${fps},scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000`;
  const run = (decoder, fps, q) => ffmpeg.execFile(ffmpeg.resolve(), [
    '-y', ...(decoder ? ['-c:v', 'libvpx-vp9'] : []), '-i', input,
    '-vf', vf(fps), '-c:v', 'libwebp', '-loop', '0', '-an', '-t', '6',
    '-q:v', String(q), '-preset', 'default', output,
  ], { timeout: 60_000 });
  try {
    try { await run(true, 15, 50); } catch { await run(false, 15, 50); }
    if (fs.statSync(output).size > MAX_WA_ANIMATED) await run(false, 10, 30);
    return fs.readFileSync(output);
  } finally {
    removeTemp(input);
    removeTemp(output);
  }
}

async function downloadSticker(sticker) {
  const file = await tgCall('getFile', { file_id: sticker.file_id });
  if (!file?.file_path) throw new Error('Sticker file not found');
  const res = await fetch(`${API}/file/bot${getToken()}/${file.file_path}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Sticker download HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  if (ab.byteLength > MAX_FILE_BYTES * 4) throw new Error('Sticker file too large');
  const buf = Buffer.from(ab);
  if (sticker.is_animated) throw new Error('Animated .tgs stickers need a lottie runtime — not supported on this host');
  return { buf, isVideo: sticker.is_video, emoji: sticker.emoji };
}

/** Raw sticker file (static webp buffer / video webm buffer; .tgs rejected). */
export async function downloadStickerFile(sticker) {
  const { buf } = await downloadSticker(sticker);
  return { buf, isVideo: sticker.is_video };
}

/** Full pipeline: Telegram sticker → WhatsApp sticker buffer. */
export async function buildWhatsAppSticker(sticker, packTitle) {
  const { buf, isVideo, emoji } = await downloadSticker(sticker);
  const webp = isVideo ? await webmToWebp(buf) : buf;
  return withStickerMetadata(webp, { packName: packTitle || config.packName, publisher: config.botName, emoji });
}

export function friendlyError(e) {
  const m = String(e.message || '');
  if (m === 'NO_TOKEN') return '❌ Telegram bot token not set. Add TELEGRAM_BOT_TOKEN in .env (get one from @BotFather).';
  if (/No sticker pack found/i.test(m)) return `❌ ${m}. Try: cat, meme, funny, pepe, or paste a t.me/addstickers link.`;
  if (/STICKERSET_INVALID|not found/i.test(m)) return '❌ Sticker pack not found. Check the link.';
  if (/tgs/i.test(m)) return `❌ ${m}`;
  if (/ENOENT|ffmpeg/i.test(m)) return '❌ ffmpeg is not installed on this host (Termux: pkg install ffmpeg).';
  if (/Unauthorized|401/i.test(m)) return '❌ Telegram bot token is invalid.';
  return `❌ Telegram error: ${m || 'request failed'}`;
}

import * as tgNamespace from './telegram.js';
export default tgNamespace;
