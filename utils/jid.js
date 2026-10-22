/**
 * JID helpers - WhatsApp identifies people by phone number (PN) or by LID.
 * Group mentions and some senders use LIDs, so identity checks compare every
 * known form of a person (PN and LID), never just one.
 */

const fs = require('fs');
const path = require('path');
const { jidDecode, jidEncode } = require('@whiskeysockets/baileys');
const config = require('../config');

// Read a LID <-> PN mapping from the session folder (never cache misses:
// the mapping file can appear after the first message)
const lidCache = new Map();
const getLidMappingValue = (user, direction) => {
  if (!user) return null;
  const cacheKey = `${direction}:${user}`;
  if (lidCache.has(cacheKey)) return lidCache.get(cacheKey);

  const sessionPath = path.join(__dirname, '..', config.sessionName || 'session');
  const suffix = direction === 'pnToLid' ? '.json' : '_reverse.json';
  const filePath = path.join(sessionPath, `lid-mapping-${user}${suffix}`);
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    const value = raw ? JSON.parse(raw) : null;
    if (value) lidCache.set(cacheKey, value);
    return value || null;
  } catch {
    return null;
  }
};

// Just the number part of a JID ("123:5@s.whatsapp.net" -> "123")
const normalizeJid = (jid) => {
  if (!jid || typeof jid !== 'string') return null;
  if (jid.includes(':')) return jid.split(':')[0];
  if (jid.includes('@')) return jid.split('@')[0];
  return jid;
};

// Map a LID JID to its phone-number JID when the mapping is known
const normalizeJidWithLid = (jid) => {
  if (!jid) return jid;
  try {
    const decoded = jidDecode(jid);
    if (!decoded?.user) return `${jid.split(':')[0].split('@')[0]}@s.whatsapp.net`;
    let user = decoded.user;
    let server = decoded.server === 'c.us' ? 's.whatsapp.net' : decoded.server;
    if (server === 'lid' || server === 'hosted.lid') {
      const pn = getLidMappingValue(user, 'lidToPn');
      if (pn) { user = pn; server = server === 'hosted.lid' ? 'hosted' : 's.whatsapp.net'; }
    }
    return jidEncode(user, server === 'hosted' ? 'hosted' : 's.whatsapp.net');
  } catch {
    return jid;
  }
};

// The phone number and LID of one JID (either may be null)
const splitIdentity = (jid) => {
  if (!jid || typeof jid !== 'string') return { pn: null, lid: null };
  const user = normalizeJid(jid);
  if (!user) return { pn: null, lid: null };
  const server = jid.includes('@') ? jid.split('@')[1] : 's.whatsapp.net';
  if (server === 'lid' || server === 'hosted.lid') {
    return { lid: user, pn: getLidMappingValue(user, 'lidToPn') };
  }
  return { pn: user, lid: getLidMappingValue(user, 'pnToLid') };
};

// Every known number for one person (or a list of JIDs for the same person)
const jidVariants = (jids) => {
  const out = new Set();
  for (const jid of [].concat(jids || [])) {
    const { pn, lid } = splitIdentity(jid);
    if (pn) out.add(String(pn));
    if (lid) out.add(String(lid));
  }
  return out;
};

// How a person is stored in the allowed list: phone number first, LID as alias
const canonicalIdentity = (jid) => {
  const { pn, lid } = splitIdentity(jid);
  const number = pn || lid;
  const alt = pn && lid ? [String(lid)] : [];
  return { number: number ? String(number) : null, alt };
};

// System JID filter — true for WhatsApp status, broadcast, and newsletter JIDs
const isSystemJid = (jid) => {
  if (!jid || typeof jid !== 'string') return true;
  return (
    jid === 'status@broadcast' ||
    jid.includes('@broadcast') ||
    jid.includes('status.broadcast') ||
    jid.includes('@newsletter')
  );
};

module.exports = {
  normalizeJid, normalizeJidWithLid, getLidMappingValue,
  splitIdentity, jidVariants, canonicalIdentity, isSystemJid,
};
