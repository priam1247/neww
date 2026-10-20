// engine/core/locker.js — resolve "locker" pages into real media links.
//
// The DDL providers (hdhub4u, 4khdhub, moviesdrive) return links to file hosts
// such as hubcloud / gdflix / gdtot / filepress / Google Drive. The shipped
// engine never resolved them: the candidate URL (an HTML page) went straight to
// Real-Debrid, which obviously failed, so the whole DDL tier was dead code.
//
// This module walks those pages (max 4 hops, same-host + known-host only) and
// returns a direct video URL with the Referer the host expects.
import { req, anchors } from './http.js';
import { sniffUrls, sniffRedirect, tryB64, unpack } from './extract.js';
import { log } from './log.js';

const llog = log.child('locker');

const VIDEO_EXT = /\.(mp4|mkv|m4v|webm|mov|avi)(\?|$)/i;
const HLS_EXT = /\.m3u8(\?|$)/i;

// hosts we are willing to follow to
const LOCKER_HOSTS = /hubcloud|hubdrive|gdflix|gdtot|filepress|drive\.google|drive\.usercontent|instantlinks|linksgo|hubcdn|hubstream|hdstream|worker-|cloudflare|r2\.dev|pixeldrain|gofile|1fichier|mega\.nz/i;

const gdrive = (url) => {
  const id = /\/file\/d\/([\w-]{10,})/.exec(url)?.[1]
    || /[?&]id=([\w-]{10,})/.exec(url)?.[1];
  return id ? `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t` : null;
};

/** Pull every plausible media URL out of one page. */
export function mediaUrlsFrom(html, baseUrl = '') {
  const out = new Set();

  // 1. plain / escaped URLs (sniffUrls already decodes \/ and base64)
  for (const u of sniffUrls(html, { exts: ['.mp4', '.mkv', '.m3u8', '.m4v', '.webm'] })) out.add(u);

  // 2. packed payloads (hubcloud & friends love p.a.c.k.e.r)
  const unpacked = unpack(html);
  if (unpacked) for (const u of sniffUrls(unpacked, { exts: ['.mp4', '.mkv', '.m3u8'] })) out.add(u);

  // 3. `var url = "..."` / `sources: [{file:"..."}]` patterns
  for (const m of html.matchAll(/(?:var\s+url|file|src|source|link)\s*[:=]\s*['"]([^'"]{20,})['"]/gi)) {
    let u = m[1];
    if (/^[A-Za-z0-9+/=]{40,}$/.test(u)) u = tryB64(u) || u;
    if (/^https?:\/\//.test(u) && (VIDEO_EXT.test(u) || HLS_EXT.test(u))) out.add(u);
  }

  // 4. anchors that are plainly a video file
  for (const a of anchors(html, baseUrl)) {
    if (VIDEO_EXT.test(a.href) || HLS_EXT.test(a.href)) out.add(a.href);
  }

  return [...out].filter(u => /^https?:\/\//i.test(u));
}

/** Anchor targets that look like the next step of a locker flow. */
function nextHops(html, baseUrl) {
  const out = [];
  for (const a of anchors(html, baseUrl)) {
    const href = a.href;
    if (VIDEO_EXT.test(href) || HLS_EXT.test(href)) continue;
    const label = `${a.text} ${href}`;
    if (/hubcloud|hubdrive|gdflix|gdtot|filepress|instantlinks|linksgo/i.test(href)) out.push(href);
    else if (/download|instant|watch|stream|file/i.test(label) && LOCKER_HOSTS.test(href)) out.push(href);
  }
  // explicit download endpoints used by filepress/gdtot: /download?id=…
  for (const m of html.matchAll(/['"](\/[a-z0-9._-]*\/(?:download|file|drive)[^'"]*)['"]/gi)) {
    try { out.push(new URL(m[1], baseUrl).toString()); } catch { /* ignore */ }
  }
  return [...new Set(out)].slice(0, 6);
}

/**
 * Resolve a locker page to a direct link.
 * @param {{url:string, headers?:object}} cand candidate from a DDL provider
 * @returns {Promise<{url:string, headers:object, sizeMB:number, container?:string}>}
 */
export async function resolveLocker(cand, { maxHops = 4 } = {}) {
  if (!cand?.url) throw new Error('locker: no url');

  const seen = new Set();
  let url = cand.url;
  let referer = cand.headers?.referer || new URL(cand.url).origin;
  let sizeMB = cand.sizeMB || 0;

  for (let hop = 0; hop < maxHops; hop++) {
    if (seen.has(url)) break;
    seen.add(url);

    // direct file already?
    if (VIDEO_EXT.test(url) || HLS_EXT.test(url)) {
      return { url, headers: { referer }, sizeMB };
    }

    // Google Drive needs the download form
    if (/drive\.google|drive\.usercontent/i.test(url)) {
      const dl = gdrive(url);
      if (dl) return { url: dl, headers: { referer }, sizeMB };
    }

    let html = '';
    try {
      const res = await req(url, { json: false, headers: { referer } });
      html = await res.text();
    } catch (e) {
      llog.debug(`locker hop failed ${url}: ${e.message}`);
      throw new Error(`locker unavailable (${e.message})`);
    }

    const media = mediaUrlsFrom(html, url);
    if (media.length) {
      // prefer a muxed mp4/mkv over a manifest when both are present
      const direct = media.find(u => VIDEO_EXT.test(u));
      const chosen = direct || media[0];
      return { url: chosen, headers: { referer: url }, sizeMB };
    }

    // meta-refresh / JS redirect
    const redirect = sniffRedirect(html);
    if (redirect) {
      try {
        const next = new URL(redirect, url).toString();
        if (!seen.has(next)) { referer = url; url = next; continue; }
      } catch { /* ignore */ }
    }

    // walk one hop deeper
    const hops = nextHops(html, url);
    if (!hops.length) break;
    referer = url;
    url = hops[0];
  }

  throw new Error('locker produced no playable link (page layout changed)');
}

export default { resolveLocker, mediaUrlsFrom };
