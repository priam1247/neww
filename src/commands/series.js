// src/commands/series.js — /series <title> s01e03 [quality] | range 1-6 | full
import fs from 'node:fs';
import config from '../config.js';
import media from '../media/index.js';
import queue from '../core/queue.js';
import cache from '../core/cache.js';
import { formatBytes, pad } from '../utils/format.js';
import { parseSeriesRequest } from '../core/tv.js';
import { setPending, getPending, clearPending, renderOptions } from '../bot/pending.js';
import { downloadFor } from '../media/fetch.js';
import { log } from '../core/log.js';

const clog = log.child('cmd.series');
const QUAL = /^(480|720|1080|2160|4k)$/i;

export const help = (P) => [
  `📺 *${config.botName} — Series*`,
  '',
  `*${P}series <title> s01e03* — single episode (default)`,
  `*${P}series <title> s01e03 1080*`,
  `*${P}series <title> s01 range 1-6* — batch episodes`,
  `*${P}series <title> s01 full* — whole season (cached packs)`,
  `*${P}series pick <n>* — disambiguate`,
  '',
  `_Episodes download one at a time — never a whole season you don't need._`
].join('\n');

export async function run(ctx, args) {
  const P = config.prefix;
  const sub = (args[0] || '').toLowerCase();

  if (!sub || sub === 'help') return ctx.say(help(P));

  if (sub === 'pick') {
    const n = parseInt(args[1], 10);
    const p = getPending(ctx.jid);
    if (!p || p.kind !== 'series' || !n) return ctx.say('Nothing to pick.');
    const c = p.matches[n - 1];
    if (!c) return ctx.say('Bad number.');
    clearPending(ctx.jid);
    return deliver(ctx, { ...p.ctx, meta: c });
  }

  // cooldown: 8s per chat
  const cd = ctx.cooldown('series', 8000);
  if (cd) return ctx.say('⏳ one sec…');

  const quality = (args.find(a => QUAL.test(a)) || '720').replace('4k', '2160');
  const rest = args.filter(a => !QUAL.test(a)).join(' ');
  const req = parseSeriesRequest(rest);
  if (!req.title) return ctx.say(help(P));

  const year = /(19|20)\d{2}/.exec(rest)?.[0];
  await ctx.say(`🔍 Resolving *${req.title}*…`);

  let matches;
  try { matches = await media.tmdb.searchTv(req.title, year); }
  catch (e) { return ctx.say(`❌ ${e.message}`); }
  if (!matches.length) return ctx.say(`❌ No series found for *${req.title}*.`);

  if (matches.length > 1 && !year) {
    setPending(ctx.jid, { kind: 'series', matches: matches.slice(0, 5), ctx: { quality, ...req, year } });
    return ctx.say([`📺 Multiple matches:`, renderOptions(matches.slice(0, 5)), '', `Reply *${P}series pick <n>*`].join('\n'));
  }

  return deliver(ctx, { quality, ...req, year, meta: matches[0] });
}

async function deliver(ctx, job) {
  try {
    const meta = await media.tmdb.tvDetails(job.meta.tmdbId);
    const season = job.season || 1;

    if (job.full || (job.epStart === 1 && job.epEnd === 0)) {
      return deliverSeason(ctx, meta, season, job.quality);
    }

    const from = job.epStart || 1;
    const to = Math.min(job.epEnd || from, from + 19);       // safety cap: 20 eps/batch
    const list = [];
    for (let e = from; e <= to; e++) list.push(e);

    await ctx.say(`📺 *${meta.title}* S${pad(season)} — ${list.length} episode(s) @ ${job.quality}p\nSource: per-episode, cascade 14 providers.`);

    for (const ep of list) {
      try {
        const pos = queue.position(ctx.jid);
        if (pos) await ctx.say(`⏳ Queued S${pad(season)}E${pad(ep)} (position ${pos})`);

        const res = await queue.add(ctx.jid, `${meta.title} E${ep}`, () =>
          media.resolveEpisode({ title: meta.title, year: meta.year, season, episode: ep, quality: job.quality }));

        if (config.dryRun) {
          await ctx.say(`🔗 S${pad(season)}E${pad(ep)} (dry-run): ${res.url}`);
          continue;
        }

        if (res.sizeMB > config.maxSendMB) {
          await ctx.say(`📦 S${pad(season)}E${pad(ep)} too large to send (${res.sizeMB.toFixed(0)} MB)\n🔗 ${res.url}`);
          continue;
        }

        const file = media.targetFile(meta.title, meta.year, job.quality, season, ep);
        await downloadFor(res, file, ctx);

        const size = fs.statSync(file).size;
        cache.fset(cache.keyOf(meta.imdbId, season, ep, job.quality), {
          file, sizeMB: size / 1048576, title: `${meta.title} S${pad(season)}E${pad(ep)}`, quality: job.quality
        });

        await ctx.sendDoc(file, `📺 *${meta.title}* — S${pad(season)}E${pad(ep)}\n💾 ${formatBytes(size)} · ${job.quality}p\n📡 ${res.provider} (tier ${res.tier})`);
      } catch (e) {
        clog.warn(`S${season}E${ep} failed:`, e.message);
        await ctx.say(`❌ S${pad(season)}E${pad(ep)}: ${e.message}`);
      }
    }
  } catch (e) {
    clog.warn('series failed:', e.message);
    await ctx.say(`❌ ${e.message}`);
  }
}

async function deliverSeason(ctx, meta, season, quality) {
  await ctx.say(`📺 *${meta.title}* S${pad(season)} full — looking for a debrid-cached pack…`);
  const res = await queue.add(ctx.jid, `${meta.title} S${season}`, () =>
    media.resolveSeason({ title: meta.title, year: meta.year, season, quality }));

  if (config.dryRun) return ctx.say(`🔗 ${res.url} (dry-run)`);
  if (res.sizeMB > config.maxSendMB) {
    await ctx.say(`📦 pack too large to send as a file (${(res.sizeMB || 0).toFixed(0)} MB)\n🔗 ${res.url}`);
    return;
  }
  await ctx.say(`📦 season pack ready: ${res.url}`);
}
