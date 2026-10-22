/**
 * ZaFar Bot — Safe User-Facing Error Messages
 *
 * Raw `err.message` strings frequently contain stack traces, local file paths,
 * HTTP status dumps, database diagnostics, API endpoints, or internal queue /
 * disk reservation counters. None of those belong in a WhatsApp chat.
 *
 * Log the full diagnostic to `console.error` / `log.error` on the server, and
 * pass `safeErrorMessage(err, { fallback })` to chat replies.
 */

const config = require('../config');

const INTERNAL_PATTERNS = [
  /\/home\/|\/tmp\/|\/var\/|\/usr\/|\/root\/|[A-Z]:\\/i,       // filesystem paths
  /\b(ENOENT|EACCES|EPERM|ENOSPC|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|ERR_[A-Z0-9_]+)\b/,
  /\b(TypeError|ReferenceError|SyntaxError|RangeError|AssertionError|AxiosError)\b/,
  /\b(SQLITE|D1_ERROR|JSON\.parse|Unexpected token|at Object\.|at async)\b/i,
  /\b(HTTP\s*[45]\d\d|status code \d{3}|Drime API \d{3})\b/i,
  /\b(Bearer\s+\S+|apikey=|api_key=|token=)\b/i,
  /\breserved by \d+ running job/i,
];

/**
 * Convert any thrown error into a short, clean, non-leaking WhatsApp message.
 * Known user-safe error codes get specific plain-English explanations; unknown
 * or internal errors return `fallback` instead of raw `err.message`.
 *
 * @param {any} err
 * @param {{ fallback?: string, isOwner?: boolean }} [opts]
 * @returns {string}
 */
function safeErrorMessage(err, { fallback = null, isOwner = false } = {}) {
  const defaultMsg = fallback || config.messages?.error || '❌ Something went wrong. Please try again.';
  if (!err) return defaultMsg;

  const code = String(err.code || '').toUpperCase();
  const raw = String(err.message || '').split('\n')[0].trim();

  if (code === 'NOT_ENOUGH_DISK' || /not enough disk/i.test(raw)) {
    return isOwner && raw
      ? `❌ Server storage is currently busy (${raw}). Try again shortly.`
      : '❌ Server storage is temporarily full while other downloads finish. Please try again in a few minutes.';
  }

  if (code === 'QUEUE_TIMEOUT' || /timed out|deadline/i.test(raw)) {
    return '❌ The request took too long and timed out. Please try again.';
  }

  if (code === 'TOO_BIG' || /larger than|exceeds.*limit|over the .* cap/i.test(raw)) {
    return '❌ That file is larger than the maximum size this bot can send.';
  }

  if (code === 'NO_FFMPEG' || /ffmpeg/i.test(raw)) {
    return '❌ Media conversion is temporarily unavailable on this server.';
  }

  // Explicitly marked user-safe message (e.g. `err.userMessage`)
  if (typeof err.userMessage === 'string' && err.userMessage.trim()) {
    return err.userMessage.trim();
  }

  // Never forward raw internal details to WhatsApp chat
  if (!raw || INTERNAL_PATTERNS.some((re) => re.test(raw))) {
    return defaultMsg;
  }

  return defaultMsg;
}

module.exports = {
  safeErrorMessage,
  INTERNAL_PATTERNS,
};
