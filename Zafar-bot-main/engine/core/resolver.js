// engine/core/resolver.js — the tiered cascade.
//
// Fixed in the ZaFar Bot integration:
//   • DDL candidates are now actually resolved (core/locker.js) instead of being
//     handed to Real-Debrid as if they were magnets — the whole tier 2 was dead
//   • torrent candidates are skipped (with one clear line) when no debrid key is
//     configured, instead of failing 20 candidates on the same error
//   • the final error explains WHY nothing worked (config vs. content vs. dead
//     links), so ".movie" never just says "no source"
//   • successful resolves clear the negative cache; config-only failures no
//     longer poison it for 30 minutes
//   • per-candidate headers (Referer/Cookie) survive into verification+download
import config from '../config.js';
import { liveProviders, recordStart, recordWin, recordFail } from './registry.js';
import { rank } from './ranker.js';
import { verify } from './verify.js';
import { hedge } from './http.js';
import cache from './cache.js';
import debrid from '../providers/debrid/index.js';
import { resolveLocker } from './locker.js';
import { metrics } from './metrics.js';
import { emit, EVENTS } from './events.js';
import { log } from './log.js';

const rlog = log.child('resolver');
const TIERS = [[1], [2], [3]];          // torrents → DDL → streams
const MAX_PER_TIER = 6;

async function searchTier(tier, media, opts) {
  const live = liveProviders({ tier: tier[0], type: media.type });
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
          rlog.debug(`${p.id} search failed: ${e.message}`);
          return [];
        }
      })()
    ),
    config.tierTimeoutMs
  );

  const cands = results.flat().filter(Boolean);
  metrics.bump('search.ok');
  if (!cands.length) metrics.bump('search.empty');
  metrics.time(`tier.${tier[0]}`, Date.now() - t0);
  emit(EVENTS.TIER_DONE, { tier: tier[0], candidates: cands.length, ms: Date.now() - t0 });
  rlog.debug(`tier ${tier[0]}: ${cands.length} candidate(s) from ${live.length} provider(s)`);
  return cands;
}

const isTorrent = (c) => c.kind === 'torrent' || Boolean(c.magnet);

/** Turn one ranked candidate into a verified, downloadable source. */
export async function resolveCandidate(cand, opts = {}) {
  // 1. obtain a direct link
  let direct;
  if (cand.kind === 'hls') {
    direct = { url: cand.url, kind: 'hls', headers: cand.headers, sizeMB: 0 };
  } else if (isTorrent(cand)) {
    if (!debrid.active().length) {
      throw Object.assign(new Error('torrent skipped — no debrid key configured'), { configIssue: true });
    }
    direct = await debrid.resolve(cand, opts);
    direct.kind = 'file';
  } else if (cand.needsResolve) {
    direct = await resolveLocker(cand, opts);
    direct.kind = 'file';
  } else {
    direct = { url: cand.url, kind: cand.kind || 'file', headers: cand.headers, sizeMB: cand.sizeMB };
  }

  if (!direct?.url) throw new Error('no download link');

  // 2. truth-check it (size, container, HLS manifest)
  const checked = await verify({ ...cand, ...direct }, opts);

  return {
    ...checked,
    kind: direct.kind || 'file',
    provider: cand.provider,
    title: cand.title,
    quality: cand.quality || opts.quality,
    headers: { ...(cand.headers || {}), ...(direct.headers || {}) }
  };
}

async function resolve(media, opts = {}) {
  const id = media.imdbId || media.tmdbId || media.title;
  const cacheKey = cache.keyOf(id, opts.season, opts.episode, opts.quality);

  if (cache.nget(cacheKey)) {
    rlog.debug(`negative-cached: ${cacheKey}`);
    metrics.bump('cache.neg');
  }

  const reasons = [];
  let sawCandidates = false;
  let configIssue = false;

  const noDebrid = !debrid.active().length && config.skipTorrentWithoutDebrid;

  for (const tier of TIERS) {
    // don't even hammer the indexers when their results could never be played
    if (tier[0] === 1 && noDebrid) {
      if (!reasons.includes('torrent sources skipped (no debrid key)')) {
        reasons.push('torrent sources skipped (no debrid key)');
      }
      configIssue = true;
      continue;
    }

    const raw = await searchTier(tier, media, opts);
    if (!raw.length) continue;
    sawCandidates = true;

    const ranked = rank(raw, opts).slice(0, MAX_PER_TIER);

    for (const cand of ranked) {
      try {
        const out = await resolveCandidate(cand, opts);
        cache.lset(`${cand.hash || cand.provider}:${cand.fileIdx ?? 0}:${opts.season ?? ''}:${opts.episode ?? ''}`, out.url);
        cache.ndel(cacheKey);                       // it exists after all
        metrics.bump(`tier.${tier[0]}`);
        metrics.bump('resolve.ok');
        rlog.info(`✅ ${media.type} via ${cand.provider} (tier ${tier[0]}) ${Math.round(out.sizeMB || 0)}MB`);
        emit(EVENTS.RESOLVED, { provider: cand.provider, tier: tier[0], sizeMB: out.sizeMB, title: cand.title });
        return { ...out, provider: cand.provider, tier: tier[0] };
      } catch (e) {
        if (e.configIssue) configIssue = true;
        reasons.push(`${cand.provider}: ${e.message}`);
        metrics.bump('resolve.candFail');
        emit(EVENTS.CANDIDATE_REJECTED, { provider: cand.provider, reason: e.message });
        rlog.debug(`↩️ ${cand.provider} rejected: ${e.message}`);
      }
    }
  }

  metrics.bump('resolve.fail');
  emit(EVENTS.RESOLVE_FAIL, { media: media.title });

  // Only remember a genuine "content not found"; a missing key / dead network is
  // not the movie's fault and must not block a retry in 10 minutes.
  if (sawCandidates && !configIssue) cache.nset(cacheKey);

  if (!sawCandidates) {
    if (noDebrid) {
      throw new Error([
        `no free source found for “${media.title}”.`,
        '• torrent sources need a debrid account — set REALDEBRID_API_KEY or ALLDEBRID_API_KEY',
        '• the free DDL/stream sources returned nothing — try another quality or title'
      ].join('\n'));
    }
    throw new Error(`no provider returned results for “${media.title}” (all sources unreachable or empty)`);
  }
  if (configIssue && !debrid.active().length) {
    throw new Error([
      'found sources but none could be used.',
      '• torrent results need a debrid account — set REALDEBRID_API_KEY or ALLDEBRID_API_KEY',
      '• free stream/DDL sources were unreachable right now — try again or pick another quality'
    ].join('\n'));
  }
  throw new Error(`no usable source found.\n${reasons.slice(0, 4).map(r => `• ${r}`).join('\n')}`);
}

export { resolve, searchTier };
export default { resolve, searchTier, resolveCandidate };
