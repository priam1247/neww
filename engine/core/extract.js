// src/core/extract.js — link decoders. 2.0's file was TRUNCATED mid-function
// in the source archive; 3.0 ships the complete implementation:
//   • full Dean Edwards p.a.c.k.e.r unpacker (any radix, auto-detect)
//   • base64 / hex URL extraction
//   • JS-embedded and meta-refresh URL sniffing
//   • generic tagged-link harvesting for DDL lockers

export function tryB64(s) {
  try {
    const d = Buffer.from(s, 'base64').toString('utf8');
    if (/^https?:\/\//.test(d)) return d;
    if (/^[ -~]{8,}$/.test(d) && /https?:/.test(d)) return /https?:\/\/[^\s"']+/.exec(d)?.[0] || null;
  } catch {}
  return null;
}

export function tryHex(s) {
  if (!/^[0-9a-f]{40,}$/i.test(s) || s.length % 2) return null;
  try {
    const d = Buffer.from(s, 'hex').toString('utf8');
    return /^https?:\/\//.test(d) ? d : null;
  } catch { return null; }
}

// ── Dean Edwards p.a.c.k.e.r unpacker (COMPLETE) ───────────────────────────
const B62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function unbase(n, a) {
  if (n < a) return n < 62 ? B62[n] : '';
  return unbase(Math.floor(n / a), a) + B62[n % a];
}

export function unpack(src) {
  const m = /eval\(function\(p,a,c,k,e,[dr]?\)\{[\s\S]*?\}\(\s*['"]([\s\S]*?)['"]\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*['"]([\s\S]*?)['"]\.split\(['"]\|['"]\)/.exec(src);
  if (!m) return null;

  const [, p, aRaw, cRaw, kRaw] = m;
  const a = parseInt(aRaw, 10);
  const c = parseInt(cRaw, 10);
  const words = kRaw.split('|');

  return p.replace(/\b\w+\b/g, (w) => {
    if (a > 10 || a === 62) {
      // radix-encoded token: decode to an index
      let idx = -1;
      for (let i = 0; i < words.length; i++) {
        if (words[i] === w) { idx = i; break; }
      }
      if (idx !== -1) return words[idx] || w;
      // token isn't in the dict verbatim — decode via base
      let n = 0, ok = true;
      for (const ch of w) {
        const v = B62.indexOf(ch);
        if (v < 0 || v >= a) { ok = false; break; }
        n = n * a + v;
      }
      return ok && n < c ? (words[n] || w) : w;
    }
    // base <= 10: tokens are plain numeric indices
    const n = parseInt(w, 10);
    return Number.isFinite(n) && n < c ? (words[n] || w) : w;
  });
}

// ── generic URL harvesting from JS/HTML blobs ──────────────────────────────
export function sniffUrls(src, { exts = ['.m3u8', '.mpd', '.mp4', '.mkv'] } = {}) {
  const out = new Set();
  // normalize escaped slashes FIRST so "https:\/\/host" matches
  const body = String(src || '').replace(/\\\//g, '/');

  // straight string URLs
  const urlRe = /["'(]((?:https?:)?\/\/[^\s"'()<>]+?\.(?:m3u8|mpd|mp4|mkv)[^\s"'()<>]*)["')]/gi;
  for (const m of body.matchAll(urlRe)) out.add(m[1]);

  // encoded sources
  for (const m of body.matchAll(/["']([A-Za-z0-9+/=]{40,})["']/g)) {
    const d = tryB64(m[1]);
    if (d && exts.some(e => d.includes(e))) out.add(d);
  }
  for (const m of body.matchAll(/["']([0-9a-f]{80,})["']/gi)) {
    const d = tryHex(m[1]);
    if (d && exts.some(e => d.includes(e))) out.add(d);
  }

  // p.a.c.k.e.r payloads
  const unpacked = unpack(body);
  if (unpacked) for (const m of unpacked.matchAll(/(https?:\/\/[^\s"'<>]+)/g)) out.add(m[1]);

  return [...out].filter(u => exts.some(e => u.toLowerCase().includes(e)));
}

// meta refresh / location redirects
export function sniffRedirect(html) {
  const m1 = /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?\d+;\s*url=("?)([^"'>\s]+)\1/i.exec(html);
  if (m1) return m1[2];
  const m2 = /(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i.exec(html);
  return m2 ? m2[1] : null;
}
