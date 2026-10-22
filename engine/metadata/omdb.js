// engine/metadata/omdb.js — OMDb (optional free key, 1k/day).
//
// Adds IMDb ratings, runtime, director/cast and the imdb_id↔title join for
// titles the other sources describe poorly. Entirely optional: without a key the
// source reports itself as disabled and the chain skips it.
import config from '../config.js';
import cache from '../core/cache.js';
import { req } from '../core/http.js';

const BASE = () => process.env.OMDB_BASE || config.omdbBase || 'https://www.omdbapi.com';

const norm = (d, type) => ({
  source: 'omdb', type,
  imdbId: d.imdbID || null,
  title: d.Title || '',
  year: (d.Year || '').slice(0, 4) || null,
  poster: d.Poster && d.Poster !== 'N/A' ? d.Poster : null,
  rating: d.imdbRating && d.imdbRating !== 'N/A' ? Number(d.imdbRating) : null,
  runtime: Number(String(d.Runtime || '').replace(/\D+/g, '')) || 0,
  genres: d.Genre && d.Genre !== 'N/A' ? d.Genre.split(',').map(s => s.trim()) : [],
  overview: d.Plot && d.Plot !== 'N/A' ? d.Plot : '',
  director: d.Director && d.Director !== 'N/A' ? d.Director : null,
  actors: d.Actors && d.Actors !== 'N/A' ? d.Actors : null,
  seasons: d.totalSeasons ? Number(d.totalSeasons) : null,
  popularity: 0,
});

const api = async (params) => {
  if (!config.omdbKey) throw new Error('OMDB_API_KEY not set');
  const url = new URL(BASE() + '/');
  url.searchParams.set('apikey', config.omdbKey);
  url.searchParams.set('plot', 'short');
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);

  const ck = `omdb:${url.search}`;
  const hit = cache.mget(ck);
  if (hit) { cache.hit('meta'); return hit; }

  const d = await req(url.toString());
  if (d?.Response === 'False') throw new Error(d.Error || 'omdb: not found');
  cache.mset(ck, d, 24);
  return d;
};

export async function search(title, { year, type } = {}) {
  const d = await api({ s: title, y: year || undefined, type: type === 'series' ? 'series' : 'movie' });
  return (d.Search || []).map(r => norm(r, r.Type === 'series' ? 'series' : 'movie'));
}

export async function byImdb(imdbId, type = 'movie') {
  if (!/^tt\d+$/.test(String(imdbId || ''))) return null;
  const d = await api({ i: imdbId });
  return norm(d, d.Type === 'series' ? 'series' : (type || 'movie'));
}

export default {
  id: 'omdb', label: 'OMDb', needsKey: true, priority: 50,
  supports: ['movie', 'series'],
  enabled: () => Boolean(config.omdbKey) && config.metadata?.omdb !== false,
  search,
  async details(item) {
    if (item.imdbId) return byImdb(item.imdbId, item.type);
    return null;
  },
  byImdb,
};
