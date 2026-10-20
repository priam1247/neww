// engine/metadata/anilist.js — AniList GraphQL (no key).
//
// Second anime source: different index than MAL, so between Jikan and AniList
// almost every anime title resolves. Also gives the romaji title, which is what
// Nyaa/SubsPlease releases are named after.
import config from '../config.js';
import cache from '../core/cache.js';
import { req } from '../core/http.js';

const BASE = () => process.env.ANILIST_BASE || config.anilistBase || 'https://graphql.anilist.co';

const QUERY = `
query ($search: String, $id: Int, $perPage: Int) {
  Page(page: 1, perPage: $perPage) {
    media(search: $search, id: $id, type: ANIME, isAdult: false, sort: SEARCH_MATCH) {
      id
      idMal
      title { romaji english native }
      startDate { year }
      episodes
      duration
      averageScore
      popularity
      status
      description(asHtml: false)
      coverImage { extraLarge large }
      genres
      synonyms
    }
  }
}`;

async function gql(variables) {
  const ck = `anilist:${JSON.stringify(variables)}`;
  const hit = cache.mget(ck);
  if (hit) { cache.hit('meta'); return hit; }

  const d = await req(BASE(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query: QUERY, variables }),
    retries: 1,
  });
  const media = d?.data?.Page?.media || [];
  cache.mset(ck, media, 6);
  return media;
}

const norm = (m) => ({
  source: 'anilist', type: 'series',
  anilistId: m.id,
  malId: m.idMal || null,
  title: m.title?.english || m.title?.romaji || m.title?.native || '',
  altTitles: [m.title?.romaji, m.title?.english, m.title?.native, ...(m.synonyms || [])].filter(Boolean),
  year: m.startDate?.year ? String(m.startDate.year) : null,
  poster: m.coverImage?.extraLarge || m.coverImage?.large || null,
  rating: m.averageScore ? m.averageScore / 10 : null,
  episodes: m.episodes ?? null,
  runtime: m.duration || 0,
  genres: m.genres || [],
  overview: String(m.description || '').replace(/<[^>]*>/g, ''),
  anime: true,
  status: m.status || '',
  popularity: m.popularity || 0,
});

export async function search(title, { limit = 8 } = {}) {
  const media = await gql({ search: title, perPage: limit });
  return media.map(norm).filter(a => a.title);
}

export async function byId(id) {
  const media = await gql({ id: Number(id), perPage: 1 });
  return media[0] ? norm(media[0]) : null;
}

export default {
  id: 'anilist', label: 'AniList', needsKey: false, priority: 35,
  supports: ['series'],
  enabled: () => config.metadata?.anime !== false,
  search,
  async details(item) {
    if (item.anilistId) return byId(item.anilistId);
    if (item.anime || item.type === 'series') {
      const hits = await search(item.title, { limit: 3 });
      const best = hits[0];
      if (best && (!item.year || !best.year || Math.abs(Number(best.year) - Number(item.year)) <= 1)) return best;
    }
    return null;
  },
  byId,
};
