/**
 * Engine logger (ESM) — same shape as utils/logger.js so the panel log has one
 * visual language:
 *
 *   22:49:41.798  INFO   registry  registered provider: vidlink (tier 2)
 *   22:49:44.221  WARN   registry  hdhub4u tripped — open 30s (fetch failed)
 *
 * Levels: debug 20 < info 30 < warn 40 < error 50. LOG_LEVEL=debug for detail.
 * Every record is forced onto ONE line: long multi-line errors used to flood
 * the Pterodactyl console.
 */

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50 };
const levelName = String(process.env.LOG_LEVEL || (process.env.QUIET ? 'warn' : 'info')).toLowerCase();
let threshold = LEVELS[levelName] || LEVELS.info;

const COLORS = process.stdout.isTTY && !process.env.NO_COLOR
  ? { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m', dim: '\x1b[2m', reset: '\x1b[0m' }
  : { debug: '', info: '', warn: '', error: '', dim: '', reset: '' };

const stamp = () => {
  const d = new Date();
  return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`;
};

const render = (v) => {
  if (v instanceof Error) return v.message;
  if (typeof v === 'object' && v !== null) {
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
};

const oneLine = (s) => String(s).replace(/\s*\n\s*/g, ' ⏎ ').slice(0, 500);

function emit(level, tag, parts) {
  if (LEVELS[level] < threshold) return;
  const out =
    `${COLORS.dim}${stamp()}${COLORS.reset}  ` +
    `${COLORS[level]}${level.toUpperCase().padEnd(5)}${COLORS.reset}  ` +
    `${String(tag).padEnd(9)} ` +
    oneLine(parts.map(render).join(' '));
  (LEVELS[level] >= 40 ? console.error : console.log)(out);
}

export const log = {
  setLevel(name) { if (LEVELS[name]) threshold = LEVELS[name]; },
  child(tag) {
    return {
      debug: (...a) => emit('debug', tag, a),
      info: (...a) => emit('info', tag, a),
      warn: (...a) => emit('warn', tag, a),
      error: (...a) => emit('error', tag, a),
    };
  },
};

export default log;
