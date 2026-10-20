// src/commands/movie.js — /movie <title> [year] [quality]
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import media from '../media/index.js';
import queue from '../core/queue.js';
import cache from '../core/cache.js';
import { formatBytes } from '../utils/format.js';
import { setPending, getPending, clearPending, renderOptions } from '../bot/pending.js';
import { downloadFor } from '../media/fetch.js';
import { log } from '../core/log.js';

const clog = log.child('cmd.movie');
const QUAL = /^(480|720|1080|2160|4k)$/i;

export const help = (P) => `🎬 *${config.botName} — Movie*\n\n*${P}movie <title> [year] [quality]*\ne.g. \`${P}movie inception 2010 1080\``;

export async function run(ctx, args) {
  const P = config.prefix;

  if (!args.length) return ctx.say(help(P));

  if (args[0] === 'pick') {
    const n = parseInt(args[1], 10);
    const p = getPending(ctx.jid);
    if (!p || p.kind !== 'movie' || !n) return ctx.say('Nothing to pick.');
    const c = p.matches[n - 1];
    if (!c) return ctx.say('Bad number.');
    clearPending(ctx.jid);
    return deliver(ctx, { ...p, meta: c });
  }

  const quality = (args.find(a => QUAL.test(a)) || '720').replace('4k', '2160');
  const rest = args.filter(a => !QUAL.test(a)).join(' ').trim();
  const year = /(19|20)\d{2}/.exec(rest)?.[0];
  const title = rest.replace(/\b(19|20)\d{2}\b/, '').trim();
  if (!title) return ctx.say(help(P));

  await ctx.say(`🔍 Searching *${title}*…`);
  let matches;
  try { matches = await media.tmdb.searchMovie(title, year); }
  catch (e) { return ctx.say(`❌ ${e.message}`); }
  if (!matches.length) return ctx.say('❌ Not found.');

  if (matches.length > 1 && !year) {
    setPending(ctx.jid, { kind: 'movie', matches: matches.slice(0, 5), quality });
    return ctx.say([`🎬 Multiple matches:`, renderOptions(matches.slice(0, 5)), '', `Reply *${P}movie pick <n>*`].join('\n'));
  }

  return deliver(ctx, { quality, meta: matches[0] });
}

async function deliver(ctx, job) {
  try {
    const meta = await media.tmdb.movieDetails(job.meta.tmdbId);
    await ctx.edit(`📡 *${meta.title} (${meta.year})* ${job.quality}p\n⏳ cascading 14 providers…`);

    const res = await queue.add(ctx.jid, meta.title, () =>
      media.resolveMovie({ title: meta.title, year: meta.year, quality: job.quality }));

    if (config.dryRun) {
      return ctx.edit(`🔗 *${meta.title} (${meta.year})* (dry-run)\n${res.url}\n📡 ${res.provider} (tier ${res.tier})`);
    }

    const file = media.targetFile(meta.title, meta.year, job.quality);
    if (res.sizeMB > config.maxSendMB) {
      await ctx.edit(`📦 too large to send (${res.sizeMB.toFixed(0)} MB)\n🔗 ${res.url}`);
      return;
    }
    await ctx.edit(`⬇️ downloading *${meta.title}*…`);
    await downloadFor(res, file, ctx);

    const size = fs.statSync(file).size;
    cache.fset(cache.keyOf(meta.imdbId, null, null, job.quality), {
      file, sizeMB: size / 1048576, title: `${meta.title} (${meta.year})`, quality: job.quality
    });

    await ctx.sendDoc(file, `🎬 *${meta.title} (${meta.year})*\n💾 ${formatBytes(size)} · ${job.quality}p\n📡 ${res.provider} (tier ${res.tier})`);
    await ctx.edit(`✅ *${meta.title} (${meta.year})* sent`);
  } catch (e) {
    clog.warn('movie failed:', e.message);
    await ctx.edit(`❌ ${e.message}`);
  }
}
