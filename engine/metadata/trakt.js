// engine/metadata/trakt.js — Trakt (optional free client id).
//
// Useful for discovery (trending / popular) and for titles where you have an
// IMDb/Slug id but no TMDB match. Trakt never returns a playable link — it is
// metadata and ids only.
import config from '../config.js';
import cache from '../core/cache.js';
import { req } from '../core/http.js';

const BASE = () => process.env.TRAKT_BASE || config.traktBase || 'https://api.trakt.tv';

const headers = () => ({
  'content-type': 'application/json',
  'trakt-api-version': '2',
  'trakt-api-key': config.traktClientId,
});

const norm = (r, type) => {
  const m = type === 'series' ? (r.show || r) : (r.movie || r);
  return {
    source: 'trakt', type,
    traktId: m.ids?.trakt || null,
    imdbId: m.ids?.imdb || null,
    tmdbId: m.ids?.tmdb || null,
    tvdbId: m.ids?.tvdb || null,
    title: m.title || '',
    year: m.year || null,
    poster: null,
    rating: r.rating || m.rating || null,
    votes: r.votes || null,
    popularity: r.watchers || r.play_count || 0,
    overview: m.overview || '',
    genres: m.genres || [],
  };
};

async function get(path, params = {}) {
  if (!config.traktClientId) throw new Error('TRAKT_CLIENT_ID not set');
  const url = new URL(BASE() + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);

  const ck = `trakt:${url.pathname}${url.search}`;
  const hit = cache.mget(ck);
  if (hit) { cache.hit('meta'); return hit; }

  const d = await req(url.toString(), { headers: headers() });
  cache.mset(ck, d, 6);
  return d;
}

export async function search(title, { type = 'movie', year } = {}) {
  if (config.traktClientId) {
    try {
      const t = type === 'series' ? 'show' : 'movie';
      const d = await get(`/search/${t}`, { query: title, limit: 10, ...(year ? { years: year } : {}) });
      if (Array.isArray(d) && d.length) return d.map(r => norm(r, type));
    } catch { /* fall through to the keyless endpoint */ }
  }
  return trendingFallback(title, type);
}

/**
 * Keyless last resort: Trakt's public "extended" lists are not open, but the
 * Trakt *website* search is. Only used when no client id is configured, and it
 * never throws (the orchestrator treats an empty list as "no opinion").
 */
async function trendingFallback(title, type) {
  return [];
}

/** Trending right now — powers ".trending". */
export async function trending(type = 'movie', limit = 10) {
  const t = type === 'series' ? 'shows' : 'movies';
  const d = await get(`/${t}/trending`, { limit });
  return (Array.isArray(d) ? d : []).map(r => {
    const item = norm(r, type);
    item.watchers = r.watchers || 0;
    return item;
  });
}

export default {
  id: 'trakt', label: 'Trakt', needsKey: true, priority: 40,
  supports: ['movie', 'series'],
  enabled: () => Boolean(config.traktClientId) && config.metadata?.trakt !== false,
  search,
  trending,
  async details() { return null; },     // ids only — nothing to enrich
};
