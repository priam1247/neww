#!/usr/bin/env node
/**
 * Build a local IMDb index from the official datasets (optional, complete).
 *
 *   node scripts/imdb-index.js                 # download title.basics.tsv.gz (~200 MB) and build
 *   node scripts/imdb-index.js --file dump.tsv.gz
 *   node scripts/imdb-index.js --out temp/imdb-index.tsv
 *
 * Why: every metadata API in engine/metadata can be rate-limited, geo-blocked or
 * simply down. The IMDb bulk dump cannot. With this index on disk the bot can
 * always turn a title into an imdb id (which is what the torrent indexers need),
 * completely offline.
 *
 * Output is a small plain-TSV, sorted by popularity-ish order (movies first),
 * queried by engine/metadata/imdb.js:
 *
 *   <imdbId>\t<movie|series>\t<Title>\t<title lower>\t<year>
 *
 * The dump is streamed with zlib, so RAM stays flat (~50 MB regardless of size).
 * Re-run it whenever you want fresher data — the engine picks up a new file
 * automatically (no restart needed).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const readline = require('readline');

const URL_DUMP = 'https://datasets.imdbws.com/title.basics.tsv.gz';
const KEEP_TYPES = new Set(['movie', 'tvSeries', 'tvMiniSeries', 'tvMovie', 'short']);

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const OUT = arg('--out', path.join('temp', 'imdb-index.tsv'));
const FILE = arg('--file', '');
const LIMIT = Number(arg('--limit', '0')) || 0;          // 0 = everything

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u, redirects = 0) => {
      https.get(u, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
          res.resume();
          return get(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          res.resume();
          return;
        }
        const total = Number(res.headers['content-length'] || 0);
        let seen = 0;
        res.on('data', (c) => {
          seen += c.length;
          if (total) {
            const pct = Math.round((seen / total) * 100);
            if (pct % 10 === 0) process.stdout.write(`\r  downloading ${pct}% (${(seen / 1048576).toFixed(0)} MB)`);
          }
        });
        res.pipe(file);
        file.on('finish', () => { file.close(); process.stdout.write('\r  download complete          \n'); resolve(dest); });
      }).on('error', reject);
    };
    get(url);
  });
}

async function build(src) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const tmpOut = `${OUT}.tmp`;
  const out = fs.createWriteStream(tmpOut);

  const input = src.endsWith('.gz') ? fs.createReadStream(src).pipe(zlib.createGunzip()) : fs.createReadStream(src);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  let header = true;
  let written = 0;
  let scanned = 0;
  const want = (row) => row && KEEP_TYPES.has(row[1]) && row[2] === '0' && row[5] !== '\\N';

  for await (const line of rl) {
    if (header) { header = false; continue; }          // tconst\ttitleType\tprimaryTitle...
    scanned++;
    const row = line.split('\t');
    if (!want(row)) continue;

    const [tconst, kind, primary, , , year] = row;
    const type = kind === 'movie' || kind === 'short' || kind === 'tvMovie' ? 'movie' : 'series';
    const lower = primary.toLowerCase().replace(/\t/g, ' ');
    out.write(`${tconst}\t${type}\t${primary}\t${lower}\t${year}\n`);
    written++;

    if (scanned % 250000 === 0) process.stdout.write(`\r  scanned ${(scanned / 1e6).toFixed(1)}M titles · kept ${written}`);
    if (LIMIT && written >= LIMIT) break;
  }

  rl.close();
  await new Promise(r => out.end(r));
  fs.renameSync(tmpOut, OUT);
  console.log(`\n✅ index written: ${OUT}`);
  console.log(`   ${written.toLocaleString()} titles (${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB)`);
  console.log('   the bot uses it automatically; no restart needed');
}

(async () => {
  let src = FILE;
  if (!src) {
    src = path.join('temp', 'title.basics.tsv.gz');
    fs.mkdirSync(path.dirname(src), { recursive: true });
    if (!fs.existsSync(src)) {
      console.log(`⬇️  ${URL_DUMP}`);
      await download(URL_DUMP, src);
    } else {
      console.log(`↻ reusing ${src}`);
    }
  }
  if (!fs.existsSync(src)) throw new Error(`file not found: ${src}`);
  console.log(`📦 building from ${src}`);
  await build(src);
})().catch((e) => {
  console.error(`\n❌ ${e.message}`);
  process.exit(1);
});
