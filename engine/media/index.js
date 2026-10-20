// engine/media/index.js — high-level resolve API used by the bot commands.
//
// Titles/metadata now come from the multi-source layer (metadata/index.js):
// TMDB first, then Cinemeta / IMDb / TVMaze / OMDb / Trakt / Jikan / AniList.
// A TMDB outage (or a missing key) no longer means "movies don't work".
//
// Fixes carried over + new:
//   • caller may pass tmdbId OR imdbId OR a raw title; we normalise to an id
//   • cache keys fall back to tmdbId when TMDB has no imdb id (the old code
//     wrote the literal string "null:" for those and served the wrong film)
//   • quality ladder: 1080 → 720 → 480 (or upward) instead of a hard failure
//   • anime titles route through the anime sources and get `anime: true`, which
//     the ranker/nyaa provider use for absolute episode numbering
import path from 'node:path';
import config from '../config.js';
import cache from '../core/cache.js';
import resolver from '../core/resolver.js';
import debrid from '../providers/debrid/index.js';
import registry from '../core/registry.js';
import queue from '../core/queue.js';
import { isOld } from '../core/ranker.js';
import { metrics } from '../core/metrics.js';
import metadata from '../metadata/index.js';
import * as tmdb from '../metadata/tmdb.js';
import * as tv from '../core/tv.js';
import { parseRelease, matchesEpisode } from '../core/release.js';
import { pickEpisodeFile, episodeQuery, seasonQuery } from '../core/tv.js';
import { sanitize } from './download.js';
import { log } from '../core/log.js';
import { mirrorReport } from '../core/mirrors.js';

const mlog = log.child('media');

// provider registration (idempotent)
import '../providers/torrent/knaben.js';
import '../providers/torrent/torrentio.js';
import '../providers/torrent/yts.js';
import '../providers/torrent/eztv.js';
import '../providers/torrent/nyaa.js';
import '../providers/torrent/apibay.js';
import '../providers/torrent/solidtorrents.js';
import '../providers/ddl/hdhub4u.js';
import '../providers/ddl/fourkhdhub.js';
import '../providers/ddl/moviesdrive.js';
import '../providers/stream/vidlink.js';
import '../providers/stream/vixsrc.js';
import '../providers/stream/vaplayer.js';
import '../providers/stream/vidsrc.js';
import '../providers/stream/videasy.js';

let booted = false;
async function boot() {
  if (booted) return;
  booted = true;
  // never install signal handlers here: the bot owns process lifecycle
  await cache.init({ installSignalHandlers: false });
}

const cacheId = (meta) => meta?.imdbId || meta?.tmdbId || meta?.malId || null;

function cachedFile(meta, quality, season, episode) {
  const id = cacheId(meta);
  if (!id) return null;
  const hit = cache.fget(cache.keyOf(id, season ?? null, episode ?? null, quality));
  if (!hit) return null;
  metrics.bump('cache.disk');
  return {
    kind: 'cache', provider: 'disk-cache', tier: 0,
    url: null, file: hit.file, sizeMB: hit.sizeMB,
    title: hit.title, quality: Number(quality), cached: true, headers: {}
  };
}

// ── title → full metadata ──────────────────────────────────────────────────
/**
 * Resolve a user's title to one metadata item with ids.
 * @param {{title?:string, year?:string, type?:'movie'|'series', tmdbId?:number, imdbId?:string}} want
 */
export async function identify({ item = null, title, year, type = 'movie', tmdbId = null, imdbId = null } = {}) {
  // the command already showed the user a list — use exactly that item.
  // When it already holds both ids nothing needs to be looked up again.
  if (item) {
    if (item.imdbId && (item.tmdbId || item.malId)) return item;
    return metadata.details(item).catch(() => item);
  }

  if (tmdbId) {
    const meta = type === 'series' ? await tmdb.tvDetails(tmdbId) : await tmdb.movieDetails(tmdbId);
    return metadata.details(meta).catch(() => meta);
  }
  if (imdbId) {
    const base = await metadata.details({ source: 'cinemeta', type, imdbId, title: title || '' })
      .catch(() => null);
    if (base) return base;
  }
  if (!title) throw new Error('no title or id given');

  const hits = await metadata.search(title, { type, year, limit: 6 });
  if (!hits.length) {
    throw new Error(`no ${type === 'series' ? 'series' : 'movie'} found for “${title}” ` +
      '(TMDB, Cinemeta, IMDb, TVMaze and the anime indexes all came back empty)');
  }

  // exact year (when given) wins, otherwise the best-ranked hit
  const best = (year && hits.find(h => String(h.year) === String(year))) || hits[0];
  return metadata.details(best);
}

// ── quality ladder ─────────────────────────────────────────────────────────
/** Neighbour qualities, best-first, starting at the requested one. */
export function qualityLadder(quality) {
  const q = Number(quality) || 720;
  if (!config.qualityFallback) return [q];
  const order = [480, 720, 1080, 2160];
  const i = order.indexOf(q);
  if (i === -1) return [q];
  const out = [q];
  // step DOWN first (smaller file, higher chance of a source), then up
  for (let d = 1; i - d >= 0; d++) out.push(order[i - d]);
  for (let d = 1; i + d < order.length; d++) out.push(order[i + d]);
  return [...new Set(out)];
}

async function resolveWithLadder(media, wantQuality, buildOpts, meta, season, episode) {
  // NOTE: the ladder start must come from the caller's requested quality — it
  // used to be read off `buildOpts` (a function), so every request silently
  // started at 720p and a 1080p/4K request was downgraded without saying so.
  const want = Number(wantQuality) || 720;
  const ladder = qualityLadder(want);
  const failures = [];

  for (const q of ladder) {
    try {
      const opts = buildOpts(q);
      const res = await resolver.resolve(media, opts);
      return { ...res, meta, season, episode, quality: q, requestedQuality: want, downgraded: q !== want };
    } catch (e) {
      failures.push(`${q}p: ${e.message}`);
      if (e.fatal) break;                 // e.g. "no provider registered" — quality won't help
    }
  }

  const err = new Error(
    ladder.length > 1 && failures.length > 1
      ? `no source for ${ladder.join('/')}p\n${failures.slice(0, 3).map(f => `• ${f}`).join('\n')}`
      : failures[0] || 'no source found'
  );
  throw err;
}

// ── MOVIE ──────────────────────────────────────────────────────────────────
export async function resolveMovie({ title, year, quality = 720, tmdbId = null, imdbId = null, item = null, exclude = null }) {
  await boot();

  const meta = await identify({ item, title, year, type: 'movie', tmdbId, imdbId });

  const hit = cachedFile(meta, quality, null, null);
  if (hit) return { ...hit, meta };

  const media = { ...meta, type: 'movie' };
  const res = await resolveWithLadder(media, quality, (q) => ({
    quality: q, want: q, year: meta.year,
    query: `${meta.title} ${meta.year || ''} ${q}p`.trim(),
    old: isOld(meta.year),
    anime: metadata.looksAnime(meta),
    maxMB: config.maxDownloadMB,
    exclude
  }), meta, null, null);

  return { ...res, meta };
}

// ── SERIES EPISODE ─────────────────────────────────────────────────────────
export async function resolveEpisode({ title, year, season, episode, quality = 720, tmdbId = null, imdbId = null, item = null, exclude = null }) {
  await boot();

  const meta = await identify({ item, title, year, type: 'series', tmdbId, imdbId });

  const hit = cachedFile(meta, quality, season, episode);
  if (hit) return { ...hit, meta, season, episode };

  const media = { ...meta, type: 'series' };
  const anime = metadata.looksAnime(meta);
  const res = await resolveWithLadder(media, quality, (q) => ({
    quality: q, want: q, year: meta.year,
    season, episode, wantSingleEpisode: true,
    query: episodeQuery(meta.title, meta.year, season, episode),
    pickEpisode: (files) => pickEpisodeFile(files, season, episode),
    old: isOld(meta.year),
    anime,
    maxMB: config.maxDownloadMB,
    exclude
  }), meta, season, episode);

  return { ...res, meta, season, episode };
}

// ── SERIES SEASON (packs) ──────────────────────────────────────────────────
export async function resolveSeason({ title, year, season, quality = 720, tmdbId = null, imdbId = null, item = null, exclude = null }) {
  await boot();

  const meta = await identify({ item, title, year, type: 'series', tmdbId, imdbId });
  const media = { ...meta, type: 'series' };

  const res = await resolveWithLadder(media, quality, (q) => ({
    quality: q, want: q, year: meta.year,
    season, episode: null, wantSingleEpisode: false,
    query: seasonQuery(meta.title, meta.year, season),
    old: isOld(meta.year),
    anime: metadata.looksAnime(meta),
    maxMB: 1e9,
    exclude
  }), meta, season, null);

  return { ...res, meta, season };
}

// ── file paths + cache bookkeeping ─────────────────────────────────────────
export function targetFile(title, year, quality, season = null, episode = null) {
  return path.join(config.tempDir, sanitize(`${title}.${year || ''}`, quality, season, episode));
}

/** write a finished download into the LRU index */
export function rememberFile(meta, quality, season, episode, file, sizeMB) {
  const id = cacheId(meta);
  if (!id) return false;
  cache.fset(cache.keyOf(id, season ?? null, episode ?? null, quality), {
    file, sizeMB, quality: Number(quality),
    title: `${meta.title}${season != null ? ` S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}` : ''}`
  });
  return true;
}

export { boot, cache, config, tv, parseRelease, matchesEpisode, tmdb, metadata, debrid, resolver, registry, queue, mlog, mirrorReport };
export default {
  boot, identify, resolveMovie, resolveEpisode, resolveSeason,
  targetFile, rememberFile, qualityLadder,
  cache, config, tmdb, metadata, resolver, debrid, registry, queue, mirrorReport
};
