// src/core/log.js — leveled, timestamped, single-line logger (zero deps).
const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };
const envLevel = (process.env.LOG_LEVEL || '').toLowerCase();
let threshold = LEVELS[envLevel] ?? LEVELS[process.env.QUIET ? 'warn' : 'info'];

const fmt = (v) => {
  if (v instanceof Error) return v.stack || v.message;
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
};
const line = (lvl, tag, parts) => {
  const ts = new Date().toISOString().slice(11, 23);
  return `${ts} ${lvl.padEnd(5)} [${tag}] ${parts.map(fmt).join(' ')}`;
};

export const log = {
  setLevel(name) { if (LEVELS[name]) threshold = LEVELS[name]; },
  child(tag) {
    const emit = (lvl) => (...parts) => {
      if (LEVELS[lvl] < threshold) return;
      const out = line(lvl, tag, parts);
      (LEVELS[lvl] >= 40 ? console.error : console.log)(out);
    };
    return { trace: emit('trace'), debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
  }
};
export default log;
