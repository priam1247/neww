// src/bot/selections.js — merged from Zafar-bot-main: "reply with a number"
// pickers. When a command offers a numbered list, the answer arrives as a
// bare message ("2") which is NOT a command — the handler consults this
// module before command parsing. Entries are keyed by chat + sender (nobody
// can steal another person's pick), expire after a TTL, and carry the
// callback that continues the original command with the chosen item.
export const DEFAULT_TTL_MS = 5 * 60_000;

const pending = new Map();   // `${chatId}:${sender||'*'}` -> entry

const keyOf = (chatId, sender) => `${chatId}:${sender || '*'}`;

const prune = () => {
  const now = Date.now();
  for (const [k, e] of pending) if (now - e.at > e.ttlMs) pending.delete(k);
};

/**
 * Register a numbered choice.
 * @param {{chatId:string, sender?:string, items:any[], run:Function, ttlMs?:number, label?:string}} opts
 *        run(ctx, item, index) continues the command.
 * @returns {string} the map key (useful for tests)
 */
export function offer({ chatId, sender, items, run, ttlMs = DEFAULT_TTL_MS, label = '' }) {
  if (!Array.isArray(items) || !items.length) throw new Error('offer() needs items');
  if (typeof run !== 'function') throw new Error('offer() needs a run callback');
  prune();
  const k = keyOf(chatId, sender);
  pending.set(k, { at: Date.now(), ttlMs, items, run, label });
  return k;
}

/** "3" | ".3" | "#3" | "3." | "3)" → 3 */
const CHOICE_RE = /^([.!#]?)(\d{1,2})[.)]?$/;

export const parseChoice = (text) => {
  const m = String(text || '').trim().match(CHOICE_RE);
  if (!m) return null;
  const n = Number(m[2]);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export const isCancel = (text) =>
  /^(cancel|stop|no|nevermind|never mind)$/i.test(String(text || '').trim());

export const peek = (chatId, sender) => {
  const e = pending.get(keyOf(chatId, sender));
  if (!e) return null;
  if (Date.now() - e.at > e.ttlMs) { pending.delete(keyOf(chatId, sender)); return null; }
  return e;
};

/** Resolve a bare message against a pending choice → {entry,item,index}|null */
export function match(chatId, sender, text) {
  const e = peek(chatId, sender);
  if (!e) return null;
  const n = parseChoice(text);
  if (n === null || n > e.items.length) return null;
  pending.delete(keyOf(chatId, sender));
  return { entry: e, item: e.items[n - 1], index: n - 1 };
}

/** Drop a pending choice ("cancel", or the command finished another way). */
export function clear(chatId, sender) {
  return pending.delete(keyOf(chatId, sender));
}

/** True when a number out of range was sent (so we can explain it). */
export function isOutOfRange(chatId, sender, text) {
  const e = peek(chatId, sender);
  if (!e) return false;
  const n = parseChoice(text);
  return n !== null && n > e.items.length;
}

export const size = () => { prune(); return pending.size; };

/** test hook */
export const _clearAll = () => pending.clear();
