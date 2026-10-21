// engine/media/downloader.js — thin wrapper choosing HLS vs HTTP download path.
import { httpToFile, hlsToFile } from './download.js';
import { torrentToFile } from './torrent.js';
import config from '../config.js';

/**
 * @param {{url:string, kind?:string, headers?:object}} res resolved source
 * @param {string} file destination path
 * @param {(got:number,total:number)=>void} [onProgress]
 */
export async function download(res, file, onProgress) {
  if (!res?.url && !res?.magnet) throw new Error('nothing to download (no link)');
  if (res.kind === 'torrent') {
    return torrentDownloader(res.magnet || res.url, file, {
      onProgress,
      fileIdx: res.fileIdx,
      season: res.season,
      episode: res.episode,
      maxMB: config.maxDownloadMB
    });
  }
  if (res.kind === 'hls') {
    return hlsToFile(res.url, file, onProgress, { headers: res.headers, maxHeight: res.quality });
  }
  return httpToFile(res.url, file, { onProgress, headers: res.headers });
}

let torrentDownloader = torrentToFile;
export const _setTorrentDownloaderForTests = (fn) => { torrentDownloader = fn || torrentToFile; };
