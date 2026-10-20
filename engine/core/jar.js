// src/core/jar.js — minimal per-host cookie jar.
// Several DDL lockers bind the final link to the session cookie set on the
// landing page — without this you get a 403. Parent-domain lookup included
// (cookie set on .example.com must reach cdn.example.com).
export default class Jar {
  constructor() { this.store = new Map(); }

  set(host, setCookie) {
    if (!setCookie) return;
    const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
    const bucket = this.store.get(host) || new Map();
    for (const c of arr) {
      const [pair] = String(c).split(';');
      const i = pair.indexOf('=');
      if (i < 1) continue;
      bucket.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    this.store.set(host, bucket);
  }

  header(host) {
    const b = this.store.get(host);
    if (!b || !b.size) return null;
    return [...b.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  headerFor(url) {
    try {
      const h = new URL(url).hostname;
      const parts = h.split('.');
      for (let i = 0; i < parts.length - 1; i++) {
        const c = this.header(parts.slice(i).join('.'));
        if (c) return c;
      }
      return null;
    } catch { return null; }
  }
}
