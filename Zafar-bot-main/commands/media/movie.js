/**
 * ZaFar Bot — .movie  (download a movie)
 *
 *   .movie <title> [year] [480|720|1080|2160]
 *   .movie <title>            → 720p by default
 *
 * Flow: TMDB search (numbered picker when the title is ambiguous) → the engine
 * cascades torrent → DDL → stream sources → the file is streamed to disk with
 * live progress → handed to the bot's own delivery path (`utils/movieHost`):
 * playable video when small, document when big, Drime Cloud link when it is
 * too large for WhatsApp → kept in the LRU cache for instant resends.
 *
 * Everything heavy runs inside the engine's fair queue, so a movie download can
 * never starve .song/.paper or another chat.
 */

const fs = require('fs');
const path = require('path');
const config = require('../../config');
const engine = require('../../utils/movieEngine');
const selections = require('../../utils/selections');
const { progressCard, progressLine } = require('../../utils/cards');
const host = require('../../utils/movieHost');

const QUALITY_RX = /^(480|720|1080|2160|4k)$/i;
const MOVIES = () => config.movies || {};

const qualityOf = (token) => {
  const t = String(token || '').toLowerCase();
  if (t === '4k') return 2160;
  return Number(t);
};

function parseArgs(args) {
  const rest = [];
  // default quality follows the bot: config.movies → media settings → config.video
  let quality = MOVIES().defaultQuality || host.defaultQuality();

  for (const a of args) {
    if (QUALITY_RX.test(a)) { quality = qualityOf(a); continue; }
    rest.push(a);
  }

  const text = rest.join(' ').trim();

  // Pick the last plausible year that still leaves a title behind, so films
  // whose name IS a year ("1917", "2012") keep it.
  let year = null;
  let title = text;
  const yearTokens = [...text.matchAll(/\b((?:19|20)\d{2})\b/g)].map(m => m[1]);
  for (const y of yearTokens.reverse()) {
    const without = text.replace(new RegExp(`\\b${y}\\b`), '').replace(/\s+/g, ' ').trim();
    if (without) {
      year = y;
      title = without;
      break;
    }
  }

  return { title, year, quality };
}

const help = (P) =>
  `🎬 *Movies*\n\n` +
  `*${P}movie <title> [year] [quality]*\n` +
  `e.g.  ${P}movie inception 2010 1080\n` +
  `      ${P}movie dune 2021\n\n` +
  `qualities: 480 · 720 · 1080 · 2160 (4k)\n` +
  `_ambiguous titles show a numbered list — reply with the number_`;

/** Render the TMDB match list and offer a numbered pick. */
async function offerChoices(sock, msg, extra, matches, job, kind) {
  const list = matches.slice(0, 6);
  const lines = list.map((m, i) => `*${i + 1}.* ${m.title} (${m.year || '—'})`);
  const text = `🎬 *${list.length} matches* — reply with a number\n\n${lines.join('\n')}\n\n_or reply *cancel*_`;

  if (list[0]?.poster) {
    await sock.sendMessage(extra.from, { image: { url: list[0].poster }, caption: text }, { quoted: msg })
      .catch(() => sock.sendMessage(extra.from, { text }, { quoted: msg }));
  } else {
    await sock.sendMessage(extra.from, { text }, { quoted: msg });
  }

  selections.offer({
    chatId: extra.from,
    sender: extra.sender || msg.key.participant || extra.from,
    items: list,
    label: kind,
    ttlMs: 5 * 60 * 1000,
    run: (sock2, msg2, extra2, item) => deliver(sock2, msg2, extra2, item, job),
  });
}

/** Resolve → download → send. */
async function deliver(sock, msg, extra, meta, job) {
  const chatId = extra.from;
  const quality = job.quality;
  const reply = (t) => sock.sendMessage(chatId, { text: t }, { quoted: msg });

  const card = progressCard(sock, chatId, msg,
    `🎬 *${meta.title}${meta.year ? ` (${meta.year})` : ''}* · ${quality}p\n🔎 searching sources…`);

  try {
    // resolve + download inside ONE queue slot: concurrency stays 1, so a
    // second movie waits instead of competing for bandwidth/disk
    const label = `🎬 *${meta.title}${meta.year ? ` (${meta.year})` : ''}* · ${quality}p`;
    const jobResult = await engine.enqueue(chatId, `movie ${meta.title} ${quality}p`, async () => {
      const resolved = await engine.resolveMovie({
        item: meta, tmdbId: meta.tmdbId, title: meta.title, year: meta.year, quality,
      });

      if (MOVIES().dryRun) return { res: resolved, file: null };

      // The download cap is not WhatsApp's send cap: big files are handed to
      // the bot's Drime account instead of being refused.
      const sizeMB = Number(resolved.sizeMB) || 0;
      const maxMB = host.maxDownloadMB();
      if (sizeMB && sizeMB > maxMB) return { res: resolved, file: null, tooBig: sizeMB };

      if (resolved.kind === 'cache' && resolved.file && fs.existsSync(resolved.file)) {
        return { res: resolved, file: resolved.file, cached: true };
      }

      const dest = await engine.targetFile(meta.title, meta.year, quality, null, null);
      await card.update(`${label}\n📡 ${resolved.provider} (tier ${resolved.tier})\n⬇️ starting…`, { force: true });
      await engine.download(resolved, dest, (got, total) => {
        card.update(`${label}\n📡 ${resolved.provider} (tier ${resolved.tier})\n${progressLine(got, total)}`);
      });

      const size = fs.statSync(dest).size;
      if (!size) throw new Error('download produced an empty file');
      await engine.rememberFile(resolved.meta || meta, quality, null, null, dest, size / 1048576);
      return { res: resolved, file: dest };
    }, { timeoutMs: MOVIES().jobTimeoutMs });

    const { res, file } = jobResult;

    if (MOVIES().dryRun) {
      return card.final(`🔗 *${meta.title}* (dry-run)\n${res.url || '(cached)'}\n📡 ${res.provider} · tier ${res.tier}`);
    }
    if (jobResult.tooBig) {
      return card.final(
        `📦 *${meta.title}* is ${jobResult.tooBig.toFixed(0)} MB — over the ${host.maxDownloadMB()} MB download cap.\n` +
        `🔗 ${res.url || '(cached file)'}\n` +
        `_raise MOVIE_MAX_DOWNLOAD_MB to fetch it anyway_`
      );
    }
    if (jobResult.cached) await card.update('⚡ already downloaded — sending from cache…', { force: true });

    const stat = fs.statSync(file);
    const shownQuality = res.quality || quality;
    const note = res.downgraded ? ` _(no ${quality}p source — sent ${shownQuality}p)_` : '';
    const caption =
      `🎬 *${meta.title}${meta.year ? ` (${meta.year})` : ''}*\n` +
      `💾 ${(stat.size / 1048576).toFixed(0)} MB · ${shownQuality}p${note}\n` +
      `📡 ${res.provider}${res.tier !== undefined ? ` · tier ${res.tier}` : ''}`;

    // Delivery goes through the bot's adapter: same video/document rule as
    // .dl, and a Drime link when the file is too big for WhatsApp.
    const delivered = await host.deliver(sock, chatId, msg, {
      file,
      title: meta.title,
      caption,
      onProgress: (sentBytes, totalBytes) => {
        const pct = totalBytes ? Math.round((sentBytes / totalBytes) * 100) : 0;
        card.update(`${label}\n☁️ saving to Drime… ${pct}%`, { force: pct === 100 });
      },
    });

    await card.final(
      `✅ *${meta.title}${meta.year ? ` (${meta.year})` : ''}* sent — ${(stat.size / 1048576).toFixed(0)} MB` +
      (delivered.as === 'link' ? `\n☁️ Drime link: ${delivered.link}` : '')
    );
  } catch (e) {
    console.error('[movie]', e.message);
    await card.final(`❌ *${meta.title}*\n${String(e.message || '').split('\n').slice(0, 6).join('\n')}`);
  }
}

module.exports = {
  name: 'movie',
  aliases: ['film', 'mv'],
  category: 'media',
  description: 'Download a movie',
  usage: '.movie <title> [year] [quality]',

  async execute(sock, msg, args, extra) {
    const P = config.prefix;
    if (!args.length) return extra.reply(help(P));

    const job = parseArgs(args);
    if (!job.title) return extra.reply(help(P));

    if (!MOVIES().tmdbKey) {
      return extra.reply('❌ Movies need a TMDB API key — set TMDB_API_KEY in config.js / the environment.');
    }

    try {
      const matches = await engine.searchMovie(job.title, job.year || undefined);
      if (!matches.length) {
        return extra.reply(`❌ No movie found for *${job.title}*${job.year ? ` (${job.year})` : ''}.`);
      }

      // exact single hit (or an explicit year) → go straight to the download
      if (matches.length === 1 || job.year) {
        const best = (job.year && matches.find(m => String(m.year) === String(job.year))) || matches[0];
        return deliver(sock, msg, extra, best, job);
      }

      // otherwise let the user pick instead of silently grabbing results[0]
      return offerChoices(sock, msg, extra, matches, job, 'movie');
    } catch (e) {
      console.error('[movie]', e.message);
      return extra.reply(`❌ ${String(e.message || '').split('\n')[0]}`);
    }
  },

  // exported for tests
  _parseArgs: parseArgs,
  _deliver: deliver,
  _offerChoices: offerChoices,
};
