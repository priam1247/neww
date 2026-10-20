// src/media/fetch.js — shared download step for commands: picks the right
// downloader (HLS vs HTTP), wires progress events into the chat context.
import fs from 'node:fs';
import { download } from './downloader.js';

export async function downloadFor(res, file, ctx) {
  const onProgress = (got, total) => {
    const pct = total ? `(${Math.round((got / total) * 100)}%)` : '';
    const mb = (got / 1048576).toFixed(0);
    ctx.progress(`⬇️ ${mb} MB ${pct}`);
  };
  await download(res, file, onProgress);
  return file;
}

export { download };
