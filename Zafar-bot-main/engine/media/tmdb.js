// src/media/tmdb.js — TMDB client with TTL-cached API responses.
import config from '../config.js';
import cache from '../core/cache.js';
import { req } from '../core/http.js';

const BASE = 'https://api.themoviedb.org/3';

export async function api(path, params = {}) {
  if (!config.tmdbKey) throw new Error('TMDB_API_KEY not set');
  const ck = `tmdb:${path}:${JSON.stringify(params)}`;
  const hit = cache.mget(ck);
  if (hit) { cache.hit('meta'); return hit; }

  const url = new URL(BASE + path);
  url.searchParams.set('api_key', config.tmdbKey);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);

  const d = await req(url.toString());
  cache.mset(ck, d);
  return d;
}

export async function searchMovie(title, year) {
  const d = await api('/search/movie', { query: title, include_adult: 'false', year });
  return (d.results || []).slice(0, 6).map(r => ({
    tmdbId: r.id, title: r.title, year: (r.release_date || '').slice(0, 4),
    popularity: r.popularity || 0,
    poster: r.poster_path ? `https://image.tmdb.org/t/p/w500${r.poster_path}` : null
  }));
}

export async function searchTv(title, year) {
  const d = await api('/search/tv', { query: title, include_adult: 'false', first_air_date_year: year });
  return (d.results || []).slice(0, 6).map(r => ({
    tmdbId: r.id, title: r.name, year: (r.first_air_date || '').slice(0, 4),
    popularity: r.popularity || 0,
    poster: r.poster_path ? `https://image.tmdb.org/t/p/w500${r.poster_path}` : null
  }));
}

export async function movieDetails(id) {
  const d = await api(`/movie/${id}`, { append_to_response: 'external_ids' });
  return {
    tmdbId: d.id, imdbId: d.imdb_id || d.external_ids?.imdb_id || null,
    title: d.title, year: (d.release_date || '').slice(0, 4),
    runtime: d.runtime || 0, type: 'movie',
    poster: d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : null
  };
}

export async function tvDetails(id) {
  const d = await api(`/tv/${id}`, { append_to_response: 'external_ids' });
  return {
    tmdbId: d.id, imdbId: d.external_ids?.imdb_id || null,
    tvdbId: d.external_ids?.tvdb_id || null,
    title: d.name, year: (d.first_air_date || '').slice(0, 4),
    runtime: d.episode_run_time?.[0] || 0, type: 'series',
    seasons: d.number_of_seasons, episodes: d.number_of_episodes,
    poster: d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : null
  };
}

// Netflix-style catalog via TMDB discover (watch provider 8 = Netflix).
// 2.0 had a lib/media/netflix module that was MISSING from the source drop —
// 3.0 implements it properly against TMDB discover with region support.
export async function netflixCatalog(type = 'movie', page = 1) {
  const d = await api(`/discover/${type === 'tv' ? 'tv' : 'movie'}`, {
    with_watch_providers: 8,
    watch_region: config.region,
    sort_by: 'popularity.desc',
    page
  });
  return (d.results || []).map(r => ({
    title: type === 'tv' ? r.name : r.title,
    year: ((type === 'tv' ? r.first_air_date : r.release_date) || '').slice(0, 4),
    rating: r.vote_average?.toFixed?.(1) || null,
    poster: r.poster_path ? `https://image.tmdb.org/t/p/w500${r.poster_path}` : null
  }));
}
