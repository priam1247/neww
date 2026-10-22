/**
 * ZaFar Bot — safe console formatting & secret redaction
 *
 * 1. The console wrappers in index.js stringify every argument to decide whether a
 *    line is noise. JSON.stringify() throws on circular references and on BigInt,
 *    and Baileys logs proto/socket objects that are full of both.
 * 2. redactSecrets() strips Bearer tokens, Pterodactyl panel keys (ptlc_/ptla_),
 *    Drime Sanctum tokens, URL query API keys, and proxy URL passwords so no
 *    log line ever prints credentials.
 */

function redactSecrets(input) {
  let s = String(input ?? '');
  if (!s) return s;
  // Authorization: Bearer <token>
  s = s.replace(/\b(Bearer\s+)[A-Za-z0-9._~+|/-]{8,}/gi, '$1[REDACTED]');
  // Pterodactyl & Hydrodactyl client / application keys (ptlc_, ptla_, hydro_)
  s = s.replace(/\b(ptl[ca]_|hydro_)[A-Za-z0-9]{6,}/g, '$1[REDACTED]');
  // Sanctum / Drime tokens like 58989|qn4Jom8Cnusc...
  s = s.replace(/\b\d+\|[A-Za-z0-9]{24,}\b/g, '[REDACTED_TOKEN]');
  // URL user:password@host credentials (proxies, SFTP, etc.)
  s = s.replace(/\b((?:https?|socks5h?|sftp):\/\/[^:/@\s]+):([^@\s]+)@/gi, '$1:***@');
  // Query-string or key=value API keys (?api_key=..., &apikey=..., token=...)
  s = s.replace(/((?:[?&]|\b)(?:api_?key|access_token|token)=)[^&\s"']+/gi, '$1[REDACTED]');
  return s;
}

function maskUrlCredentials(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  return redactSecrets(raw);
}

function safeText(value) {
  if (typeof value === 'string') return redactSecrets(value);
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return redactSecrets(`${value.name}: ${value.message}`);
  try {
    const seen = new WeakSet();
    const json = JSON.stringify(value, (key, val) => {
      if (typeof key === 'string' && /^(authorization|api_?key|apitoken|token|password|secret|cookie|cookies)$/i.test(key) && val) {
        return '[REDACTED]';
      }
      if (typeof val === 'bigint') return val.toString();
      if (typeof val === 'function') return '[Function]';
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    });
    return redactSecrets(json || String(value));
  } catch {
    try { return Object.prototype.toString.call(value); } catch { return '[unprintable]'; }
  }
}

function redactArg(arg) {
  if (typeof arg === 'string') return redactSecrets(arg);
  if (arg instanceof Error) {
    const msg = redactSecrets(arg.message || '');
    if (msg !== arg.message) {
      const clean = new Error(msg);
      clean.name = arg.name;
      if (arg.code) clean.code = arg.code;
      return clean;
    }
    return arg;
  }
  return arg;
}

/** All arguments flattened into one lowercase string (used for noise filtering). */
const formatArgs = (args) => (Array.isArray(args) ? args : [args]).map(safeText).join(' ').toLowerCase();

module.exports = { safeText, formatArgs, redactSecrets, redactArg, maskUrlCredentials };
