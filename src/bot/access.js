// src/bot/access.js — merged from Zafar-bot-main: owner/admin matching by
// phone number (PN + LID tolerant), persistent whitelist, bot on/off state.
// The old bot was whitelist-only; 3.x defaults to open mode and lets the
// owner switch to whitelist mode with ACCESS_MODE=whitelist or .mode.
import config from '../config.js';
import { store } from '../core/store.js';

// "265894016453:12@s.whatsapp.net" → "265894016453"; LID suffixes stripped.
export const numberOf = (jid) => {
  if (!jid || typeof jid !== 'string') return null;
  const n = jid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  return n.length >= 7 ? n : null;
};

/** Every number we know for this sender (msg.key fields cover PN + LID forms). */
export const senderNumbers = (msg = {}, fallbackJid = '') => {
  const jids = [
    fallbackJid,
    msg.key?.participant,
    msg.key?.participantAlt,
    msg.key?.remoteJidAlt,
    msg.key?.remoteJid,
  ].filter(Boolean);
  const out = new Set();
  for (const j of jids) { const n = numberOf(j); if (n) out.add(n); }
  return [...out];
};

/** Is this sender the owner? Compares ONLY against configured owner identity
 *  (OWNER_NUMBER / BOT_OWNER_JID) — never against the sender themselves. */
export const isOwnerSender = (numbers = []) => {
  const set = new Set(numbers);
  if (config.ownerNumber && set.has(config.ownerNumber)) return true;
  const ownerFromJid = numberOf(config.ownerJid);
  return ownerFromJid ? set.has(ownerFromJid) : false;
};

export const isAdminSender = (numbers = []) =>
  numbers.some(n => config.adminNumbers.includes(n));

// ── whitelist (persisted via store) ─────────────────────────────────────────
export const readWhitelist = () => store.bucket('whitelist', { users: [] });

export const whitelistAdd = (number) => {
  const wl = readWhitelist();
  if (wl.users.some(u => u.number === number)) return false;
  wl.users.push({ number, addedAt: Date.now() });
  store.setBucket('whitelist', wl);
  return true;
};

export const whitelistRemove = (number) => {
  const wl = readWhitelist();
  const before = wl.users.length;
  wl.users = wl.users.filter(u => u.number !== number);
  if (wl.users.length === before) return false;
  store.setBucket('whitelist', wl);
  return true;
};

/** Effective access mode: runtime (.mode) wins, .env is the default. */
export const effectiveMode = () =>
  store.get('state', 'accessMode', '') || config.accessMode || 'open';

/** May this sender talk to the bot at all? Owner always passes. */
export const isAllowedSender = ({ numbers = [], owner = false }) => {
  if (owner) return true;
  if (effectiveMode() !== 'whitelist') return true;   // open mode: everyone
  const wl = readWhitelist();
  return wl.users.some(u => numbers.includes(u.number) || (u.alt || []).some(a => numbers.includes(a)));
};

// ── bot on/off ───────────────────────────────────────────────────────────────
export const botOn = () => store.get('state', 'on', true) !== false;
export const setBotOn = (on) => store.set('state', 'on', Boolean(on));

export default {
  numberOf, senderNumbers, isOwnerSender, isAdminSender,
  readWhitelist, whitelistAdd, whitelistRemove, isAllowedSender,
  botOn, setBotOn,
};
