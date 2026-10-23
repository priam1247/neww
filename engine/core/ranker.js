// engine/core/ranker.js — reliability-first candidate scoring.
//  • MovieBox (#1) wins at matching resolutions, including large multi-GB encodes
//  • Explicit provider reliability order across all stream & torrent fallbacks
//  • Continuous size scoring, source ladder, log-scaled seeds, CAM rejection
//  • Runtime circuit-breaker trust multiplier (`trustOf`)
import config from '../config.js';
import { trustOf } from './registry.js';
import { reliabilityBonus, reliabilityRank } from './reliability.js';

const SOURCE_PTS = { REMUX: 100, BLURAY: 80, WEBDL: 70, WEBRIP: 55, HDTV: 40, HDRIP: 35, DVDRIP: 30, CAM: 10, UNKNOWN: 30 };
const NET_PTS = { NF: 18, AMZN: 14, DSNP: 16, ATVP: 14, MAX: 12, HMAX: 12 };
const CAM_RELEASE_RX = /\b(?:CAM|HDCAM|CAMRIP|HQCAM|TELESYNC|HDTS)\b/i;
const TS_TC_RX = /(?:^|[.\s-]|\[|\])(?:TS|TC)(?=$|[.\s-]|\[|\])/;
export const isCamRelease = (c) => {
  const release = `${c.title || ''} ${c.sourceTag || ''}`;
  return CAM_RELEASE_RX.test(release) || TS_TC_RX.test(release);
};

export function isOld(year) {
  return year && (new Date().getFullYear() - Number(year)) > config.oldYearThreshold;
}

// continuous size score: peak inside the window, gentle falloff outside
function sizeScore(sizeMB, win, maxMB, isFastCdn = false) {
  const [lo, hi] = win;
  if (sizeMB >= lo && sizeMB <= hi) return 35;
  if (isFastCdn && sizeMB >= lo && sizeMB <= (config.maxDownloadMB || maxMB)) {
    return 35; // MovieBox direct CDN handles multi-GB files fast without penalty
  }
  const over = sizeMB > hi;
  const dist = over ? sizeMB - hi : lo - sizeMB;
  const span = hi - lo;
  const rel = dist / Math.max(1, span);
  let s = rel <= 0.25 ? 0 : -15 - Math.min(30, rel * 25);
  if (sizeMB > maxMB) s -= 25;
  return s;
}

export function rank(cands, opts = {}) {
  const { want, year, maxMB = config.maxSendMB, anime = false } = opts;
  const preferred = new Set((config.preferProviders || ['moviebox']).map((p) => String(p).toLowerCase()));
  // A preferred provider jumps the queue when its file matches the requested
  // resolution — a 480p stream never beats a real 1080p when 1080p was asked for.
  const isPreferred = (c) => preferred.has(String(c.provider || '').toLowerCase())
    && (!want || Math.abs((c.quality || 0) - want) <= 240);
  const win = config.sizeWindow[want] || [0, Infinity];
  const seedFloor = isOld(year) ? config.minSeedsOld : config.minSeeds;

  const hasNonCam = cands.some(c => !isCamRelease(c));
  return cands
    .filter(c => !hasNonCam || !isCamRelease(c))
    .filter(c => c.kind !== 'torrent' || (c.seeds ?? 0) >= seedFloor)
    .map(c => {
      let s = 0;
      const provId = String(c.provider || '').toLowerCase();

      // resolution
      if (want) {
        if (c.quality === want) s += 70;
        else if (Math.abs((c.quality || 0) - want) <= 240) s += 25;
        else s -= 30;
      } else if (c.quality) {
        s += Math.min(35, Math.round(c.quality / 60));
      }

      // provider reliability tier bonus (#1 moviebox -> #14 apibay)
      s += reliabilityBonus(provId);

      // source ladder + network tag
      s += SOURCE_PTS[c.sourceTag] ?? 30;
      if (c.network) s += NET_PTS[c.network] ?? 8;

      // seeds, log-scaled so 5000 seeds isn't 50× better than 500
      if (c.kind === 'torrent') s += Math.log10((c.seeds || 0) + 1) * 28;

      // size sanity — MovieBox fast direct MP4 is not punished for multi-GB size
      if (c.kind === 'hls' || !c.sizeMB) s += 10;
      else s += sizeScore(c.sizeMB, win, maxMB, provId === 'moviebox');

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

      if (anime && c.kind === 'torrent') s += 8;
      if (/cam|hdcam|hqcam/i.test(c.title || '')) s -= 30;
      if (c.verified) s += 25;

      s *= trustOf(c.provider);
      return {
        ...c,
        score: Math.round(s * 100) / 100,
        preferred: isPreferred(c),
        relRank: reliabilityRank(provId),
      };
    })
    .sort((a, b) => {
      if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      return a.relRank - b.relRank;
    });
}
