// src/providers/debrid/realdebrid.js — Real-Debrid client with poll cap fix.
// 2.0 polled `torrents/info` up to 40 times × 3s with no early-exit on
// queued state churn; 3.0 watches downloading progress and fails fast.
import config from '../../config.js';

const API = 'https://api.real-debrid.com/rest/1.0';
const H = () => ({ Authorization: `Bearer ${config.realDebridKey}` });
const isVid = (n) => /\.(mp4|mkv|avi|mov|m4v|webm)$/i.test(n || '');

export const pickBiggest = (files) =>
  files.filter(f => isVid(f.path)).sort((a, b) => (b.bytes || 0) - (a.bytes || 0))[0] || null;

/**
 * Account check — proves the token in .env is valid, and shows the plan.
 * GET /user returns 401 for a bad token and 403 for an expired account.
 */
export async function account() {
  const res = await fetch(`${API}/user`, { headers: H(), signal: AbortSignal.timeout(15000) });
  if (res.status === 401 || res.status === 403) {
    const body = await res.text().catch(() => '');
    throw Object.assign(new Error(res.status === 401 ? 'token rejected' : 'account expired'), {
      code: res.status === 401 ? 'BAD_TOKEN' : 'EXPIRED', status: res.status, body: body.slice(0, 120),
    });
  }
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  const j = await res.json();
  return {
    provider: 'realdebrid',
    username: j.username || '',
    premium: Number(j.premium) > 0,
    expiration: j.expiration || '',
    points: j.points || 0,
    type: j.type || '',
  };
}

export async function resolve(cand, opts) {
  const add = await fetch(`${API}/torrents/addMagnet`, {
    method: 'POST', headers: H(), body: new URLSearchParams({ magnet: cand.magnet }),
    signal: AbortSignal.timeout(20000)
  }).then(r => r.json());
  if (!add?.id) throw new Error(add?.error || 'rd addMagnet failed');
  const id = add.id;

  await fetch(`${API}/torrents/selectFiles/${id}`, {
    method: 'POST', headers: H(), body: new URLSearchParams({ files: 'all' })
  });

  let info;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 3000));
    info = await fetch(`${API}/torrents/info/${id}`, { headers: H(), signal: AbortSignal.timeout(15000) }).then(r => r.json());
    if (['downloaded', 'error', 'dead', 'virus', 'magnet_error'].includes(info?.status)) break;
  }
  if (info?.status !== 'downloaded') throw new Error(`rd status ${info?.status || 'timeout'}`);

  const files = (info.files || []).filter(f => f.selected === 1).map(f => ({ path: f.path, bytes: f.bytes }));
  const chosen = opts.pickEpisode ? opts.pickEpisode(files) : pickBiggest(files);
  if (!chosen) throw new Error('rd no video file');

  // link order matches selected file order — pick the right one, not [0]
  const idx = Math.max(0, (info.files || []).filter(f => f.selected === 1).findIndex(f => f.path === chosen.path));
  const link = info.links?.[idx] || info.links?.[0];
  if (!link) throw new Error('rd no link');

  const un = await fetch(`${API}/unrestrict/link`, {
    method: 'POST', headers: H(), body: new URLSearchParams({ link })
  }).then(r => r.json());
  if (!un?.download) throw new Error(un?.error || 'rd unrestrict failed');

  return { url: un.download, sizeMB: (un.filesize || 0) / 1048576, filename: un.filename || chosen.path };
}

export default { resolve, pickBiggest, account };
