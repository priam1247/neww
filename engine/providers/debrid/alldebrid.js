// src/providers/debrid/alldebrid.js — AllDebrid client.
import config from '../../config.js';

const API = 'https://api.alldebrid.com/v4';
const H = () => ({ Authorization: `Bearer ${config.allDebridKey}` });
const isVid = (n) => /\.(mp4|mkv|avi|mov|m4v|webm)$/i.test(n || '');
export const pickBiggest = (files) =>
  files.filter(f => isVid(f.path)).sort((a, b) => (b.bytes || 0) - (a.bytes || 0))[0] || null;

/** Account check (AllDebrid v4 `/user`). */
export async function account() {
  const res = await fetch(`${API}/user?agent=zafar-bot`, {
    headers: H(), signal: AbortSignal.timeout(15000)
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || j?.status === 'error') {
    throw Object.assign(new Error(j?.error?.message || `HTTP ${res.status}`), {
      code: res.status === 401 ? 'BAD_TOKEN' : 'API', status: res.status,
    });
  }
  const u = j?.data?.user || {};
  return {
    provider: 'alldebrid',
    username: u.username || '',
    premium: Boolean(u.isPremium),
    expiration: u.premiumUntil ? new Date(u.premiumUntil * 1000).toISOString().slice(0, 10) : '',
    points: u.points || 0,
    type: u.isPremium ? 'premium' : 'free',
  };
}

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
      // `links` is parallel to `files` — remember it, the old code fabricated
      // an alldebrid.com/f/<id> URL that never resolves.
      files = (m.files || []).map((f, i) => ({
        path: f.n, bytes: f.s, link: (m.links || [])[i] || null,
      }));
      break;
    }
  }
  if (!files) throw new Error('ad timeout');

  const chosen = opts.pickEpisode ? opts.pickEpisode(files) : pickBiggest(files);
  if (!chosen) throw new Error('ad no video file');

  let direct = chosen.link;
  if (!direct) {
    const fl = await fetch(`${API}/magnet/files?id=${id}`, { headers: H() }).then(r => r.json());
    const target = (fl?.data?.magnets?.files || []).find(f => f.n === chosen.path);
    direct = target?.l || null;
  }
  if (!direct) throw new Error('ad no link');

  const un = await fetch(`${API}/link/unlock?link=${encodeURIComponent(direct)}`, { headers: H() })
    .then(r => r.json()).catch(() => null);
  if (!un?.data?.link) throw new Error(un?.error?.message || 'ad unlock failed');
  return { url: un.data.link, sizeMB: chosen.bytes / 1048576, filename: chosen.path };
}

export default { resolve, pickBiggest };
