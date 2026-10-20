// src/commands/providers.js — /providers — live health table.
import { table } from '../core/registry.js';
import cache from '../core/cache.js';
import { formatBytes } from '../utils/format.js';

export async function run(ctx) {
  const rows = table().sort((a, b) => (a.tier - b.tier) || (b.wins - a.wins));
  const s = cache.stats();
  await ctx.say([
    '🔌 *Provider health*',
    '```',
    'id             t wins fails trust lat   state',
    ...rows.map(r =>
      `${r.id.padEnd(14)} ${r.tier} ${String(r.wins).padStart(4)} ${String(r.fails).padStart(5)} ${String(r.trust).padStart(5)} ${r.latency.padEnd(5)} ${r.state}`),
    '```',
    `🗂️ cache: ${s.files} files · ${formatBytes(s.bytes)} · links ${s.links} · meta ${s.meta}`
  ].join('\n'));
}
