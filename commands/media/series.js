/**
 * ZaFar Bot — .series  (download episodes of a series)
 *
 *   .series <title> s01e03 [quality]      one episode
 *   .series <title> s01 1-6  [quality]    a range of episodes
 *   .series <title> s01      [quality]    same as full season
 *   .series <title> s01 full [quality]    season pack (link when it is huge)
 *
 * Episodes are resolved one at a time through the engine's fair queue, so a
 * 10-episode batch can never block .song / .paper / other chats.
 *
 * Quiet by design: reactions (⏳ → ✅ / ❌) instead of chat spam, one file
 * message per episode, and one short line only if something failed.
 */

const fs = require('fs');
const path = require('path');
const config = require('../../config');
const engine = require('../../utils/movieEngine');
const selections = require('../../utils/selections');
const host = require('../../utils/movieHost');
const logger = require('../../utils/logger');
const log = logger('series');

const QUALITY_RX = /^(480|720|1080|2160|4k)$/i;
const MOVIES = () => config.movies || {};
const pad = (n) => String(n).padStart(2, '0');

const help = (P) =>
  `📺 *Series*\n\n` +
  `*${P}series <title> s01e03 [quality]*  — one episode\n` +
  `*${P}series <title> s01 1-6 [quality]*  — episode range\n` +
  `*${P}series <title> s01 full [quality]* — season pack\n\n` +
  `e.g.  ${P}series breaking bad s01e03 720\n` +
  `      ${P}series the boys s02 1-4\n\n` +
  `qualities: 480 · 720 · 1080 · 2160 (4k)`;

function parseArgs(args) {
  const rest = [];
  let quality = MOVIES().defaultQuality || host.defaultQuality();

  for (const a of args) {
    if (QUALITY_RX.test(a)) { quality = /^4k$/i.test(a) ? 2160 : Number(a); continue; }
    rest.push(a);
  }

  const text = rest.join(' ').trim();

  const ep = (/\bs(\d{1,2})[\s._-]?e(\d{1,3})\b/i.exec(text))
    || (/\b(\d{1,2})x(\d{2,3})\b/.exec(text));
  const range = /\b(\d{1,3})\s*-\s*(\d{1,3})\b/.exec(text);
  const seasonOnly = /\bs(?:eason)?\s*(\d{1,2})\b/i.exec(text);
  const full = /\bfull\b/i.test(text);

  let season = null;
  let from = 1;
  let to = 1;
  let pack = false;

  if (ep) {
    season = Number(ep[1]);
    from = to = Number(ep[2]);
  } else if (seasonOnly) {
    season = Number(seasonOnly[1]);
    if (range) { from = Number(range[1]); to = Number(range[2]); }
    else { pack = true; }
  } else if (range) {
    season = 1;
    from = Number(range[1]);
    to = Number(range[2]);
  } else {
    season = 1;
    from = to = 1;
  }

  if (from > to) { const t = from; from = to; to = t; }
  if (full) pack = true;

  // optional year, same rule as .movie (keep a title-only year like "1923")
  let year = null;
  let cleaned = text;
  for (const y of [...text.matchAll(/\b((?:19|20)\d{2})\b/g)].map(m => m[1]).reverse()) {
    const without = text.replace(new RegExp(`\\b${y}\\b`), '').replace(/\s+/g, ' ').trim();
    if (without && !/^s\d{1,2}/i.test(without) && without.replace(/\b\d{1,3}\s*-\s*\d{1,3}\b/g, '').trim()) {
      year = y;
      cleaned = without;
      break;
    }
  }

  const title = cleaned
    .replace(/\bs\d{1,2}[\s._-]?e\d{1,3}\b/gi, '')
    .replace(/\b\d{1,2}x\d{2,3}\b/gi, '')
    .replace(/\b\d{1,3}\s*-\s*\d{1,3}\b/g, '')
    .replace(/\bs(?:eason)?\s*\d{1,2}\b/gi, '')
    .replace(/\b(full|season|pack)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  return { title, year, season, from, to, pack, quality };
}

async function offerChoices(sock, msg, extra, matches, job) {
  const list = matches.slice(0, 6);
  const text = `📺 *${list.length} matches* — reply with a number\n\n` +
    list.map((m, i) => `*${i + 1}.* ${m.title} (${m.year || '—'})`).join('\n') +
    `\n\n_or reply *cancel*_`;

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
    label: 'series',
    ttlMs: 5 * 60 * 1000,
    run: (sock2, msg2, extra2, item) => deliver(sock2, msg2, extra2, item, job),
  });
}

/** Send one finished file through the bot's delivery path (document, like .song). */
async function sendEpisode(sock, msg, chatId, file, meta, season, episode, quality, res) {
  const stat = fs.statSync(file);
  const tag = `S${pad(season)}E${pad(episode)}`;
  const shownQuality = res.quality || quality;
  const note = res.downgraded ? ` _(no ${quality}p — ${shownQuality}p)_` : '';
  const caption =
    `📺 *${meta.title}* — ${tag}\n` +
    `💾 ${(stat.size / 1048576).toFixed(0)} MB · ${shownQuality}p${note}\n` +
    `📡 ${res.provider}${res.tier !== undefined ? ` · tier ${res.tier}` : ''}`;

  await host.deliver(sock, chatId, msg, {
    file,
    title: `${meta.title} ${tag}`,
    caption,
  });

  return stat.size;
}

async function deliverSeasonPack(sock, msg, extra, meta, job) {
  const chatId = extra.from;
  const season = job.season || 1;
  const react = (emoji) => sock.sendMessage(chatId, { react: { text: emoji, key: msg.key } }).catch(() => {});
  const say = (text) => sock.sendMessage(chatId, { text }, { quoted: msg });

  await react('⏳');

  try {
    // resolve + (if it fits) download inside one queue slot
    const out = await engine.enqueue(chatId, `season ${meta.title} S${pad(season)}`, async () => {
      const resolved = await engine.resolveSeason({
        item: meta, tmdbId: meta.tmdbId, title: meta.title, year: meta.year, season, quality: job.quality,
      });

      if (MOVIES().dryRun) return { res: resolved, file: null };

      const sizeMB = Number(resolved.sizeMB) || 0;
      const maxMB = MOVIES().maxSendMB || 1500;

      // packs are usually 5–40 GB: hand over the link instead of downloading
      if (resolved.kind !== 'cache' && (!sizeMB || sizeMB > maxMB)) {
        return { res: resolved, file: null, sizeMB };
      }

      if (resolved.kind === 'cache' && resolved.file && fs.existsSync(resolved.file)) {
        return { res: resolved, file: resolved.file };
      }

      const dest = await engine.targetFile(meta.title, meta.year, job.quality, season, null);
      const saved = await engine.download(resolved, dest);
      return { res: resolved, file: (saved && saved.file) || dest };
    }, { timeoutMs: MOVIES().jobTimeoutMs });

    const { res, file } = out;

    if (MOVIES().dryRun) {
      await react('🔗');
      return say(`🔗 ${meta.title} S${pad(season)}\n${res.url || '(cached)'}`);
    }

    if (!file) {
      const sizeMB = Number(out.sizeMB ?? res.sizeMB) || 0;
      const maxMB = host.maxDownloadMB();
      await react('🔗');
      return say(
        `📦 *${meta.title}* S${pad(season)} pack${sizeMB ? ` — ${sizeMB.toFixed(0)} MB` : ''}\n` +
        `${sizeMB > maxMB ? `_too large to download (cap ${maxMB} MB)_\n` : ''}🔗 ${res.url}`
      );
    }

    await host.deliver(sock, chatId, msg, {
      file,
      title: `${meta.title} S${pad(season)}`,
      caption: `📺 *${meta.title}* — S${pad(season)} pack`,
    });

    return react('✅');
  } catch (e) {
    log.error(`${meta.title} S${pad(season)} pack · ${e.code || 'FAIL'} · ${String(e.message || '').split('\n')[0]}`);
    await react('❌');
    return say(`❌ *${meta.title}* S${pad(season)} pack\n${String(e.message || '').split('\n')[0]}`);
  }
}

/**
 * Resolve + download one episode, retrying with the failed provider excluded.
 * A single dead CDN link no longer costs the user the whole batch.
 */
async function fetchEpisodeSource(meta, season, ep, quality, attempts = 3) {
  const exclude = [];
  let lastErr = null;

  for (let i = 0; i < attempts; i++) {
    const resolved = await engine.resolveEpisode({
      item: meta, tmdbId: meta.tmdbId, title: meta.title, year: meta.year,
      season, episode: ep, quality, exclude,
    });

    if (MOVIES().dryRun) return { res: resolved, file: null };

    const maxMB = host.maxDownloadMB();
    if (resolved.sizeMB && resolved.sizeMB > maxMB) return { res: resolved, tooLarge: resolved.sizeMB };

    if (resolved.kind === 'cache' && resolved.file && fs.existsSync(resolved.file)) {
      return { res: resolved, file: resolved.file };
    }

    const dest = await engine.targetFile(meta.title, meta.year, quality, season, ep);
    try {
      const saved = await engine.download(resolved, dest);
      const realFile = (saved && saved.file) || dest;
      const size = fs.statSync(realFile).size;
      if (!size) throw new Error('download produced an empty file');
      await engine.rememberFile(resolved.meta || meta, quality, season, ep, realFile, size / 1048576);
      return { res: resolved, file: realFile };
    } catch (e) {
      lastErr = e;
      log.warn(`${meta.title} S${pad(season)}E${pad(ep)} · ${resolved.provider} download failed · ${e.message}`);
      exclude.push(resolved.provider);
      for (const f of [dest, dest.replace(/\.(mp4|mkv|ts|m4v)$/i, '') + '.ts']) {
        try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
      }
      if (exclude.length >= attempts) break;
    }
  }
  throw lastErr || new Error('no downloadable source found');
}

async function deliver(sock, msg, extra, meta, job) {
  const chatId = extra.from;

  if (job.pack) return deliverSeasonPack(sock, msg, extra, meta, job);

  const season = job.season || 1;
  const limit = MOVIES().episodeBatchLimit || 10;
  const from = Math.max(1, job.from || 1);
  const to = Math.min(job.to || from, from + limit - 1);
  const episodes = [];
  for (let e = from; e <= to; e++) episodes.push(e);

  // TVMaze (keyless) knows how many episodes actually exist and when they air.
  // Without this a typo like "s01 1-30" burns 30 resolve attempts on nothing.
  let guide = null;
  try { guide = await engine.episodeGuide(meta, season); } catch { guide = null; }
  if (Array.isArray(guide) && guide.length) {
    const known = new Map(guide.map(g => [Number(g.episode), g]));
    const missing = episodes.filter(e => !known.has(e));
    if (missing.length === episodes.length) {
      return extra.reply(
        `❌ *${meta.title}* S${pad(season)} has ${guide.length} episode(s), so ${missing.map(e => `E${pad(e)}`).join(', ')} does not exist.`
      );
    }
    if (missing.length) {
      const last = Math.max(...[...known.keys()]);
      await extra.reply(`ℹ️ S${pad(season)} has ${last} episode(s) — skipping ${missing.map(e => `E${pad(e)}`).join(', ')}.`);
      episodes.splice(0, episodes.length, ...episodes.filter(e => known.has(e)));
    }
  }

  const react = (emoji) => sock.sendMessage(chatId, { react: { text: emoji, key: msg.key } }).catch(() => {});
  const say = (text) => sock.sendMessage(chatId, { text }, { quoted: msg });

  await react('⏳');

  let sent = 0;
  const failures = [];

  for (const ep of episodes) {
    const tag = `S${pad(season)}E${pad(ep)}`;
    try {
      // resolve + download in ONE queue slot so a batch stays sequential
      const done = await engine.enqueue(
        chatId,
        `${meta.title} ${tag}`,
        () => fetchEpisodeSource(meta, season, ep, job.quality),
        { timeoutMs: MOVIES().jobTimeoutMs }
      );

      const { res, file } = done;

      if (MOVIES().dryRun) {
        await say(`🔗 ${tag}: ${res.url || '(cached)'}`);
        sent++;
        continue;
      }

      if (done.tooLarge) {
        await say(`📦 *${tag}* is ${done.tooLarge.toFixed(0)} MB — over the ${host.maxDownloadMB()} MB download cap`);
        failures.push(`${tag}: too large`);
        continue;
      }

      log.info(`${meta.title} ${tag} · ${res.provider} · ${res.quality || job.quality}p · ${host.fmtMB(fs.statSync(file).size)}`);
      await sendEpisode(sock, msg, chatId, file, meta, season, ep, job.quality, res);
      sent++;
    } catch (e) {
      log.error(`${meta.title} ${tag} · ${e.code || 'FAIL'} · ${String(e.message || '').split('\n')[0]}`);
      failures.push(`${tag}: ${String(e.message || '').split('\n')[0]}`);
    }
  }

  // Silence on success (the files are the answer); one short line on failure.
  if (!failures.length) return react('✅');

  await react(sent ? '⚠️' : '❌');
  return say(
    `⚠️ *${meta.title}* S${pad(season)} — ${sent}/${episodes.length} sent\n` +
    failures.slice(0, 3).map(f => `• ${f}`).join('\n')
  );
}

module.exports = {
  name: 'series',
  aliases: ['tvshow', 'episode'],
  category: 'media',
  description: 'Download series episodes',
  usage: '.series <title> s01e03 [quality]',

  async execute(sock, msg, args, extra) {
    const P = config.prefix;
    if (!args.length) return extra.reply(help(P));

    const job = parseArgs(args);
    if (!job.title) return extra.reply(help(P));

    // no episode/season marker at all → explain instead of guessing
    if (!/\bs\d{1,2}/i.test(args.join(' ')) && !/\d{1,3}\s*-\s*\d{1,3}/.test(args.join(' '))) {
      return extra.reply(`❓ Which episode?\n\n${help(P)}`);
    }

    if (!MOVIES().tmdbKey) {
      return extra.reply('❌ Series need a TMDB API key — set TMDB_API_KEY in config.js / the environment.');
    }

    try {
      const matches = await engine.searchTv(job.title, job.year || undefined);
      if (!matches.length) return extra.reply(`❌ No series found for *${job.title}*.`);

      if (matches.length === 1) return deliver(sock, msg, extra, matches[0], job);
      return offerChoices(sock, msg, extra, matches, job);
    } catch (e) {
      log.error(`${job.title || 'search'} · ${e.code || 'FAIL'} · ${String(e.message || '').split('\n')[0]}`);
      return extra.reply(`❌ ${String(e.message || '').split('\n')[0]}`);
    }
  },

  _parseArgs: parseArgs,
  _deliver: deliver,
};
