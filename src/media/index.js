// src/media/index.js — high-level resolve API. Boot logic, disk-cache short
// circuit, tiered resolution. This is what commands talk to.
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import cache from '../core/cache.js';
import resolver from '../core/resolver.js';
import debrid from '../providers/debrid/index.js';
import { isOld } from '../core/ranker.js';
import { metrics } from '../core/metrics.js';
import * as tmdb from './tmdb.js';
import * as tv from '../core/release.js';
import { parseRelease, matchesEpisode } from '../core/release.js';
import { pickEpisodeFile, episodeQuery, seasonQuery } from '../core/tv.js';
import { sanitize } from './download.js';
import { log } from '../core/log.js';

const mlog = log.child('media');

// provider registration (idempotent) — 13 sources across 3 tiers
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

// ── MOVIE ──────────────────────────────────────────────────────────────────
export async function resolveMovie({ title, year, quality = '720' }) {
  await boot();
  const matches = await tmdb.searchMovie(title, year);
  if (!matches.length) throw new Error(`no movie found: ${title}`);
  const m = matches[0];
  const meta = await tmdb.movieDetails(m.tmdbId);

  const ck = cache.keyOf(meta.imdbId, null, null, quality);
  const hit = cache.fget(ck);
  if (hit) {
    metrics.bump('cache.disk');
    return { ...hit, meta };
  }

  const media = { ...meta, type: 'movie' };
  const opts = {
    quality: Number(quality), want: Number(quality), year: meta.year,
    query: `${meta.title} ${meta.year} ${quality}p`,
    old: isOld(meta.year),
    maxMB: config.maxSendMB
  };

  const res = await resolver.resolve(media, opts);
  return { ...res, meta };
}

// ── SERIES EPISODE (default path) ──────────────────────────────────────────
export async function resolveEpisode({ title, year, season, episode, quality = '720', allowPack = false }) {
  await boot();
  const matches = await tmdb.searchTv(title, year);
  if (!matches.length) throw new Error(`no series found: ${title}`);
  const meta = await tmdb.tvDetails(matches[0].tmdbId);

  const ck = cache.keyOf(meta.imdbId, season, episode, quality);
  const hit = cache.fget(ck);
  if (hit) {
    metrics.bump('cache.disk');
    return { ...hit, meta, season, episode };
  }

  const media = { ...meta, type: 'series' };
  const pickEpisode = (files) => pickEpisodeFile(files, season, episode);

  const opts = {
    quality: Number(quality), want: Number(quality), year: meta.year,
    season, episode, wantSingleEpisode: true,
    query: episodeQuery(meta.title, meta.year, season, episode),
    pickEpisode,
    old: isOld(meta.year),
    maxMB: config.maxSendMB
  };

  const res = await resolver.resolve(media, opts);
  return { ...res, meta, season, episode };
}

// ── SERIES SEASON (packs, only when cached) ────────────────────────────────
export async function resolveSeason({ title, year, season, quality = '720' }) {
  await boot();
  const matches = await tmdb.searchTv(title, year);
  if (!matches.length) throw new Error(`no series found: ${title}`);
  const meta = await tmdb.tvDetails(matches[0].tmdbId);

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

export { boot, cache, config, tv, parseRelease, matchesEpisode, tmdb, debrid, resolver, mlog };
export default { boot, resolveMovie, resolveEpisode, resolveSeason, targetFile, cache, config, tmdb, resolver, debrid };
