// engine/metadata/cinemeta.js — Stremio's Cinemeta catalog (no key, no quota).
//
// The most useful fallback: keyless, instant, and it returns BOTH ids for a
// title (`imdb_id` + `moviedb_id`), which is exactly what the download providers
// need (torrent indexers want IMDb ids, stream providers want TMDB ids).
import config from '../config.js';
import cache from '../core/cache.js';
import { req } from '../core/http.js';

const BASE = () => process.env.CINEMETA_BASE || config.cinemetaBase || 'https://v3-cinemeta.strem.io';

const norm = (m, type) => ({
  source: 'cinemeta', type,
  imdbId: m.imdb_id || null,
  tmdbId: m.moviedb_id ? Number(m.moviedb_id) : null,
  title: m.name || '',
  year: m.releaseInfo || m.year ? String(m.releaseInfo || m.year).slice(0, 4) : null,
  poster: m.poster || null,
  rating: m.imdbRating ? Number(m.imdbRating) : null,
  genres: m.genres || m.genre || [],
  overview: m.description || '',
  runtime: m.runtime || '',
  popularity: 0,
});

/**
 * Catalog search. Cinemeta only supports prefix search on its catalog endpoint,
 * which is enough for interactive lookups.
 */
export async function search(title, type = 'movie') {
  const cat = type === 'series' ? 'series' : 'movie';
  const url = `${BASE()}/catalog/${cat}/top/search=${encodeURIComponent(title)}.json`;
  const ck = `cinemeta:search:${cat}:${title.toLowerCase()}`;
  const hit = cache.mget(ck);
  if (hit) { cache.hit('meta'); return hit; }

  const d = await req(url);
  const out = (d.metas || []).map(m => norm(m, type)).filter(m => m.imdbId || m.tmdbId);
  cache.mset(ck, out, 6);
  return out;
}

/** Full metadata for one title by IMDb id — the reliable direction. */
export async function byImdb(imdbId, type = 'movie') {
  if (!/^tt\d+$/.test(String(imdbId || ''))) return null;
  const cat = type === 'series' ? 'series' : 'movie';
  const ck = `cinemeta:meta:${cat}:${imdbId}`;
  const hit = cache.mget(ck);
  if (hit) { cache.hit('meta'); return hit; }

  const d = await req(`${BASE()}/meta/${cat}/${imdbId}.json`);
  if (!d?.meta) return null;
  const item = norm(d.meta, type);
  cache.mset(ck, item, 24);
  return item;
}

export default {
  id: 'cinemeta', label: 'Cinemeta', needsKey: false, priority: 80,
  supports: ['movie', 'series'],
  enabled: () => config.metadata?.cinemeta !== false,
  search,
  async details(item) {
    if (!item.imdbId) return null;
    const m = await byImdb(item.imdbId, item.type);
    return m ? { ...item, ...m, source: item.source } : null;
  },
  byImdb,
};
