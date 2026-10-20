// engine/metadata/tmdb.js — TMDB (the primary source).
//
// The only source in the chain that is a real key requirement, and the only one
// that returns both imdb_id and a full TV episode guide in one call. Every other
// provider in metadata/ exists so the bot keeps working when this one is down,
// rate-limited or has no key.
//
// Fixes carried over from the ZaFar Bot integration:
//   • base URL is configurable (tests point it at a local server)
//   • /find is used to turn an IMDb id into a TMDB id (needed by the stream
//     providers when the user came in through Cinemeta/IMDb)
//   • every response is cached with the TTL cache
import config from '../config.js';
import cache from '../core/cache.js';
import { req } from '../core/http.js';

const BASE = () => process.env.TMDB_BASE || config.tmdbBase || 'https://api.themoviedb.org/3';
const IMG = (p) => (p ? `https://image.tmdb.org/t/p/w500${p}` : null);

export async function api(path, params = {}) {
  if (!config.tmdbKey) throw new Error('TMDB_API_KEY not set');
  const ck = `tmdb:${path}:${JSON.stringify(params)}`;
  const hit = cache.mget(ck);
  if (hit) { cache.hit('meta'); return hit; }

  const url = new URL(BASE() + path);
  url.searchParams.set('api_key', config.tmdbKey);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);

  const d = await req(url.toString());
  cache.mset(ck, d);
  return d;
}

const movieItem = (r) => ({
  source: 'tmdb', type: 'movie',
  tmdbId: r.id,
  imdbId: r.imdb_id || r.external_ids?.imdb_id || null,
  title: r.title || r.original_title || '',
  year: (r.release_date || '').slice(0, 4) || null,
  poster: IMG(r.poster_path),
  rating: r.vote_average || null,
  popularity: r.popularity || 0,
  overview: r.overview || '',
});

const tvItem = (r) => ({
  source: 'tmdb', type: 'series',
  tmdbId: r.id,
  imdbId: r.external_ids?.imdb_id || null,
  tvdbId: r.external_ids?.tvdb_id || null,
  title: r.name || r.original_name || '',
  year: (r.first_air_date || '').slice(0, 4) || null,
  poster: IMG(r.poster_path),
  rating: r.vote_average || null,
  popularity: r.popularity || 0,
  overview: r.overview || '',
});

export async function searchMovie(title, year) {
  const d = await api('/search/movie', { query: title, include_adult: 'false', year: year || undefined });
  return (d.results || []).slice(0, 8).map(movieItem);
}

export async function searchTv(title, year) {
  const d = await api('/search/tv', { query: title, include_adult: 'false', first_air_date_year: year || undefined });
  return (d.results || []).slice(0, 8).map(tvItem);
}

export async function movieDetails(id) {
  const d = await api(`/movie/${id}`, { append_to_response: 'external_ids' });
  return {
    ...movieItem(d),
    imdbId: d.imdb_id || d.external_ids?.imdb_id || null,
    runtime: d.runtime || 0,
    genres: (d.genres || []).map(g => g.name),
    tagline: d.tagline || '',
    status: d.status || '',
  };
}

export async function tvDetails(id) {
  const d = await api(`/tv/${id}`, { append_to_response: 'external_ids' });
  return {
    ...tvItem(d),
    imdbId: d.external_ids?.imdb_id || null,
    tvdbId: d.external_ids?.tvdb_id || null,
    runtime: d.episode_run_time?.[0] || 0,
    genres: (d.genres || []).map(g => g.name),
    seasons: d.number_of_seasons,
    episodes: d.number_of_episodes,
    status: d.status || '',
  };
}

/** IMDb id → TMDB id (and back). Used to join sources that only know one id. */
export async function findByImdb(imdbId) {
  if (!/^tt\d+$/.test(String(imdbId || ''))) return null;
  const d = await api(`/find/${imdbId}`, { external_source: 'imdb_id' });
  const movie = (d.movie_results || [])[0];
  const tv = (d.tv_results || [])[0];
  if (movie) return movieItem(movie);
  if (tv) return tvItem(tv);
  return null;
}

/** Season episode list (numbers + air dates) — used by .series "list episodes". */
export async function seasonEpisodes(tvId, season) {
  const d = await api(`/tv/${tvId}/season/${season}`);
  return (d.episodes || []).map(e => ({
    episode: e.episode_number,
    title: e.name || '',
    airDate: e.air_date || null,
    runtime: e.runtime || 0,
  }));
}

/** Netflix-style catalog via TMDB discover (watch provider 8 = Netflix). */
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
    poster: IMG(r.poster_path)
  }));
}

export default {
  id: 'tmdb', label: 'TMDB', needsKey: true, priority: 100,
  supports: ['movie', 'series'],
  enabled: () => Boolean(config.tmdbKey),
  async search(title, { year, type, limit = 8 } = {}) {
    const out = type === 'series' ? await searchTv(title, year) : await searchMovie(title, year);
    return out.slice(0, limit);
  },
  async details(item) {
    if (item.tmdbId) {
      return item.type === 'series' ? tvDetails(item.tmdbId) : movieDetails(item.tmdbId);
    }
    if (item.imdbId) {
      const found = await findByImdb(item.imdbId);
      if (found) return found.type === 'series' ? tvDetails(found.tmdbId) : movieDetails(found.tmdbId);
    }
    return null;
  },
};
