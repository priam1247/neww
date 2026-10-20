/**
 * ZaFar Bot — safe console formatting
 *
 * The console wrappers in index.js stringify every argument to decide whether a
 * line is noise. JSON.stringify() throws on circular references and on BigInt,
 * and Baileys logs proto/socket objects that are full of both — a throw inside
 * console.log meant an uncaught TypeError inside the logger itself.
 *
 * safeText() always returns a string, whatever it is handed.
 */

function safeText(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    const seen = new WeakSet();
    return JSON.stringify(value, (key, val) => {
      if (typeof val === 'bigint') return val.toString();
      if (typeof val === 'function') return '[Function]';
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    }) || String(value);
  } catch {
    try { return Object.prototype.toString.call(value); } catch { return '[unprintable]'; }
  }
}

/** All arguments flattened into one lowercase string (used for noise filtering). */
const formatArgs = (args) => (Array.isArray(args) ? args : [args]).map(safeText).join(' ').toLowerCase();

module.exports = { safeText, formatArgs };
