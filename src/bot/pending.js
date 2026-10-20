// src/bot/pending.js — disambiguation state for movie/series title clashes.
// Historical API (setPending/getPending/clearPending keyed by chat jid) kept
// for the `.movie pick <n>` / `.series pick <n>` flow. Merged addition: bare
// number replies ("2") are resolved by the handler via tryBarePick(), so the
// old "reply with a number" UX from Zafar-bot-main works here too.
// Keyed by chat jid, auto-expires after 5 minutes.
const pending = new Map();   // jid -> { kind, matches, ctx, at }
const TTL = 5 * 60_000;

export function setPending(jid, data) {
  pending.set(jid, { ...data, at: Date.now() });
}
export function getPending(jid) {
  const p = pending.get(jid);
  if (!p) return null;
  if (Date.now() - p.at > TTL) { pending.delete(jid); return null; }
  return p;
}
export function clearPending(jid) { pending.delete(jid); }

export function renderOptions(list) {
  return list.map((x, i) => `*${i + 1}.* ${x.title} (${x.year || '?'})`).join('\n');
}

/**
 * Resolve a bare numeric reply against an open pending list.
 * @returns {string|null} a full command line to re-dispatch, e.g. "/movie pick 2"
 */
export function tryBarePick(jid, text, prefix) {
  const t = String(text || '').trim().replace(/^[.!#](\d+)/, '$1');
  const n = Number(t);
  if (!Number.isInteger(n) || n < 1 || String(n) !== t) return null;
  const p = getPending(jid);
  if (!p || !Array.isArray(p.matches) || n > p.matches.length) return null;
  clearPending(jid);
  return `${prefix}${p.kind} pick ${n}`;
}
