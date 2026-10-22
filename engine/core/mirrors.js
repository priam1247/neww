// engine/core/mirrors.js — mirror pools with health memory (zero deps).
//
// Every DDL/scraper provider owns a list of interchangeable domains. They die
// and come back constantly, and a dead first entry used to cost the provider
// the whole request (the old code looped blindly, in a fixed order).
//
// This remembers, per mirror:
//   • consecutive failures  → circuit breaker (benched for COOLDOWN ms)
//   • a rolling latency     → fast mirrors are tried first
// so after one bad round the provider goes straight to the mirror that works,
// and a benched mirror is probed again later instead of being hammered.
//
// State lives in memory only (a fresh host starts even, which is fine).

const FAILS_TO_OPEN = 3;
const COOLDOWN_MS = 90_000;
const MAX_POOLS = 200;

const pools = new Map(); // `${providerId}` -> Mirror[]

function makeMirror(url) {
  return { url, fails: 0, latency: 400, okCount: 0, openedAt: 0, lastErr: null };
}

const isOpen = (m) => m.openedAt > 0 && Date.now() - m.openedAt < COOLDOWN_MS;

const score = (m) => (isOpen(m) ? 1e6 : 0) + m.latency - m.okCount * 5;

/**
 * Get (or build) the mirror pool for a provider.
 * @param {string} id provider id, e.g. 'hdhub4u'
 * @param {string[]} urls base urls, in the provider's preferred order
 */
export function mirrorPool(id, urls) {
  let pool = pools.get(id);
  if (!pool) {
    if (pools.size >= MAX_POOLS) pools.clear();
    pool = urls.map(makeMirror);
    pools.set(id, pool);
  }
  return pool;
}

/** Mirrors to try, best first. Benched mirrors go last (they may still work). */
export function orderedMirrors(pool) {
  return [...pool].sort((a, b) => score(a) - score(b));
}

export function mirrorOk(mirror, ms) {
  mirror.okCount += 1;
  mirror.fails = 0;
  mirror.openedAt = 0;
  mirror.latency = Math.round(mirror.latency * 0.7 + Math.max(0, ms) * 0.3);
}

export function mirrorFail(mirror, err) {
  mirror.fails += 1;
  mirror.lastErr = err ? String(err.message || err).slice(0, 120) : 'unknown';
  if (mirror.fails >= FAILS_TO_OPEN) mirror.openedAt = Date.now();
}

/** Compact health snapshot (used by .moviestatus and the logs). */
export function mirrorReport() {
  return [...pools.entries()].map(([id, pool]) => ({
    provider: id,
    mirrors: pool.map(m => ({
      url: m.url,
      state: isOpen(m) ? 'open' : 'closed',
      fails: m.fails,
      latencyMs: m.latency,
      lastErr: m.lastErr,
    })),
  }));
}

/**
 * Run `fn(baseUrl)` against each mirror until one returns something truthy.
 * Never throws on a single dead mirror; throws only when all of them fail.
 *
 * @template T
 * @param {string} id provider id
 * @param {string[]} urls mirror bases
 * @param {(base:string)=>Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withMirrors(id, urls, fn) {
  const pool = mirrorPool(id, urls);
  let lastErr;

  for (const mirror of orderedMirrors(pool)) {
    const t0 = Date.now();
    try {
      const out = await fn(mirror.url);
      const empty = !out || (Array.isArray(out) && out.length === 0);
      if (empty) {
        // reachable but useless — do not bench it, just move on
        mirrorOk(mirror, Date.now() - t0);
        continue;
      }
      mirrorOk(mirror, Date.now() - t0);
      return out;
    } catch (e) {
      lastErr = e;
      mirrorFail(mirror, e);
    }
  }

  throw lastErr || new Error(`${id}: every mirror is unreachable`);
}
