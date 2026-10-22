// src/core/registry.js — provider base + health with a REAL circuit breaker.
// 2.0 had a crude backoff map. 3.0 implements closed → open → half-open with
// probe requests, plus trust scoring that feeds the ranker.
import { log } from './log.js';
import { emit, EVENTS } from './events.js';
import { metrics } from './metrics.js';

const rlog = log.child('registry');

const FAIL_THRESHOLD = 3;          // consecutive fails to trip
const OPEN_BASE_MS = 30_000;       // first open window
const OPEN_MAX_MS = 30 * 60_000;   // ceiling
const PROBE_LIMIT = 2;             // half-open concurrent probes

export class Provider {
  constructor({ id, tier, kinds, supports = ['movie', 'series'], trust = 1, label = '' }) {
    Object.assign(this, { id, tier, kinds, supports, trust, label: label || id });
  }
  async search(media, opts) { return []; }
  async resolve(cand, opts) { return { url: cand.url, sizeMB: cand.sizeMB, filename: cand.title }; }
}

const providers = [];
const health = new Map();

function register(p) {
  const existing = providers.find(x => x.id === p.id);
  if (existing) return existing;                         // idempotent (hot reload safe)
  providers.push(p);
  health.set(p.id, {
    fails: 0, wins: 0, total: 0,
    state: 'closed',            // closed | open | half-open
    openUntil: 0,
    probes: 0,
    lastErr: null,
    lastOk: 0,
    emaMs: 0                    // exponential moving average latency
  });
  rlog.debug(`registered ${p.id} · tier ${p.tier}`);
  return p;
}

const isLive = (id) => {
  const h = health.get(id);
  if (!h) return false;
  if (h.state === 'closed') return true;
  if (h.state === 'open') return Date.now() >= h.openUntil;
  return h.probes < PROBE_LIMIT;      // half-open: allow limited probes
};

function canProbe(id) {
  const h = health.get(id);
  return h && h.state !== 'closed' && h.probes < PROBE_LIMIT;
}

function recordStart(id) {
  const h = health.get(id);
  if (h && h.state !== 'closed') h.probes++;
}

function recordWin(id, ms) {
  const h = health.get(id); if (!h) return;
  h.wins++; h.total++; h.fails = 0; h.lastOk = Date.now();
  h.emaMs = h.emaMs ? h.emaMs * 0.8 + ms * 0.2 : ms;
  if (h.state !== 'closed') rlog.info(`${id} recovered · breaker closed`);
  h.state = 'closed'; h.probes = 0; h.openUntil = 0;
  metrics.bump('provider.win', { provider: id });
}

function recordFail(id, err) {
  const h = health.get(id); if (!h) return;
  h.total++; h.fails++; h.lastErr = err?.message || String(err);
  metrics.bump('provider.fail', { provider: id });
  if (h.state !== 'closed') {
    // already tripped — escalate the window, capped at OPEN_MAX_MS
    h.state = 'open';
    h.openUntil = Date.now() + Math.min(OPEN_MAX_MS, OPEN_BASE_MS * 2 ** Math.min(6, Math.max(0, h.fails - FAIL_THRESHOLD)));
    return;
  }
  if (h.fails >= FAIL_THRESHOLD) {
    const backoff = Math.min(OPEN_MAX_MS, OPEN_BASE_MS * 2 ** Math.max(0, h.fails - FAIL_THRESHOLD));
    h.state = 'open';
    h.openUntil = Date.now() + backoff;
    rlog.warn(`${id} tripped · open ${Math.round(backoff / 1000)}s · ${h.lastErr}`);
    emit(EVENTS.CANDIDATE_REJECTED, { provider: id, reason: 'breaker tripped', error: h.lastErr });
  }
}

// half-open transition when the open window elapses
function markHalfOpen(id) {
  const h = health.get(id);
  if (h && h.state === 'open' && Date.now() >= h.openUntil) { h.state = 'half-open'; h.probes = 0; }
}

// auto-tuned trust: providers whose results survive verification get promoted
function trustOf(id) {
  const h = health.get(id);
  if (!h || h.total < 5) return 1;
  return Math.max(0.5, Math.min(1.6, 0.5 + (h.wins / h.total) * 1.1));
}

function liveProviders({ tier, type }) {
  for (const p of providers) markHalfOpen(p.id);
  return providers.filter(p =>
    (!tier || (Array.isArray(tier) ? tier.includes(p.tier) : p.tier === tier)) &&
    p.supports.includes(type) &&
    isLive(p.id)
  );
}

function table() {
  return providers.map(p => {
    const h = health.get(p.id) || {};
    return {
      id: p.id, tier: p.tier, kind: p.kinds[0],
      wins: h.wins || 0, fails: h.fails || 0,
      trust: trustOf(p.id).toFixed(2),
      latency: h.emaMs ? `${Math.round(h.emaMs)}ms` : '-',
      state: !h ? 'idle' : h.state === 'closed' ? 'live' : h.state === 'open' ? `open ${Math.max(0, Math.round((h.openUntil - Date.now()) / 1000))}s` : h.state,
      lastErr: h.lastErr || null
    };
  });
}

export const get = (id) => providers.find(p => p.id === id);

export default { Provider, register, get, isLive, recordStart, recordWin, recordFail, trustOf, liveProviders, table, providers, canProbe };
export { register, isLive, recordStart, recordWin, recordFail, trustOf, liveProviders, table, providers, canProbe };
