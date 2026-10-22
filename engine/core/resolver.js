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
// torrents (debrid, instant when cached) → streams (keyless, host-independent)
// → DDL (scraped hosts that keep dying). Streams used to sit last, so a dead
// DDL tier cost ~15s on every single request before the working tier was tried.
const TIERS = [[1], [3], [2]];
const MAX_PER_TIER = 6;

// Not every source deserves the same patience:
//   tier 1 debrid → two candidates, 40s each (a cached torrent answers fast)
//   tier 3 stream → the whole tier is already capped by the hedge deadline
const TIER_LIMITS = {
  1: { candidates: 2, perCandidateMs: 40_000 },
  2: { candidates: 4, perCandidateMs: 25_000 },
  3: { candidates: 6, perCandidateMs: 30_000 },
};

const withDeadline = (promise, ms, label) => {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out`), { code: 'DEADLINE' })), ms);
    timer.unref?.();
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
};

// ── stale-on-error cache ───────────────────────────────────────────────────
// A tier that answered five minutes ago is still better than "no source" when
// every mirror is having a bad minute. Fresh for 15 min, reusable for 6 h.
const FRESH_MS = 15 * 60_000;
const STALE_MS = 6 * 60 * 60_000;
const tierCache = new Map();            // key -> { value, freshUntil, staleUntil }

const tierKey = (tier, media, opts) =>
  `${tier}|${media.type}|${media.imdbId || media.tmdbId || media.title}|` +
  `${opts.season ?? ''}|${opts.episode ?? ''}|${opts.want ?? ''}`;

function tierCacheGet(key) {
  const hit = tierCache.get(key);
  if (!hit) return { state: 'miss' };
  const now = Date.now();
  if (now < hit.freshUntil) return { state: 'fresh', value: hit.value };
  if (now < hit.staleUntil) return { state: 'stale', value: hit.value };
  tierCache.delete(key);
  return { state: 'miss' };
}

function tierCacheSet(key, value) {
  if (!value?.length) return;
  if (tierCache.size > 300) tierCache.clear();
  const now = Date.now();
  tierCache.set(key, { value, freshUntil: now + FRESH_MS, staleUntil: now + STALE_MS });
}

async function searchTier(tier, media, opts) {
  const skip = new Set(opts.exclude || []);
  const live = liveProviders({ tier: tier[0], type: media.type }).filter(p => !skip.has(p.id));
  if (!live.length) {
    // every provider is benched — a cached answer still beats a refusal
    const cached = tierCacheGet(tierKey(tier[0], media, opts));
    return cached.state === 'miss' ? [] : cached.value;
  }

  const t0 = Date.now();
  // Stream providers do 2–3 chained HTTP calls (token → api → manifest), so the
  // generic 15s tier deadline cut them off before they could answer.
  const deadline = tier[0] === 3 ? Math.max(config.tierTimeoutMs, 25_000) : config.tierTimeoutMs;
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
          rlog.debug(`${p.id} search failed · ${e.code || 'ERROR'} · ${e.message}`);
          return [];
        }
      })()
    ),
    deadline
  );

  const cands = results.flat().filter(Boolean);
  const ck = tierKey(tier[0], media, opts);
  if (cands.length) tierCacheSet(ck, cands);
  else {
    const cached = tierCacheGet(ck);
    if (cached.state === 'stale') {
      metrics.bump('search.stale');
      rlog.info(`tier ${tier[0]}: live sources empty — reusing cached results`);
      return cached.value;
    }
  }
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
  // A stream URL that failed *verification* (CDN refused a HEAD/range probe)
  // is still worth one download attempt: verification is a guess, the transfer
  // is the truth. Kept aside so a normal verified source always wins.
  let lastResort = null;

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

    const limits = TIER_LIMITS[tier[0]] || { candidates: MAX_PER_TIER, perCandidateMs: 30_000 };
    const ranked = rank(raw, opts).slice(0, limits.candidates);

    for (const cand of ranked) {
      if (opts.deadline && Date.now() > opts.deadline) {
        reasons.push('time budget exceeded — stopped trying sources');
        break;
      }
      try {
        const out = await withDeadline(
          resolveCandidate(cand, opts),
          limits.perCandidateMs,
          `${cand.provider} resolve`,
        );
        cache.lset(`${cand.hash || cand.provider}:${cand.fileIdx ?? 0}:${opts.season ?? ''}:${opts.episode ?? ''}`, out.url);
        cache.ndel(cacheKey);                       // it exists after all
        metrics.bump(`tier.${tier[0]}`);
        metrics.bump('resolve.ok');
        rlog.info(`${media.type} via ${cand.provider} · tier ${tier[0]} · ${Math.round(out.sizeMB || 0)}MB`);
        emit(EVENTS.RESOLVED, { provider: cand.provider, tier: tier[0], sizeMB: out.sizeMB, title: cand.title });
        return { ...out, provider: cand.provider, tier: tier[0] };
      } catch (e) {
        if (e.configIssue) configIssue = true;
        if (tier[0] === 3 && !lastResort && /^https?:/i.test(cand.url || '')) {
          lastResort = cand;
        }
        reasons.push(`${cand.provider}: ${e.message}`);
        metrics.bump('resolve.candFail');
        emit(EVENTS.CANDIDATE_REJECTED, { provider: cand.provider, reason: e.message });
        rlog.debug(`${cand.provider} rejected · ${e.message}`);
      }
    }
  }

  // Nothing verified — hand back the best stream link anyway rather than
  // telling the user "no source". The download is the final judge.
  if (lastResort) {
    metrics.bump('resolve.unverified');
    rlog.warn(`${media.title}: using unverified ${lastResort.provider} link`);
    return {
      url: lastResort.url,
      kind: lastResort.kind === 'hls' ? 'hls' : 'file',
      provider: lastResort.provider,
      title: lastResort.title,
      quality: lastResort.quality || opts.quality,
      sizeMB: lastResort.sizeMB || 0,
      headers: lastResort.headers || {},
      verified: false,
      unverified: true
    };
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
