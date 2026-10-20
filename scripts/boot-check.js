// scripts/boot-check.js — boot the engine, list registered providers, exit.
process.env.TMDB_API_KEY = process.env.TMDB_API_KEY || 'ci-test';

const media = await import('../src/media/index.js');
const { table } = await import('../src/core/registry.js');

await media.boot();
console.log('boot OK — registered providers:');
for (const r of table()) {
  console.log(`   t${r.tier}  ${r.id.padEnd(15)} ${r.kind}`);
}
const rows = table();
if (rows.length < 13) { console.error(`expected >= 13 providers, got ${rows.length}`); process.exit(1); }
console.log(`\ntotal: ${rows.length} providers ✓`);
