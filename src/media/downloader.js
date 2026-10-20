// src/media/downloader.js — thin wrapper choosing HLS vs HTTP download path.
import { httpToFile, hlsToFile } from './download.js';

export async function download(res, file, onProgress) {
  if (res.kind === 'hls') return hlsToFile(res.url, file, onProgress);
  return httpToFile(res.url, file, { onProgress });
}
