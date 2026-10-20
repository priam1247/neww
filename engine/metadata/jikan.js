// engine/metadata/jikan.js — Jikan v4 (MyAnimeList mirror, no key).
//
// Anime is the one category TMDB is worst at: OVAs, specials, seasons named
// "2nd Season", absolute episode numbers. Jikan returns the MAL id, the exact
// episode count and the alternative titles the indexers actually use.
import config from '../config.js';
import cache from '../core/cache.js';
import { req } from '../core/http.js';

const BASE = () => process.env.JIKAN_BASE || config.jikanBase || 'https://api.jikan.moe/v4';

const titleOf = (a) => a.title_english || a.title || a.title_japanese || '';

const norm = (a) => ({
  source: 'jikan', type: 'series',
  malId: a.mal_id,
  title: titleOf(a),
  altTitles: [a.title, a.title_english, a.title_japanese, ...(a.titles || []).map(t => t.title)].filter(Boolean),
  year: a.year || (a.aired?.from ? String(a.aired.from).slice(0, 4) : null),
  poster: a.images?.jpg?.large_image_url || a.images?.jpg?.image_url || null,
  rating: a.score ?? null,
  episodes: a.episodes ?? null,
  seasons: null,
  runtime: a.duration ? Number(String(a.duration).replace(/\D+/g, '')) || 0 : 0,
  genres: [...(a.genres || []), ...(a.themes || [])].map(g => g.name),
  overview: a.synopsis || '',
  anime: true,
  status: a.status || '',
  popularity: a.members || 0,
});

export async function search(title, { limit = 8 } = {}) {
  const ck = `jikan:search:${title.toLowerCase()}`;
  const hit = cache.mget(ck);
  if (hit) { cache.hit('meta'); return hit; }

  const d = await req(`${BASE()}/anime?q=${encodeURIComponent(title)}&limit=${limit}&sfw=true`, { retries: 1 });
  const out = (d.data || []).map(norm).filter(a => a.title);
  cache.mset(ck, out, 6);
  return out;
}

export async function byMal(malId) {
  const ck = `jikan:anime:${malId}`;
  const hit = cache.mget(ck);
  if (hit) { cache.hit('meta'); return hit; }

  const d = await req(`${BASE()}/anime/${malId}/full`, { retries: 1 });
  if (!d?.data) return null;
  const item = norm(d.data);
  cache.mset(ck, item, 24);
  return item;
}

export default {
  id: 'jikan', label: 'Jikan (MAL)', needsKey: false, priority: 30,
  supports: ['series'],
  enabled: () => config.metadata?.anime !== false,
  search,
  async details(item) {
    if (item.malId) return byMal(item.malId);
    if (item.anime || item.type === 'series') {
      const hits = await search(item.title, { limit: 3 });
      const best = hits[0];
      if (best && (!item.year || !best.year || Math.abs(Number(best.year) - Number(item.year)) <= 1)) return best;
    }
    return null;
  },
  byMal,
};
