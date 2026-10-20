// src/core/resolver.js — the tiered cascade. Fixed + instrumented:
//  • tier 0 (TorBox debridcache) retired in 3.3 — TorBox needs a Pro plan;
//    debrid links resolve through providers/debrid in the normal cascade
//  • searches memoized
//  • every outcome recorded in metrics + event bus
import config from '../config.js';
import { liveProviders, recordStart, recordWin, recordFail } from './registry.js';
import { rank } from './ranker.js';
import { verify } from './verify.js';
import { hedge } from './http.js';
import cache from './cache.js';
import debrid from '../providers/debrid/index.js';
import { metrics } from './metrics.js';
import { emit, EVENTS } from './events.js';
import { log } from './log.js';

const rlog = log.child('resolver');
const TIERS = [[0], [1], [2], [3]];

async function searchTier(tier, media, opts) {
  const live = liveProviders({ tier, type: media.type });
  if (!live.length) return [];

  const t0 = Date.now();
  const results = await hedge(
    live.map(p =>
      (async () => {
        recordStart(p.id);
        const started = Date.now();
        try {
          const c = await p.search(media, opts);
          recordWin(p.id, Date.now() - started);
          metrics.time(`lat.${p.id}`, Date.now() - started);
          return c;
        } catch (e) {
          recordFail(p.id, e);
          return [];
        }
      })()
    ),
    tier[0] === 0 ? config.tier0TimeoutMs : config.tierTimeoutMs
  );

  const cands = results.flat();
  metrics.bump('search.ok');
  if (!cands.length) metrics.bump('search.empty');
  metrics.time(`tier.${tier[0]}`, Date.now() - t0);
  emit(EVENTS.TIER_DONE, { tier: tier[0], candidates: cands.length, ms: Date.now() - t0 });
  return cands;
}

async function resolve(media, opts = {}) {
  const cacheKey = cache.keyOf(media.imdbId || media.tmdbId, opts.season, opts.episode, opts.quality);

  // negative cache: don't re-hammer a known-missing thing for 30 min
  if (cache.nget(cacheKey)) {
    rlog.debug(`negative-cached: ${cacheKey}`);
    metrics.bump('cache.neg');
  }

  try {
    for (const tier of TIERS) {
      let raw = await searchTier(tier, media, opts);
      if (!raw.length) continue;

      if (tier[0] === 0) {
        // tier 0 arrives pre-resolved from the debrid cache probe
        raw = raw.filter(c => c.url);
      } else {
        raw = rank(raw, opts).slice(0, 6);
      }
      if (!raw.length) continue;

      for (const cand of raw) {
        try {
          const resolved = cand.url ? cand : await debrid.resolve(cand, opts);
          const out = await verify(resolved, opts);
          cache.lset(`${cand.hash || cand.provider}:${cand.fileIdx ?? 0}`, out.url);
          metrics.bump(`tier.${tier[0]}`);
          metrics.bump('resolve.ok');
          rlog.info(`✅ ${media.type} via ${cand.provider} (tier ${tier[0]}) ${(out.sizeMB || 0).toFixed(0)}MB`);
          emit(EVENTS.RESOLVED, { provider: cand.provider, tier: tier[0], sizeMB: out.sizeMB, title: cand.title });
          return {
            ...out,
            kind: cand.kind || 'file',
            provider: cand.provider, tier: tier[0],
            title: cand.title, quality: cand.quality || opts.quality
          };
        } catch (e) {
          metrics.bump('resolve.candFail');
          emit(EVENTS.CANDIDATE_REJECTED, { provider: cand.provider, reason: e.message });
          rlog.debug(`↩️ ${cand.provider} rejected: ${e.message}`);
        }
      }
    }

    cache.nset(cacheKey);
    throw new Error('no source produced a usable file');
  } catch (e) {
    if (!/no source produced/.test(e.message)) throw e;
    metrics.bump('resolve.fail');
    emit(EVENTS.RESOLVE_FAIL, { media: media.title, error: e.message });
    throw e;
  }
}

export { resolve, searchTier };
export default { resolve, searchTier };
