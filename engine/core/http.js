// src/core/http.js — hardened fetch layer: retry with jitter, deadline hedging,
// per-host inflight limits, shared cookie jar, tiny HTML helpers (replaces cheerio).
import config from '../config.js';
import Jar from './jar.js';

export const jar = new Jar();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── per-host inflight limiter (prevents hammering one site) ───────────────
const inflight = new Map();           // host -> current count
const MAX_PER_HOST = Number(process.env.MAX_PER_HOST || 4);
const hostQueue = new Map();          // host -> [waiters]

async function acquire(host) {
  let n = inflight.get(host) || 0;
  if (n < MAX_PER_HOST) { inflight.set(host, n + 1); return; }
  let q = hostQueue.get(host);
  if (!q) { q = []; hostQueue.set(host, q); }        // MUST persist the queue on the map
  await new Promise(res => q.push(res));
  inflight.set(host, (inflight.get(host) || 0) + 1);
}
function release(host) {
  const n = Math.max(0, (inflight.get(host) || 1) - 1);
  inflight.set(host, n);
  const q = hostQueue.get(host);
  if (q?.length) q.shift()();
}

// ── core request with retries + backoff jitter ────────────────────────────
export async function req(url, opts = {}) {
  const {
    timeout = config.providerTimeoutMs,
    retries = 2,
    json = true,
    headers = {},
    cookies = true,                    // attach/send jar cookies automatically
    ...rest
  } = opts;

  const host = new URL(url).hostname;
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await acquire(host);
      try {
        const h = { 'user-agent': config.userAgent, accept: '*/*', ...headers };
        if (cookies) {
          const c = jar.headerFor(url);
          if (c) h.cookie = c;
        }
        const res = await fetch(url, { ...rest, headers: h, signal: AbortSignal.timeout(timeout) });
        if (cookies) jar.set(host, res.headers.getSetCookie?.());
        if (res.status === 429 || res.status >= 500) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
        if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });

        if (json === 'raw') return res;
        if (json === false) return res;
        const text = await res.text();
        try { return JSON.parse(text); }
        catch { throw new Error('invalid JSON response'); }
      } finally { release(host); }
    } catch (e) {
      lastErr = e;
      // 4xx (except 429) are permanent — don't waste retries
      if (e.status && e.status >= 400 && e.status < 500 && e.status !== 429) break;
      if (attempt < retries) await sleep(250 * 2 ** attempt + Math.random() * 250);
    }
  }
  throw lastErr;
}

// ── hedge: fire N promises, collect results until a hard deadline ─────────
export function hedge(promises, deadlineMs) {
  return new Promise(resolve => {
    const out = []; let done = 0;
    const finish = () => resolve(out);
    const timer = setTimeout(() => { clearTimeout(timer); finish(); }, deadlineMs);
    promises.forEach(p => Promise.resolve(p).then(v => {
      if (v) out.push(v);
      if (++done === promises.length) { clearTimeout(timer); finish(); }
    }).catch(() => { if (++done === promises.length) { clearTimeout(timer); finish(); } }));
  });
}

// ── tiny HTML helpers (zero-dep replacement for cheerio) ──────────────────
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export const decodeEntities = (s) => String(s || '')
  .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (ENTITIES[k]) return ENTITIES[k];
    if (k[0] === '#') {
      const code = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return m;
  });

export function anchors(html, baseUrl = '') {
  const out = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const hrefM = /href\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
    if (!hrefM) continue;
    const href = decodeEntities(hrefM[1]);
    const text = decodeEntities(m[2].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
    let abs = href;
    if (baseUrl) { try { abs = new URL(href, baseUrl).toString(); } catch { continue; } }
    out.push({ href: abs, raw: href, text });
  }
  return out;
}

export function pageTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1].replace(/<[^>]*>/g, '')).trim() : '';
}

export function hasText(html, re) { return re.test(html || ''); }
export const sleepMs = sleep;
