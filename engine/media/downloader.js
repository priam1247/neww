// engine/media/downloader.js — thin wrapper choosing HLS vs HTTP download path.
import { httpToFile, hlsToFile } from './download.js';

/**
 * @param {{url:string, kind?:string, headers?:object}} res resolved source
 * @param {string} file destination path
 * @param {(got:number,total:number)=>void} [onProgress]
 */
export async function download(res, file, onProgress) {
  if (!res?.url) throw new Error('nothing to download (no link)');
  if (res.kind === 'hls') {
    return hlsToFile(res.url, file, onProgress, { headers: res.headers, maxHeight: res.quality });
  }
  return httpToFile(res.url, file, { onProgress, headers: res.headers });
}
