// src/core/metrics.js — lightweight counters + latency tracking, renderable
// as a WhatsApp-friendly text dashboard (/stats). Zero deps, zero I/O.
const counters = new Map();        // name+tags -> value
const timings = new Map();         // name -> { count, totalMs, max }
const startedAt = Date.now();

const keyOf = (name, tags) => name + (tags ? '|' + Object.entries(tags).map(([k, v]) => `${k}=${v}`).sort().join(',') : '');

export const metrics = {
  bump(name, tags = {}, by = 1) {
    const k = keyOf(name, tags);
    counters.set(k, (counters.get(k) || 0) + by);
  },
  time(name, ms) {
    const t = timings.get(name) || { count: 0, totalMs: 0, max: 0 };
    t.count++; t.totalMs += ms; t.max = Math.max(t.max, ms);
    timings.set(name, t);
  },
  snapshot() {
    return {
      uptimeMs: Date.now() - startedAt,
      counters: Object.fromEntries(counters),
      timings: Object.fromEntries([...timings].map(([k, v]) => [k, {
        count: v.count, avgMs: Math.round(v.totalMs / v.count), maxMs: Math.round(v.max)
      }]))
    };
  },
  // plain-text dashboard (monospace block for WhatsApp)
  render() {
    const s = this.snapshot();
    const up = Math.floor(s.uptimeMs / 60000);
    const get = (n) => s.counters[n] || 0;
    const lines = [
      '📊 *Engine stats*',
      '```',
      `uptime      ${up}m`,
      `searches    ${get('search.ok')} ok / ${get('search.empty')} empty`,
      `resolves    ${get('resolve.ok')} ok / ${get('resolve.fail')} fail`,
      `cache hits  disk ${get('cache.disk')} · link ${get('cache.link')} · meta ${get('cache.meta')}`,
      `tier wins   t0 ${get('tier.0')} · t1 ${get('tier.1')} · t2 ${get('tier.2')} · t3 ${get('tier.3')}`,
      `bytes down  ${((get('download.bytes') || 0) / 1073741824).toFixed(2)} GB`,
      `verified    ${get('verify.ok')} ok / ${get('verify.fail')} reject`
    ];
    for (const [name, t] of Object.entries(s.timings)) {
      lines.push(`${name.padEnd(11)} avg ${t.avgMs}ms · max ${t.maxMs}ms · n=${t.count}`);
    }
    lines.push('```');
    return lines.join('\n');
  },
  _reset() { counters.clear(); timings.clear(); }
};
