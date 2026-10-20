// engine/metadata/tvmaze.js — TVMaze (no key): TV only, but the best free
// episode guide there is. Used for
//   • series search when TMDB has nothing (foreign / reality / niche shows)
//   • episode counting: ".series x s03" batch caps, "does that episode exist?"
//   • air dates: the bot can say "E04 airs on 2026-11-02" instead of failing
import config from '../config.js';
import cache from '../core/cache.js';
import { req } from '../core/http.js';

const BASE = () => process.env.TVMAZE_BASE || config.tvmazeBase || 'https://api.tvmaze.com';

const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, '').trim();

const norm = (s) => ({
  source: 'tvmaze', type: 'series',
  tvmazeId: s.id,
  imdbId: s.externals?.imdb || null,
  tvdbId: s.externals?.thetvdb || null,
  tmdbId: null,
  title: s.name || '',
  year: (s.premiered || '').slice(0, 4) || null,
  poster: s.image?.original || s.image?.medium || null,
  rating: s.rating?.average ?? null,
  genres: s.genres || [],
  overview: stripTags(s.summary),
  runtime: s.averageRuntime || s.runtime || 0,
  status: s.status || '',
  seasons: null,
  episodes: null,
  network: s.network?.name || s.webChannel?.name || null,
  popularity: s.weight || 0,
});

export async function search(title) {
  const ck = `tvmaze:search:${title.toLowerCase()}`;
  const hit = cache.mget(ck);
  if (hit) { cache.hit('meta'); return hit; }

  const d = await req(`${BASE()}/search/shows?q=${encodeURIComponent(title)}`);
  const out = (Array.isArray(d) ? d : []).map(r => norm(r.show || r)).filter(x => x.title);
  cache.mset(ck, out, 6);
  return out;
}

export async function show(id) {
  const ck = `tvmaze:show:${id}`;
  const hit = cache.mget(ck);
  if (hit) { cache.hit('meta'); return hit; }

  const d = await req(`${BASE()}/shows/${id}?embed[]=episodes`);
  const item = norm(d);
  item.seasons = (d._embedded?.episodes || []).reduce((m, e) => Math.max(m, Number(e.season) || 0), 0) || null;
  item.episodes = d._embedded?.episodes?.length || null;
  cache.mset(ck, item, 24);
  return item;
}

export async function byImdb(imdbId) {
  if (!/^tt\d+$/.test(String(imdbId || ''))) return null;
  try {
    const d = await req(`${BASE()}/lookup/shows?imdb=${imdbId}`);
    const item = norm(d);
    return item.title ? item : null;
  } catch { return null; }
}

/** One episode's air date/name, or null when it does not exist (yet). */
export async function episode(showId, season, number) {
  const ck = `tvmaze:ep:${showId}:${season}:${number}`;
  const hit = cache.mget(ck);
  if (hit) { cache.hit('meta'); return hit; }

  try {
    const d = await req(`${BASE()}/shows/${showId}/episodebynumber?season=${season}&number=${number}`);
    if (!d) return null;
    const out = { episode: d.number, season: d.season, title: d.name || '', airDate: d.airdate || null, airstamp: d.airstamp || null };
    cache.mset(ck, out, 24);
    return out;
  } catch { return null; }
}

/** Whole season, ordered — used for batches and "how many episodes". */
export async function season(showId, seasonNumber) {
  const ck = `tvmaze:season:${showId}:${seasonNumber}`;
  const hit = cache.mget(ck);
  if (hit) { cache.hit('meta'); return hit; }

  const d = await req(`${BASE()}/shows/${showId}/episodes?season=${seasonNumber}`);
  const out = (Array.isArray(d) ? d : []).map(e => ({
    episode: e.number, season: e.season, title: e.name || '', airDate: e.airdate || null,
  }));
  cache.mset(ck, out, 24);
  return out;
}

export default {
  id: 'tvmaze', label: 'TVMaze', needsKey: false, priority: 60,
  supports: ['series'],
  enabled: () => config.metadata?.tvmaze !== false,
  search,
  async details(item) {
    if (item.tvmazeId) return show(item.tvmazeId);
    if (item.imdbId) {
      const found = await byImdb(item.imdbId);
      if (found) return show(found.tvmazeId);
    }
    if (item.title && item.type === 'series') {
      const hits = await search(item.title);
      const best = hits.find(h => !item.year || !h.year || Math.abs(Number(h.year) - Number(item.year)) <= 1);
      if (best) return show(best.tvmazeId);
    }
    return null;
  },
  byImdb, episode, season,
};
