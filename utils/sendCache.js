const fs = require('fs');
const path = require('path');
const { proto, generateWAMessageFromContent } = require('@whiskeysockets/baileys');
const config = require('../config');

const CACHE_FILE = path.join(process.cwd(), 'database', 'send_cache.json');
const MAX_ENTRIES = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
const MEDIA_TYPES = new Set([
  'audioMessage', 'documentMessage', 'imageMessage', 'stickerMessage',
  'videoMessage', 'ptvMessage',
]);

let entries = null;

function enabled() {
  return Number(config.media?.sendCacheDays ?? 7) > 0;
}

function ttlMs() {
  return Math.max(0, Number(config.media?.sendCacheDays ?? 7)) * DAY_MS;
}

function writeStore() {
  const dir = path.dirname(CACHE_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tempFile = `${CACHE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(entries));
  fs.renameSync(tempFile, CACHE_FILE);
}

function prune() {
  if (!entries) entries = {};
  const now = Date.now();
  const ttl = ttlMs();
  let changed = false;

  for (const [key, entry] of Object.entries(entries)) {
    if (!entry || !Number.isFinite(Number(entry.ts)) || now - Number(entry.ts) > ttl) {
      delete entries[key];
      changed = true;
    }
  }

  const keys = Object.keys(entries);
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => Number(entries[a].ts) - Number(entries[b].ts));
    for (const key of keys.slice(0, keys.length - MAX_ENTRIES)) {
      delete entries[key];
      changed = true;
    }
  }

  return changed;
}

function loadStore() {
  if (entries) return entries;
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    entries = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    entries = {};
  }
  if (prune()) writeStore();
  return entries;
}

function encodeMessage(message) {
  const clean = { ...message };
  for (const type of MEDIA_TYPES) {
    const media = clean[type];
    if (media && typeof media === 'object' && media.contextInfo) {
      clean[type] = { ...media };
      delete clean[type].contextInfo;
    }
  }
  return clean;
}

function remember(key, sentWAMessage) {
  if (!enabled() || !key || !sentWAMessage?.message) return false;
  try {
    loadStore();
    const message = encodeMessage(sentWAMessage.message);
    entries[String(key)] = {
      b64: Buffer.from(proto.Message.encode(message).finish()).toString('base64'),
      type: Object.keys(message).find((name) => MEDIA_TYPES.has(name)) || 'unknown',
      ts: Date.now(),
    };
    prune();
    writeStore();
    return true;
  } catch {
    return false;
  }
}

function remove(key) {
  loadStore();
  if (Object.prototype.hasOwnProperty.call(entries, key)) {
    delete entries[key];
    try { writeStore(); } catch { /* the in-memory entry is still removed */ }
  }
}

async function replay(sock, chatId, quotedMsg, key) {
  if (!enabled() || !key) return false;
  try {
    loadStore();
    if (prune()) writeStore();
    const entry = entries[String(key)];
    if (!entry) return false;

    const message = proto.Message.decode(Buffer.from(entry.b64, 'base64'));
    const outgoing = generateWAMessageFromContent(chatId, message, {
      userJid: sock.user.id,
      quoted: quotedMsg,
    });
    await sock.relayMessage(chatId, outgoing.message, { messageId: outgoing.key.id });

    entry.ts = Date.now();
    prune();
    writeStore();
    return true;
  } catch {
    remove(String(key));
    return false;
  }
}

function count() {
  loadStore();
  if (prune()) {
    try { writeStore(); } catch { /* count remains useful in memory */ }
  }
  return Object.keys(entries).length;
}

function clear() {
  entries = {};
  try { writeStore(); } catch { /* keep the in-memory cache cleared */ }
}

module.exports = { remember, replay, count, clear };
