// src/core/ranker.js — candidate scoring. Same philosophy as 2.0, sharper teeth:
//  • continuous size scoring instead of a binary ±45 cliff
//  • source ladder + network tags + log-scaled seeds (unchanged — they worked)
//  • episode/pack logic, cached boost, CAM penalty
//  • trust multiplier from the circuit-breaker registry
import config from '../config.js';
import { trustOf } from './registry.js';

const SOURCE_PTS = { REMUX: 100, BLURAY: 80, WEBDL: 70, WEBRIP: 55, HDTV: 40, HDRIP: 35, DVDRIP: 30, CAM: 10, UNKNOWN: 30 };
const NET_PTS = { NF: 18, AMZN: 14, DSNP: 16, ATVP: 14, MAX: 12, HMAX: 12 };

export function isOld(year) {
  return year && (new Date().getFullYear() - Number(year)) > config.oldYearThreshold;
}

// continuous size score: peak inside the window, gentle falloff outside
function sizeScore(sizeMB, win, maxMB) {
  const [lo, hi] = win;
  if (sizeMB >= lo && sizeMB <= hi) return 35;
  const over = sizeMB > hi;
  const dist = over ? sizeMB - hi : lo - sizeMB;
  const span = over ? hi - lo : hi - lo;
  const rel = dist / Math.max(1, span);          // how far out, in window units
  let s = rel <= 0.25 ? 0 : -15 - Math.min(30, rel * 25);
  if (sizeMB > maxMB) s -= 25;                   // too big to send = hard penalty
  return s;
}

export function rank(cands, opts) {
  const { want, year, maxMB = config.maxSendMB, anime = false } = opts;
  const win = config.sizeWindow[want] || [0, Infinity];
  const seedFloor = isOld(year) ? config.minSeedsOld : config.minSeeds;

  return cands
    .filter(c => c.kind !== 'torrent' || (c.seeds ?? 0) >= seedFloor)
    .map(c => {
      let s = 0;

      // resolution
      if (c.quality === want) s += 70;
      else if (Math.abs((c.quality || 0) - (want || 0)) <= 240) s += 25;
      else s -= 30;

      // source ladder + network tag
      s += SOURCE_PTS[c.sourceTag] ?? 30;
      if (c.network) s += NET_PTS[c.network] ?? 8;

      // seeds, log-scaled so 5000 seeds isn't 50× better than 500
      if (c.kind === 'torrent') s += Math.log10((c.seeds || 0) + 1) * 28;

      // size sanity (continuous)
      s += sizeScore(c.sizeMB || 0, win, maxMB);

      // codec + audio
      if (c.codec === config.preferCodec) s += 15;
      if (c.audio?.some(a => config.audioPref.includes(a))) s += 12;

      // per-episode torrents beat packs for single-episode requests
      if (config.preferEpisodeTorrent && opts.wantSingleEpisode) {
        if (c.isPack) s -= 22; else if (c.isEpisode) s += 20;
      }
      // cached debrid packs are instant — promote hard
      if (c.cached) s += 45;
      if (c.cached && c.isPack && opts.wantSingleEpisode) s += 20;

      if (anime && c.kind === 'torrent') s += 8;             // Nyaa results
      if (/cam|hdcam|hqcam/i.test(c.title || '')) s -= 30;
      if (c.verified) s += 25;

      s *= trustOf(c.provider);
      return { ...c, score: Math.round(s * 100) / 100 };
    })
    .sort((a, b) => b.score - a.score);
}
