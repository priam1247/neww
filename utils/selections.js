/**
 * ZaFar Bot — pending choices ("reply with a number")
 *
 * When a command offers a numbered list (.song / .ytv search results), the
 * answer arrives as a *bare* message ("2"), which is not a command and has no
 * prefix — so it has to be caught by the handler before command parsing.
 *
 * Entries are keyed by chat + sender (so nobody can steal another person's
 * pick), expire after a few minutes, and carry the callback that continues the
 * original command with the chosen item.
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000;

const pending = new Map(); // `${chatId}:${sender}` -> entry

const keyOf = (chatId, sender) => `${chatId}:${sender}`;

const prune = () => {
  const now = Date.now();
  for (const [k, entry] of pending) {
    if (now - entry.at > entry.ttlMs) pending.delete(k);
  }
};

/**
 * Register a numbered choice.
 * @param {{chatId:string, sender:string, items:any[], run:Function, ttlMs?:number, label?:string}} opts
 *        run(sock, msg, extra, item) continues the command.
 * @returns {string} the map key (useful for tests)
 */
function offer({ chatId, sender, items, run, ttlMs = DEFAULT_TTL_MS, label = '' }) {
  if (!Array.isArray(items) || !items.length || typeof run !== 'function') {
    throw new Error('offer() needs items and a run callback');
  }
  prune();
  const k = keyOf(chatId, sender);
  pending.set(k, { at: Date.now(), ttlMs, items, run, label });
  return k;
}

/** "3" | ".3" | "#3" | "3." | "3)" → 3 */
const CHOICE_RE = /^([.!#]?)(\d{1,2})[.)]?$/;

const parseChoice = (text) => {
  const m = String(text || '').trim().match(CHOICE_RE);
  if (!m) return null;
  const n = Number(m[2]);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const isCancel = (text) => /^(cancel|stop|no|nevermind|never mind)$/i.test(String(text || '').trim());

const peek = (chatId, sender) => {
  const entry = pending.get(keyOf(chatId, sender));
  if (!entry) return null;
  if (Date.now() - entry.at > entry.ttlMs) { pending.delete(keyOf(chatId, sender)); return null; }
  return entry;
};

/**
 * Resolve an incoming message against a pending choice.
 * @returns {{entry:object,item:any,index:number}|null}
 */
function match(chatId, sender, text) {
  const entry = peek(chatId, sender);
  if (!entry) return null;
  const n = parseChoice(text);
  if (n === null || n > entry.items.length) return null;
  pending.delete(keyOf(chatId, sender));
  return { entry, item: entry.items[n - 1], index: n - 1 };
}

/** Drop a pending choice (used by "cancel" and by commands that finished). */
function clear(chatId, sender) {
  const k = keyOf(chatId, sender);
  const had = pending.has(k);
  pending.delete(k);
  return had;
}

/** True when a number out of range was sent (so we can explain it). */
function isOutOfRange(chatId, sender, text) {
  const entry = peek(chatId, sender);
  if (!entry) return false;
  const n = parseChoice(text);
  return n !== null && n > entry.items.length;
}

const size = () => pending.size;

module.exports = { offer, match, peek, clear, parseChoice, isCancel, isOutOfRange, size, DEFAULT_TTL_MS };
