// engine/metadata/index.js — the multi-source metadata layer.
//
// ONE job: turn whatever the user typed into a single item that carries every id
// the download providers need (imdbId for torrent indexers, tmdbId for the
// stream providers, malId for anime), from whichever sources happen to be alive.
//
// Sources and why each one is here:
//   tmdb      key    primary; the only one with a full episode guide + tmdb ids
//   cinemeta  none   keyless, instant, returns imdb_id AND moviedb_id
//   imdb      none   suggestion API (or the optional local bulk index)
//   tvmaze    none   TV episode guides / air dates / niche shows
//   omdb      key    ratings + runtime + imdb join                (optional)
//   trakt     key    trending + ids for odd titles                (optional)
//   jikan     none   anime (MAL ids, absolute episodes)
//   anilist   none   anime (romaji titles, second index)
//
// Rules:
//   • a source may fail, hang or be unconfigured — it is skipped, never fatal
//   • search runs all enabled sources in parallel with a hard deadline
//   • results are merged per title (not per source) so one film shows up once
//   • details() then joins the surviving item against every source that can add
//     an id, so a TMDB outage still yields a downloadable item
import config from '../config.js';
import { log } from '../core/log.js';
import { metrics } from '../core/metrics.js';

import tmdb from './tmdb.js';
import cinemeta from './cinemeta.js';
import imdb from './imdb.js';
import tvmaze from './tvmaze.js';
import omdb from './omdb.js';
import trakt from './trakt.js';
import jikan from './jikan.js';
import anilist from './anilist.js';

const mlog = log.child('metadata');

export const SOURCES = [tmdb, cinemeta, imdb, tvmaze, omdb, trakt, jikan, anilist];

const sourceById = (id) => SOURCES.find(s => s.id === id);

/** Enabled = toggle on + key present (if it needs one). */
export function liveSources(type) {
  return SOURCES.filter(s => {
    if (type && !s.supports.includes(type)) return false;
    return typeof s.enabled === 'function' ? s.enabled() !== false : true;
  });
}

const withTimeout = (p, ms, fallback) => new Promise(resolve => {
  const t = setTimeout(() => resolve(fallback), ms);
  t.unref?.();
  Promise.resolve(p).then(v => { clearTimeout(t); resolve(v); }).catch(() => { clearTimeout(t); resolve(fallback); });
});

const normTitle = (s) => String(s || '')
  .toLowerCase()
  .replace(/\(\d{4}\)/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

/** Two items are the same work if they share an id, or title+year match. */
function sameWork(a, b) {
  if (a.imdbId && b.imdbId && a.imdbId === b.imdbId) return true;
  if (a.tmdbId && b.tmdbId && a.tmdbId === b.tmdbId) return true;
  if (a.malId && b.malId && a.malId === b.malId) return true;
  const ta = normTitle(a.title), tb = normTitle(b.title);
  if (!ta || !tb) return false;
  if (ta !== tb) return false;
  if (a.year && b.year && Math.abs(Number(a.year) - Number(b.year)) > 1) return false;
  return true;
}

const PRIORITY = Object.fromEntries(SOURCES.map(s => [s.id, s.priority]));

/** Merge b into a without letting an empty field overwrite a real one. */
function absorb(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    if (out[k] === undefined || out[k] === null || out[k] === '' || (Array.isArray(out[k]) && !out[k].length)) out[k] = v;
  }
  out.source = a.source;
  out.sources = [...new Set([...(a.sources || [a.source]), b.source])];
  if (b.anime) out.anime = true;
  if (b.altTitles) out.altTitles = [...new Set([...(a.altTitles || []), ...b.altTitles])];
  return out;
}

function scoreItem(item, { title, year, type }) {
  let s = PRIORITY[item.source] || 10;
  if (item.type && type && item.type !== type) s -= 40;
  const want = normTitle(title);
  const got = normTitle(item.title);
  if (got === want) s += 40;
  else if (got.startsWith(want) || want.startsWith(got)) s += 20;
  if (year && item.year) {
    const d = Math.abs(Number(item.year) - Number(year));
    s += d === 0 ? 30 : d === 1 ? 10 : -25;
  }
  if (item.imdbId) s += 8;         // an item that already has an id is more useful
  if (item.tmdbId) s += 4;
  if (item.poster) s += 2;
  return s;
}

/**
 * Search every live source and merge the results.
 * @returns {Promise<Array>} merged items, best first
 */
export async function search(title, { type = 'movie', year = null, limit = 8, deadlineMs } = {}) {
  const query = String(title || '').trim();
  if (!query) return [];

  const sources = liveSources(type);
  const ms = deadlineMs || config.metadataTimeoutMs || 8000;

  const results = await Promise.all(sources.map(async (s) => {
    const started = Date.now();
    const hits = await withTimeout(s.search(query, { year, type, limit }), ms, []);
    metrics.time(`meta.${s.id}`, Date.now() - started);
    if (hits?.length) metrics.bump(`meta.${s.id}.hit`);
    else metrics.bump(`meta.${s.id}.miss`);
    return (hits || []).map(h => ({ ...h, source: h.source || s.id }));
  }));

  // merge duplicates across sources
  const merged = [];
  for (const item of results.flat()) {
    if (!item?.title) continue;
    if (type && item.type && item.type !== type) continue;
    const existing = merged.find(m => sameWork(m, item));
    if (existing) {
      const patched = absorb(existing, item);
      merged[merged.indexOf(existing)] = patched;
    } else {
      merged.push({ ...item, sources: [item.source] });
    }
  }

  merged.sort((a, b) => scoreItem(b, { title, year, type }) - scoreItem(a, { title, year, type }));
  mlog.debug(`search "${query}" (${type}) → ${merged.length} item(s) from ${sources.length} source(s)`);
  return merged.slice(0, limit);
}

/**
 * Enrich one item with every id/metadata a source can offer.
 * Never throws: a dead source just doesn't contribute.
 */
export async function details(item, { deadlineMs } = {}) {
  if (!item) return null;
  const ms = deadlineMs || config.metadataTimeoutMs || 8000;
  let out = { ...item, sources: item.sources || [item.source] };

  // 1. the item's own source first (fast, authoritative for that id space)
  const home = sourceById(item.source);
  if (home?.details) {
    const enriched = await withTimeout(home.details(item), ms, null);
    if (enriched) out = absorb(out, { ...enriched, source: item.source });
  }

  // 2. ask the sources that can fill ids in parallel
  const fillers = SOURCES.filter(s => s !== home && s.details && s.enabled?.());
  const rounds = await Promise.all(fillers.map(async (s) => {
    try {
      const r = await withTimeout(s.details(out), ms, null);
      return r ? { ...r, source: s.id } : null;
    } catch { return null; }
  }));

  for (const r of rounds) if (r) out = absorb(out, r);

  // 3. last resort: TMDB /find by imdb id gives us the tmdb id the stream
  //    providers need when TMDB search itself was what failed.
  if (!out.tmdbId && out.imdbId && tmdb.enabled()) {
    const f = await withTimeout(tmdb.details({ ...out, tmdbId: null }), ms, null);
    if (f?.tmdbId) out = absorb(out, f);
  }

  out.sources = [...new Set(out.sources || [])];
  return out;
}

/** Search + details in one call (what the commands use). */
export async function lookup(title, opts = {}) {
  const hits = await search(title, opts);
  if (!hits.length) return [];
  const enriched = await Promise.all(hits.slice(0, opts.limit || 8).map(h =>
    details(h, opts).catch(() => h)));
  return enriched;
}

/** Anime detection for routing (Nyaa first, romaji titles, absolute episodes). */
export function looksAnime(item) {
  if (!item) return false;
  if (item.anime || item.malId || item.anilistId) return true;
  const genres = (item.genres || []).map(g => String(g).toLowerCase());
  if (genres.includes('anime')) return true;
  const name = String(item.title || '');
  return /(?:season\s*\d+|\bova\b|\bona\b|\bsub\b|\bdub\b)/i.test(name) && /[^\x00-\x7F]/.test(name);
}

/** Health table for .providers / .metadata */
export function table() {
  return SOURCES.map(s => ({
    id: s.id,
    label: s.label,
    needsKey: s.needsKey,
    enabled: typeof s.enabled === 'function' ? s.enabled() : true,
    supports: s.supports,
    priority: s.priority,
  }));
}

export { tmdb, cinemeta, imdb, tvmaze, omdb, trakt, jikan, anilist };

export default {
  search, details, lookup, looksAnime, table, liveSources, SOURCES,
  tmdb, cinemeta, imdb, tvmaze, omdb, trakt, jikan, anilist,
};
