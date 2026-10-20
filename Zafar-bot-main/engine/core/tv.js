// src/core/tv.js — episode/season text handling: input parsing, query building
// and the "pick the right file inside a pack" logic. Clean rewrite of 2.0's
// parse.js + the tangled season-parsing mess in its series.js (lines 91-94).
import { parseRelease, matchesEpisode } from './release.js';

const Q = (s) => String(s || '').trim().replace(/\s+/g, ' ');
const pad2 = (n) => String(n).padStart(2, '0');

const RX = [
  /\bs(\d{1,2})[\s._-]?e(\d{1,3})\b/i,
  /\b(\d{1,2})x(\d{2,3})\b/,
  /\bseason[ ._-]?(\d{1,2})[ ._-]?ep(?:isode)?[ ._-]?(\d{1,3})\b/i
];

export function parseEpisode(text) {
  for (const re of RX) {
    const m = re.exec(text);
    if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  }
  return null;
}

export function parseSeason(text) {
  const m = /\bs(?:eason)?[ ._-]?(\d{1,2})\b/i.exec(text);
  return m ? Number(m[1]) : null;
}

export function parseRange(text) {
  const m = /\b(\d{1,3})\s*-\s*(\d{1,3})\b/.exec(text);
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]);
  return a <= b ? { from: a, to: b } : { from: b, to: a };
}

// structured parse of a user series request — replaces 2.0's line-noise
export function parseSeriesRequest(rest) {
  const ep = parseEpisode(rest);
  const range = parseRange(rest);
  const full = /\bfull\b/i.test(rest);
  const seasonOnly = ep ? null : (parseSeason(rest) ?? (range ? null : /s(?:eason)?\s*(\d{1,2})/i.exec(rest)?.[1] && Number(/s(?:eason)?\s*(\d{1,2})/i.exec(rest)[1])));

  const title = rest
    .replace(/\bs\d{1,2}[\s._-]?e\d{1,3}\b/gi, '')
    .replace(/\b\d{1,2}x\d{2,3}\b/gi, '')
    .replace(/\bs(?:eason)?[\s._-]?\d{1,2}\b/gi, '')
    .replace(/\b(full|range)\b/gi, '')
    .replace(/\b\d{1,3}\s*-\s*\d{1,3}\b/g, '')
    .trim();

  let season = 1, epStart = 1, epEnd = 1;
  if (ep) { season = ep.season; epStart = ep.episode; epEnd = ep.episode; }
  else if (range) { season = seasonOnly || 1; epStart = range.from; epEnd = range.to; }
  else if (seasonOnly) { season = Number(seasonOnly); epStart = 1; epEnd = 0; }   // whole season marker

  return { title, season, epStart, epEnd, full, range };
}

// query strings indexers want — per-episode by default
export function episodeQuery(title, year, season, episode) {
  return Q(`${title} ${year || ''} S${pad2(season)}E${pad2(episode)}`);
}

export function seasonQuery(title, year, season) {
  return Q(`${title} ${year || ''} S${pad2(season)}`);
}

// from a debrid file list (pack or single), pick the right episode file
export function pickEpisodeFile(files, season, episode) {
  const vids = files
    .filter(f => /\.(mp4|mkv|avi|mov|m4v|webm)$/i.test(f.path || ''))
    .filter(f => !/sample|trailer|extras|behind/i.test(f.path || ''));
  if (!vids.length) return null;

  const sP = pad2(season), eP = pad2(episode);

  const exact = vids.find(f =>
    new RegExp(`s${sP}[ ._-]?e${eP}(?:[ ._-]?e\\d{1,3})?\\b`, 'i').test(f.path) ||
    new RegExp(`\\b${season}x${eP}\\b`, 'i').test(f.path) ||
    new RegExp(`\\b${season} ?[.-] ?${episode}\\b`).test(f.path));
  if (exact) return exact;

  // release-aware filter: drop files that plainly belong to other episodes
  const parsed = vids
    .map(f => ({ f, rel: parseRelease(f.path) }))
    .filter(({ rel, f }) => matchesEpisode(rel, season, episode, f.path));
  if (parsed.length === 1) return parsed[0].f;

  // absolute-numbered anime fallback
  const abs = vids.find(f => new RegExp(`\\b${pad2(episode)}\\b`).test(f.path));
  if (abs) return abs;

  // ordered fallback: numeric sort then index
  const sorted = [...vids].sort((a, b) => String(a.path).localeCompare(String(b.path), undefined, { numeric: true }));
  return sorted[episode - 1] || sorted[0] || null;
}

export { parseRelease, matchesEpisode };
