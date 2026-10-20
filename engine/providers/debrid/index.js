// src/providers/debrid/index.js — debrid link resolver (RealDebrid, AllDebrid).
// TorBox was removed in 3.3: its API requires a paid Pro plan, so it cannot
// ever work out of the box. The remaining debrids plug into the cascade:
// candidates from the torrent/ddl tiers are resolved through the first
// configured debrid that succeeds, with per-link caching in front.
//
// Note: the old TorBox-only "debridcache" tier 0 is gone with it —
// RealDebrid/AllDebrid links come out of the normal resolve path below,
// which is near-instant for cached torrents anyway.
import config from '../../config.js';
import cache from '../../core/cache.js';
import { metrics } from '../../core/metrics.js';
import realdebrid from './realdebrid.js';
import alldebrid from './alldebrid.js';

const ORDER = [
  ['realdebrid', () => config.realDebridKey, realdebrid],
  ['alldebrid', () => config.allDebridKey, alldebrid]
];

export const active = () => ORDER.filter(([, has]) => has());

// ── resolve a candidate through the first debrid that succeeds ─────────────
export async function resolve(cand, opts) {
  const lk = `link:${cand.hash || cand.provider}:${cand.fileIdx ?? 0}:${opts.season ?? ''}:${opts.episode ?? ''}`;
  const cachedUrl = cache.lget(lk);
  if (cachedUrl) {
    metrics.bump('cache.link');
    return { url: cachedUrl, sizeMB: cand.sizeMB, cached: true };
  }

  let lastErr;
  for (const [name, has, mod] of active()) {
    try {
      const r = await mod.resolve(cand, opts);
      if (!r.url) throw new Error('no url');
      cache.lset(lk, r.url);
      return r;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('no debrid key configured (set REALDEBRID_API_KEY or ALLDEBRID_API_KEY)');
}

export default { resolve, active };
