// src/core/http.js — hardened fetch layer: retry with jitter, deadline hedging,
// per-host inflight limits, shared cookie jar, tiny HTML helpers (replaces cheerio).
//
// Diagnostics matter here: `fetch failed` on its own tells you nothing about
// *why* every provider dies on a datacenter IP. Every failure is normalised to
//   { code, detail }   e.g. DNS, TLS, TIMEOUT, RESET, HTTP_404, CF_WALL
// and logged as a single aligned line: `host · CODE · 1234ms`.
import dns from 'node:dns';
import config from '../config.js';
import Jar from './jar.js';
import { log } from './log.js';

const hlog = log.child('http');

// Datacenter boxes usually break on IPv6 routes (ENETUNREACH / hung connects).
try { dns.setDefaultResultOrder('ipv4first'); } catch { /* older node */ }

/** Map a thrown fetch error onto a short, greppable code. */
export function describeError(e) {
  if (!e) return { code: 'UNKNOWN', detail: 'no error' };
  if (e.status) return { code: `HTTP_${e.status}`, detail: e.message };

  const cause = e.cause || e;
  const raw = `${cause.code || ''} ${cause.message || e.message || ''}`.trim();

  if (/ENOTFOUND|EAI_NODATA/.test(raw)) return { code: 'DNS', detail: 'host does not resolve' };
  if (/EAI_AGAIN/.test(raw)) return { code: 'DNS_TEMP', detail: 'temporary DNS failure' };
  if (/ECONNREFUSED/.test(raw)) return { code: 'REFUSED', detail: 'connection refused' };
  if (/ECONNRESET|EPIPE/.test(raw)) return { code: 'RESET', detail: 'connection reset' };
  if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/.test(raw)) return { code: 'TIMEOUT', detail: 'connect timed out' };
  if (/UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT/.test(raw)) return { code: 'SLOW', detail: 'server too slow' };
  if (/ABORT_ERR|aborted/i.test(raw)) return { code: 'TIMEOUT', detail: 'deadline exceeded' };
  if (/CERT|SELF_SIGNED|TLS|SSL/i.test(raw)) return { code: 'TLS', detail: 'certificate/TLS failure' };
  if (/ENETUNREACH/.test(raw)) return { code: 'NOROUTE', detail: 'network unreachable' };
  if (/invalid JSON/i.test(raw)) return { code: 'BAD_JSON', detail: 'response was not JSON' };
  return { code: 'NETWORK', detail: (cause.message || e.message || 'fetch failed').slice(0, 120) };
}

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

  let host = 'invalid-url';
  try { host = new URL(url).hostname; } catch { throw Object.assign(new Error('bad URL'), { code: 'BAD_URL' }); }
  const t0 = Date.now();
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const started = Date.now();
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
        const ms = Date.now() - started;

        if (res.status === 429 || res.status >= 500) {
          throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, ms });
        }
        if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, ms });

        if (json === 'raw' || json === false) {
          hlog.debug(`${host} OK ${res.status} ${ms}ms`);
          return res;
        }
        const text = await res.text();
        if (/just a moment|cf-challenge|attention required/i.test(text.slice(0, 600))) {
          throw Object.assign(new Error('Cloudflare challenge'), { code: 'CF_WALL', ms });
        }
        try {
          const out = JSON.parse(text);
          hlog.debug(`${host} OK ${res.status} ${ms}ms`);
          return out;
        } catch { throw Object.assign(new Error('invalid JSON response'), { ms }); }
      } finally { release(host); }
    } catch (e) {
      const { code, detail } = describeError(e);
      const ms = Date.now() - started;
      lastErr = Object.assign(e, { code, detail, ms, host });
      const retryable = !(e.status && e.status >= 400 && e.status < 500 && e.status !== 429)
        && code !== 'CF_WALL' && code !== 'BAD_URL';
      if (!retryable) {
        hlog.debug(`${host} ${code} ${ms}ms — ${detail}`);
        break;
      }
      if (attempt < retries) {
        const backoff = 250 * 2 ** attempt + Math.random() * 250;
        hlog.debug(`${host} ${code} ${ms}ms — retry ${attempt + 1}/${retries} in ${Math.round(backoff)}ms`);
        await sleep(backoff);
      } else {
        hlog.debug(`${host} ${code} ${ms}ms — ${detail} (gave up after ${Date.now() - t0}ms)`);
      }
    }
  }
  lastErr.url = url;
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
