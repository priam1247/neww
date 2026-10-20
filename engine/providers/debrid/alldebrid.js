// src/providers/debrid/alldebrid.js — AllDebrid client.
import config from '../../config.js';

const API = 'https://api.alldebrid.com/v4';
const H = () => ({ Authorization: `Bearer ${config.allDebridKey}` });
const isVid = (n) => /\.(mp4|mkv|avi|mov|m4v|webm)$/i.test(n || '');
export const pickBiggest = (files) =>
  files.filter(f => isVid(f.path)).sort((a, b) => (b.bytes || 0) - (a.bytes || 0))[0] || null;

export async function resolve(cand, opts) {
  const up = await fetch(`${API}/magnet/upload`, {
    method: 'POST', headers: H(), body: new URLSearchParams({ magnets: cand.magnet }),
    signal: AbortSignal.timeout(20000)
  }).then(r => r.json());
  const id = up?.data?.magnets?.[0]?.id;
  if (!id) throw new Error(up?.error?.message || 'ad upload failed');

  let files;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const st = await fetch(`${API}/magnet/status?id=${id}`, { headers: H(), signal: AbortSignal.timeout(15000) }).then(r => r.json());
    const m = st?.data?.magnets;
    if (m?.statusCode >= 4) {
      files = (m.files || []).map(f => ({ path: f.n, bytes: f.s, id: f.n }));
      break;
    }
  }
  if (!files) throw new Error('ad timeout');

  const chosen = opts.pickEpisode ? opts.pickEpisode(files) : pickBiggest(files);
  if (!chosen) throw new Error('ad no video file');

  const unlocked = await fetch(`${API}/link/unlock?link=${encodeURIComponent(`https://alldebrid.com/f/${id}`)}`, { headers: H() })
    .then(r => r.json()).catch(() => null);

  if (unlocked?.data?.link) return { url: unlocked.data.link, sizeMB: chosen.bytes / 1048576, filename: chosen.path };

  const fl = await fetch(`${API}/magnet/files?id=${id}`, { headers: H() }).then(r => r.json());
  const target = (fl?.data?.magnets?.files || []).find(f => f.n === chosen.path);
  if (!target?.l) throw new Error('ad no link');
  const un = await fetch(`${API}/link/unlock?link=${encodeURIComponent(target.l)}`, { headers: H() }).then(r => r.json());
  return { url: un?.data?.link, sizeMB: chosen.bytes / 1048576, filename: chosen.path };
}

export default { resolve, pickBiggest };
