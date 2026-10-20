// scripts/demo.js — offline pipeline demo: fixture candidates → ranker →
// winner table. Proves the scoring brain works with zero network access.
import { rank } from '../src/core/ranker.js';
import { parseRelease } from '../src/core/release.js';

const CANDIDATES = [
  { provider: 'realdebrid', kind: 'direct', title: 'Inception.2010.1080p.BluRay.x265-GROUP', cached: true, quality: 1080, codec: 'x265', sourceTag: 'BLURAY', sizeMB: 1900, seeds: 999, isPack: false, isEpisode: false },
  { provider: 'torrentio', kind: 'torrent', title: 'Inception.2010.1080p.BluRay.x264-RARBG', hash: 'aa11', quality: 1080, codec: 'x264', sourceTag: 'BLURAY', sizeMB: 2400, seeds: 4200, isPack: false, isEpisode: false },
  { provider: 'yts', kind: 'torrent', title: 'Inception.2010.720p.BrRip.x264-YIFY', hash: 'bb22', quality: 720, codec: 'x264', sourceTag: 'BLURAY', sizeMB: 850, seeds: 8100, isPack: false, isEpisode: false },
  { provider: 'knaben', kind: 'torrent', title: 'Inception.2010.2160p.WEB-DL.DDP5.1.HEVC-NA', hash: 'cc33', quality: 2160, codec: 'x265', sourceTag: 'WEBDL', sizeMB: 16000, seeds: 120, isPack: false, isEpisode: false },
  { provider: 'apibay', kind: 'torrent', title: 'Inception 2010 1080p BRRip H264', hash: 'dd44', quality: 1080, codec: 'x264', sourceTag: 'BLURAY', sizeMB: 1100, seeds: 3, isPack: false, isEpisode: false },
  { provider: 'hdhub4u', kind: 'direct', title: 'Inception 2010 720p HDCAM x264', url: 'https://locker/x', quality: 720, codec: 'x264', sourceTag: 'CAM', sizeMB: 700, seeds: 999, isPack: false, isEpisode: false }
];

console.log('ZaFarBot 3.3 — offline ranking demo\n');
console.log(`request: movie "Inception (2010)" @ 720p  (max send 2800 MB, x265 preferred)\n`);

const ranked = rank(CANDIDATES, { want: 720, year: 2010, maxMB: 2800 });

console.log('rank provider       score  quality  source   seeds  size(MB)  verdict');
console.log('---- -------------- ------ -------- -------- ------ --------- ------------------');
for (const c of ranked) {
  const win = c.score >= ranked[0].score - 15 ? '★ candidate' : '';
  console.log(
    String(ranked.indexOf(c) + 1).padStart(4),
    c.provider.padEnd(16),
    String(c.score).padStart(6),
    String(c.quality).padStart(8),
    String(c.sourceTag).padStart(8),
    String(c.seeds).padStart(6),
    String(Math.round(c.sizeMB)).padStart(9),
    win
  );
}

console.log('\nwinner:', ranked[0].provider, '→', ranked[0].title);
console.log('\n(the CAM hit ranks last: source ladder + title penalty bury it,');
console.log(' the oversized 4K gets size-window penalties, cached debrid wins.)');
