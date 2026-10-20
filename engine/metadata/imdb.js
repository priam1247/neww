// engine/metadata/imdb.js — IMDb, two ways.
//
//  1. **Suggest API** (default, keyless): v2.sg.media-imdb.com/suggestion returns
//     imdb ids + titles + years for a prefix. No quota, no key, works right away.
//  2. **Local bulk index** (optional, complete): scripts/imdb-index.js streams the
//     official title.basics.tsv.gz dump into a compact index file. When that file
//     exists the engine queries it instead — full coverage, zero network, and it
//     still works when every API here is down.
import fs from 'node:fs';
import readline from 'node:readline';
import config from '../config.js';
import cache from '../core/cache.js';
import { req } from '../core/http.js';

const SUGGEST_BASE = () => process.env.IMDB_SUGGEST_BASE || config.imdbSuggestBase || 'https://v2.sg.media-imdb.com';
const INDEX_FILE = () => process.env.IMDB_INDEX_FILE || config.imdbIndexFile || './temp/imdb-index.tsv';

// Positive results are cached briefly; a MISS is always re-checked, so an index
// built while the bot is running is picked up without a restart.
let indexReadyAt = 0;

function indexExists() {
  const now = Date.now();
  if (indexReadyAt && now - indexReadyAt < 60_000) return true;
  try {
    const ok = fs.existsSync(INDEX_FILE()) && fs.statSync(INDEX_FILE()).size > 0;
    indexReadyAt = ok ? now : 0;
    return ok;
  } catch {
    indexReadyAt = 0;
    return false;
  }
}

export const hasIndex = () => indexExists();

const norm = (d) => ({
  source: 'imdb', type: d.qid === 'tvSeries' || d.qid === 'tvMiniSeries' ? 'series' : 'movie',
  imdbId: d.id,
  title: d.l || d.title || '',
  year: String(d.y || d.year || '').slice(0, 4) || null,
  poster: d.i?.imageUrl || null,
  rating: null,
  overview: d.s || '',
  actors: d.s || '',
  popularity: d.rank || 0,
});

/** Keyless suggestion search. */
export async function suggest(title, { limit = 8 } = {}) {
  const ck = `imdb:suggest:${title.toLowerCase()}`;
  const hit = cache.mget(ck);
  if (hit) { cache.hit('meta'); return hit; }

  const d = await req(`${SUGGEST_BASE()}/suggestion/x/${encodeURIComponent(title)}.json`, { retries: 1 });
  const out = (d.d || []).map(norm).filter(x => x.imdbId).slice(0, limit);
  cache.mset(ck, out, 6);
  return out;
}

/**
 * Lookup in the local bulk index (built by scripts/imdb-index.js).
 * The file is sorted-ish plain TSV: `<imdbId>\t<type>\t<title>\t<titleLower>\t<year>`
 */
export async function fromIndex(title, { type, year, limit = 10 } = {}) {
  if (!indexExists()) return [];
  const needle = String(title || '').toLowerCase().trim();
  if (needle.length < 2) return [];

  const hits = [];
  const stream = fs.createReadStream(INDEX_FILE(), { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    const [imdbId, kind, name, lower, y] = line.split('\t');
    if (!lower || !lower.includes(needle)) continue;
    if (type && kind !== type) continue;
    if (year && y && Math.abs(Number(y) - Number(year)) > 1) continue;
    hits.push({
      source: 'imdb', type: kind, imdbId, title: name,
      year: y || null, poster: null, rating: null, overview: '', popularity: 0,
    });
    if (hits.length >= limit) break;
  }
  rl.close();
  stream.destroy();
  return hits;
}

export default {
  id: 'imdb', label: 'IMDb', needsKey: false, priority: 70,
  supports: ['movie', 'series'],
  enabled: () => config.metadata?.imdb !== false,
  async search(title, opts = {}) {
    if (indexExists()) {
      const local = await fromIndex(title, opts);
      if (local.length) return local;
    }
    return suggest(title, opts);
  },
  async details() { return null; },       // ids + titles only
  hasIndex,
  fromIndex,
  suggest,
};
