// src/core/memo.js — short-TTL memoization of provider searches.
// Tier 0 harvests hashes via the same searches tier 1 needs; memoizing makes
// the tier-1 pass reuse those results at zero cost (and speeds user retries).
import config from '../config.js';
import cache from './cache.js';

const inflight = new Map();    // key -> Promise

const memoKey = (p, media, opts) =>
  `memo:${p.id}:${media.type}:${media.tmdbId || media.imdbId || media.title}:${opts.season ?? ''}:${opts.episode ?? ''}:${opts.query || ''}`;

export async function searchMemo(provider, media, opts) {
  const k = memoKey(provider, media, opts);
  const hit = cache.mget(k);
  if (hit) return hit;

  const pend = inflight.get(k);
  if (pend) return pend;

  const job = (async () => {
    try {
      const out = await provider.search(media, opts);
      cache.mset(k, out, config.searchMemoTTLms / 3600e3);
      return out;
    } finally {
      inflight.delete(k);
    }
  })();
  inflight.set(k, job);
  return job;
}

export default { searchMemo };
