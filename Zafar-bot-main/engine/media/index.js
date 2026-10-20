// engine/media/index.js — high-level resolve API used by the bot commands.
//
// Fixed in the ZaFar Bot integration:
//   • the caller may pass `tmdbId` — previously every command re-searched TMDB
//     by title and silently resolved `results[0]`, which could be a DIFFERENT
//     movie than the one the user picked from the list
//   • cache keys fall back to tmdbId when TMDB has no imdb id (the old code wrote
//     the literal string "null:" for those, making every such title share one
//     cache slot — and serve the wrong film from disk)
//   • a disk-cache hit returns a usable `{kind:'cache', file}` result
import path from 'node:path';
import config from '../config.js';
import cache from '../core/cache.js';
import resolver from '../core/resolver.js';
import debrid from '../providers/debrid/index.js';
import registry from '../core/registry.js';
import queue from '../core/queue.js';
import { isOld } from '../core/ranker.js';
import { metrics } from '../core/metrics.js';
import * as tmdb from './tmdb.js';
import * as tv from '../core/tv.js';
import { parseRelease, matchesEpisode } from '../core/release.js';
import { pickEpisodeFile, episodeQuery, seasonQuery } from '../core/tv.js';
import { sanitize } from './download.js';
import { log } from '../core/log.js';

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
import '../providers/stream/vidsrc.js';
import '../providers/stream/videasy.js';

let booted = false;
async function boot() {
  if (booted) return;
  booted = true;
  await cache.init();
}

const cacheId = (meta) => meta?.imdbId || meta?.tmdbId || null;

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

// ── MOVIE ──────────────────────────────────────────────────────────────────
export async function resolveMovie({ title, year, quality = 720, tmdbId = null }) {
  await boot();

  let meta;
  if (tmdbId) {
    meta = await tmdb.movieDetails(tmdbId);
  } else {
    const matches = await tmdb.searchMovie(title, year);
    if (!matches.length) throw new Error(`no movie found: ${title}`);
    meta = await tmdb.movieDetails(matches[0].tmdbId);
  }

  const hit = cachedFile(meta, quality, null, null);
  if (hit) return { ...hit, meta };

  const media = { ...meta, type: 'movie' };
  const opts = {
    quality: Number(quality), want: Number(quality), year: meta.year,
    query: `${meta.title} ${meta.year || ''} ${quality}p`.trim(),
    old: isOld(meta.year),
    maxMB: config.maxSendMB
  };

  const res = await resolver.resolve(media, opts);
  return { ...res, meta };
}

// ── SERIES EPISODE (default path) ──────────────────────────────────────────
export async function resolveEpisode({ title, year, season, episode, quality = 720, tmdbId = null }) {
  await boot();

  let meta;
  if (tmdbId) {
    meta = await tmdb.tvDetails(tmdbId);
  } else {
    const matches = await tmdb.searchTv(title, year);
    if (!matches.length) throw new Error(`no series found: ${title}`);
    meta = await tmdb.tvDetails(matches[0].tmdbId);
  }

  const hit = cachedFile(meta, quality, season, episode);
  if (hit) return { ...hit, meta, season, episode };

  const media = { ...meta, type: 'series' };
  const opts = {
    quality: Number(quality), want: Number(quality), year: meta.year,
    season, episode, wantSingleEpisode: true,
    query: episodeQuery(meta.title, meta.year, season, episode),
    pickEpisode: (files) => pickEpisodeFile(files, season, episode),
    old: isOld(meta.year),
    maxMB: config.maxSendMB
  };

  const res = await resolver.resolve(media, opts);
  return { ...res, meta, season, episode };
}

// ── SERIES SEASON (packs) ──────────────────────────────────────────────────
export async function resolveSeason({ title, year, season, quality = 720, tmdbId = null }) {
  await boot();

  let meta;
  if (tmdbId) {
    meta = await tmdb.tvDetails(tmdbId);
  } else {
    const matches = await tmdb.searchTv(title, year);
    if (!matches.length) throw new Error(`no series found: ${title}`);
    meta = await tmdb.tvDetails(matches[0].tmdbId);
  }

  const media = { ...meta, type: 'series' };
  const opts = {
    quality: Number(quality), want: Number(quality), year: meta.year,
    season, episode: null, wantSingleEpisode: false,
    query: seasonQuery(meta.title, meta.year, season),
    old: isOld(meta.year),
    maxMB: 1e9                     // packs are huge; verification is size-windowed later
  };
  return { ...(await resolver.resolve(media, opts)), meta, season };
}

// file path a resolved title will be downloaded to
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

export { boot, cache, config, tv, parseRelease, matchesEpisode, tmdb, debrid, resolver, registry, queue, mlog };
export default {
  boot, resolveMovie, resolveEpisode, resolveSeason, targetFile, rememberFile,
  cache, config, tmdb, resolver, debrid, registry, queue
};
