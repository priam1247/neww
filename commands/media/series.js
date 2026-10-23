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
const { getTempDir } = require('../../utils/tempManager');
const diskSpace = require('../../utils/diskSpace');
const { safeErrorMessage } = require('../../utils/userErrors');
const logger = require('../../utils/logger');
const log = logger('series');

const QUALITY_RX = /^(?:(480|720|1080|2160)p?|4k)$/i;
const MOVIES = () => config.movies || {};
const pad = (n) => String(n).padStart(2, '0');

const help = (P) =>
  `Usage: ${P}series <title> s01e03 | s01 1-6 | s01 full [480|720|1080]`;

function parseArgs(args) {
  const rawTokens = (args || []).map((a) => String(a || '').trim()).filter(Boolean);
  const tokens = [];
  for (let i = 0; i < rawTokens.length; i++) {
    if (
      /^\d{1,3}$/.test(rawTokens[i]) &&
      rawTokens[i + 1] === '-' &&
      /^\d{1,3}$/.test(rawTokens[i + 2] || '')
    ) {
      tokens.push(`${rawTokens[i]}-${rawTokens[i + 2]}`);
      i += 2;
    } else {
      tokens.push(rawTokens[i]);
    }
  }

  let quality = MOVIES().defaultQuality || host.defaultQuality();
  let explicitQuality = false;

  if (tokens.length >= 2 && QUALITY_RX.test(tokens[tokens.length - 1])) {
    const qTok = tokens.pop();
    quality = /^4k$/i.test(qTok) ? 2160 : Number(qTok.replace(/p$/i, ''));
    explicitQuality = true;
  }

  let season = 1;
  let from = 1;
  let to = 1;
  let pack = false;
  let explicitPack = false;
  let bareNumber = null;
  let hasTarget = false;

  const consumeTailSeason = ({ allowBare = true } = {}) => {
    if (tokens.length < 2) return null;
    const last = tokens[tokens.length - 1];
    const mS = /^s(\d{1,2})$/i.exec(last);
    if (mS) {
      tokens.pop();
      return { season: Number(mS[1]), bare: false };
    }
    if (tokens.length >= 3 && /^season$/i.test(tokens[tokens.length - 2]) && /^\d{1,2}$/.test(last)) {
      const n = Number(tokens.pop());
      tokens.pop();
      return { season: n, bare: false };
    }
    const mSeasonJoined = /^season(\d{1,2})$/i.exec(last);
    if (mSeasonJoined) {
      tokens.pop();
      return { season: Number(mSeasonJoined[1]), bare: false };
    }
    if (allowBare && /^\d{1,2}$/.test(last)) {
      const n = Number(last);
      if (n >= 1 && n <= 35) {
        tokens.pop();
        return { season: n, bare: true };
      }
    }
    return null;
  };

  if (tokens.length >= 3 && /^(?:full|pack)$/i.test(tokens[tokens.length - 1])) {
    const saved = tokens.pop();
    const s = consumeTailSeason({ allowBare: true });
    if (s) {
      season = s.season;
      pack = true;
      explicitPack = true;
      hasTarget = true;
    } else {
      tokens.push(saved);
    }
  }

  if (!hasTarget && tokens.length >= 2) {
    const last = tokens[tokens.length - 1];
    const mSE = /^s(\d{1,2})[\s._-]?e(\d{1,3})(?:-e?(\d{1,3}))?$/i.exec(last)
      || /^(\d{1,2})x(\d{1,3})(?:-(\d{1,3}))?$/i.exec(last);
    if (mSE) {
      tokens.pop();
      season = Number(mSE[1]);
      from = Number(mSE[2]);
      to = mSE[3] ? Number(mSE[3]) : from;
      hasTarget = true;
    }
  }

  if (!hasTarget && tokens.length >= 2) {
    const last = tokens[tokens.length - 1];
    const mEp = /^e(?:p(?:isode)?)?(\d{1,3})$/i.exec(last);
    if (mEp) {
      tokens.pop();
      from = to = Number(mEp[1]);
      const s = consumeTailSeason({ allowBare: true });
      if (s) season = s.season;
      hasTarget = true;
    } else if (
      tokens.length >= 3 &&
      /^ep(?:isode)?$/i.test(tokens[tokens.length - 2]) &&
      /^\d{1,3}$/.test(last)
    ) {
      from = to = Number(tokens.pop());
      tokens.pop();
      const s = consumeTailSeason({ allowBare: true });
      if (s) season = s.season;
      hasTarget = true;
    }
  }

  if (!hasTarget && tokens.length >= 2) {
    const mRange = /^(\d{1,3})-(\d{1,3})$/.exec(tokens[tokens.length - 1]);
    if (mRange) {
      tokens.pop();
      from = Number(mRange[1]);
      to = Number(mRange[2]);
      const s = consumeTailSeason({ allowBare: true });
      if (s) season = s.season;
      hasTarget = true;
    }
  }

  if (!hasTarget && tokens.length >= 2) {
    const s = consumeTailSeason({ allowBare: true });
    if (s) {
      season = s.season;
      pack = true;
      hasTarget = true;
      if (s.bare) bareNumber = s.season;
    }
  }

  if (from > to) { const t = from; from = to; to = t; }

  let year = null;
  if (tokens.length >= 2) {
    const last = tokens[tokens.length - 1].replace(/^[([ ]+|[)\]]+$/g, '');
    if (/^(?:19|20)\d{2}$/.test(last)) {
      year = last;
      tokens.pop();
    }
  }

  const title = tokens.join(' ').replace(/\s+/g, ' ').trim();

  return {
    title,
    year,
    season,
    from,
    to,
    pack,
    explicitPack,
    bareNumber,
    hasTarget,
    quality,
    explicitQuality,
  };
}

async function resolveTargetAndQuality(sock, msg, extra, meta, job) {
  if (!job.bareNumber) {
    return askQuality(sock, msg, extra, meta, job);
  }
  const n = job.bareNumber;
  const showTitle = `${meta.title}${meta.year ? ` (${meta.year})` : ''}`;
  const choices = [
    { label: `Season ${n} · Episode 1 (S${pad(n)}E01)`, patch: { season: n, from: 1, to: 1, pack: false, bareNumber: null } },
    { label: `Season ${n} · Episodes 1–4`, patch: { season: n, from: 1, to: 4, pack: false, bareNumber: null } },
    { label: `Season ${n} · Full season pack`, patch: { season: n, from: 1, to: 1, pack: true, explicitPack: true, bareNumber: null } },
    { label: `Season 1 · Episode ${n} (S01E${pad(n)})`, patch: { season: 1, from: n, to: n, pack: false, bareNumber: null } },
  ];
  const header = `📺 *${showTitle}*\nWhat would you like to download?`;
  const optionLabels = choices.map((c) => c.label);
  const lines = optionLabels.map((lbl, i) => `*${i + 1}.* ${lbl}`);

  return selections.sendPollOrText(sock, msg, extra, {
    pollName: header,
    optionLabels,
    fallbackText: `${header}\n\n${lines.join('\n')}\n\n_reply with a number_`,
    items: choices,
    label: 'series-target',
    ttlMs: 5 * 60 * 1000,
    run: (sock2, msg2, extra2, chosen) =>
      askQuality(sock2, msg2, extra2, meta, { ...job, ...chosen.patch }),
  });
}

async function offerChoices(sock, msg, extra, matches, job) {
  const optionLabels = matches.map((m) => {
    const year = m.year ? ` (${m.year})` : '';
    const rating = Number(m.rating) ? ` ⭐${m.rating}` : '';
    return `${m.title}${year}${rating}`;
  });
  const lines = optionLabels.map((lbl, i) => `*${i + 1}.* ${lbl}`);
  const header = `📺 *${matches.length} series* for *${job.title}*`;
  const fallbackText = `${header}\n\n${lines.join('\n')}\n\n_reply with a number_`;

  await selections.sendPollOrText(sock, msg, extra, {
    pollName: `${header}\nTap a series (or reply with its number):`,
    optionLabels,
    fallbackText,
    fallbackImage: matches[0]?.poster || null,
    items: matches,
    label: 'series',
    ttlMs: 5 * 60 * 1000,
    run: (sock2, msg2, extra2, item) => resolveTargetAndQuality(sock2, msg2, extra2, item, { ...job }),
  });
}

const fmtSize = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);

/** Same poll + numbered fallback quality menu as .movie, scoped to one episode/season. */
async function askQuality(sock, msg, extra, meta, job) {
  const react = (emoji) => sock.sendMessage(extra.from, { react: { text: emoji, key: msg.key } }).catch(() => {});
  if (job.explicitQuality) return deliver(sock, msg, extra, meta, job);

  await react('🔎');
  const season = job.season || 1;
  const episode = job.pack ? null : (job.from || 1);
  let options = [];
  try {
    const found = await engine.qualityOptions({ item: meta, type: 'series', season, episode });
    options = found.options || [];
  } catch (e) {
    log.debug(`${meta.title} · quality probe failed · ${e.message}`);
  }

  if (!options.length) return deliver(sock, msg, extra, meta, job);
  if (options.length === 1) { job.quality = options[0].quality; return deliver(sock, msg, extra, meta, job); }

  const ids = options.map((o) => `q${o.quality}`);
  const items = options.map((o) => ({ ...o, meta }));
  const title = `${meta.title} S${pad(season)}${job.pack ? ' (pack)' : `E${pad(episode)}`}`;
  const header = `📺 *${title}*\nChoose the quality:`;
  const optionLabels = options.map((o) => `${o.quality}p${o.sizeMB ? ` · ~${fmtSize(o.sizeMB)}` : ''}`);
  const lines = optionLabels.map((lbl, i) => `*${i + 1}.* ${lbl}`);

  await selections.sendPollOrText(sock, msg, extra, {
    pollName: header,
    optionLabels,
    fallbackText: `${header}\n\n${lines.join('\n')}\n\n_reply with a number_`,
    items,
    ids,
    label: 'quality',
    ttlMs: 5 * 60 * 1000,
    run: (sock2, msg2, extra2, item) => {
      job.quality = item.quality;
      return deliver(sock2, msg2, extra2, meta, job);
    },
  });
}

/** Send one finished file through the bot's delivery path (document, like .song). */
/** Attach the subtitle track that came with the stream. Best effort, silent. */
async function trySubtitles(sock, msg, chatId, meta, season, episode) {
  if ((MOVIES().subtitles ?? true) === false) return null;
  const lang = MOVIES().subtitleLang || 'en';
  const base = `${meta.title} S${pad(season)}E${pad(episode)}`;
  const dest = path.join(getTempDir(), `${base.replace(/[\\/:*?"<>|]+/g, ' ')}.${lang}.srt`);
  try {
    const sub = await engine.subtitles(meta, { season, episode, lang, dest });
    if (!sub?.file || !fs.existsSync(sub.file)) return null;
    await host.sendSubtitle(sock, chatId, msg, { file: sub.file, name: base, language: sub.language || lang });
    return sub;
  } catch { return null; }
}

async function sendEpisode(sock, msg, chatId, file, meta, season, episode, quality, res) {
  const stat = fs.statSync(file);
  const tag = `S${pad(season)}E${pad(episode)}`;
  const shownQuality = res.quality || quality;
  const note = res.downgraded ? ` _(no ${quality}p — ${shownQuality}p)_` : '';
  const caption =
    `📺 *${meta.title}* ${tag}\n` +
    `${(stat.size / 1048576).toFixed(0)} MB · ${shownQuality}p${note}`;

  await host.deliver(sock, chatId, msg, {
    file,
    title: `${meta.title} ${tag}`,
    caption,
  });

  await trySubtitles(sock, msg, chatId, meta, season, episode);
  // delivered → delete, unless the owner turned the disk cache back on
  await host.release(file).catch(() => false);

  return stat.size;
}

async function deliverSeasonPack(sock, msg, extra, meta, job) {
  const chatId = extra.from;
  const season = job.season || 1;
  const react = (emoji) => sock.sendMessage(chatId, { react: { text: emoji, key: msg.key } }).catch(() => {});
  const say = (text) => sock.sendMessage(chatId, { text }, { quoted: msg });

  await react('⏳');
  let packReservation = null;
  let packFile = null;

  try {
    // resolve + (if it fits) download inside one queue slot
    const out = await engine.enqueue(chatId, `season ${meta.title} S${pad(season)}`, async () => {
      const resolved = await engine.resolveSeason({
        item: meta, tmdbId: meta.tmdbId, title: meta.title, year: meta.year, season, quality: job.quality,
      });

      if (MOVIES().dryRun) return { res: resolved, file: null };

      const sizeMB = Number(resolved.sizeMB) || 0;
      const maxMB = MOVIES().maxSendMB || 2000;

      // packs are usually 5–40 GB: hand over the link instead of downloading
      if (resolved.kind !== 'cache' && (!sizeMB || sizeMB > maxMB)) {
        return { res: resolved, file: null, sizeMB };
      }

      if (resolved.kind === 'cache' && resolved.file && fs.existsSync(resolved.file)) {
        return { res: resolved, file: resolved.file };
      }

      const dest = await engine.targetFile(meta.title, meta.year, job.quality, season, null);
      const reservation = diskSpace.reserveMovieSpace(getTempDir(), resolved.sizeMB, MOVIES(), {
        label: `season:${meta.title}:S${pad(season)}`,
        tagDir: path.dirname(dest),
        tagPrefix: path.basename(dest, path.extname(dest)),
      });
      try {
        const saved = await engine.download(resolved, dest);
        return { res: resolved, file: (saved && saved.file) || dest, reservation };
      } catch (e) {
        reservation.release();
        throw e;
      }
    }, { timeoutMs: MOVIES().jobTimeoutMs });

    const { res, file, reservation } = out;
    packReservation = reservation || null;
    packFile = file || null;

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

    await host.release(file).catch(() => false);
    packFile = null;
    require('../../utils/telemetry').recordDownloadSuccess('series');
    return react('✅');
  } catch (e) {
    require('../../utils/telemetry').recordFailure('series');
    log.error(`${meta.title} S${pad(season)} pack · ${e.code || 'FAIL'} · ${String(e.message || '').split('\n')[0]}`);
    await react('❌');
    if (e.code === 'NOT_ENOUGH_DISK') {
      return say(safeErrorMessage(e, { isOwner: Boolean(extra?.isOwner) }));
    }
    return say(`❌ No season pack for *${meta.title}* S${pad(season)}.`);
  } finally {
    if (packFile) await host.release(packFile).catch(() => false);
    packReservation?.release?.();
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
    let downloadedFile = dest;
    const reservation = diskSpace.reserveMovieSpace(getTempDir(), resolved.sizeMB, MOVIES(), {
      label: `episode:${meta.title}:S${pad(season)}E${pad(ep)}`,
      tagDir: path.dirname(dest),
      tagPrefix: path.basename(dest, path.extname(dest)),
    });
    try {
      const saved = await engine.download(resolved, dest);
      const realFile = downloadedFile = (saved && saved.file) || dest;
      const size = fs.statSync(realFile).size;
      if (!size) throw new Error('download produced an empty file');
      const epRuntime = resolved.episodeRuntime || (resolved.meta || meta).episodeRuntime || (resolved.meta || meta).runtime;
      await require('./movie')._assertFullLength(realFile, epRuntime, 'episode');
      return { res: resolved, file: realFile, reservation };
    } catch (e) {
      reservation.release();
      lastErr = e;
      log.warn(`${meta.title} S${pad(season)}E${pad(ep)} · ${resolved.provider} download failed · ${e.message}`);
      exclude.push(resolved.provider);
      for (const f of new Set([downloadedFile, dest, dest.replace(/\.(mp4|mkv|ts|m4v)$/i, '') + '.ts'])) {
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
    let epReservation = null;
    let epFile = null;
    try {
      // resolve + download in ONE queue slot so a batch stays sequential
      const done = await engine.enqueue(
        chatId,
        `${meta.title} ${tag}`,
        () => fetchEpisodeSource(meta, season, ep, job.quality),
        { timeoutMs: MOVIES().jobTimeoutMs }
      );

      const { res, file, reservation } = done;
      epReservation = reservation || null;
      epFile = file || null;

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
      epFile = null;
      sent++;
    } catch (e) {
      log.error(`${meta.title} ${tag} · ${e.code || 'FAIL'} · ${e.message}`);
      const reason = e.code === 'NOT_ENOUGH_DISK'
        ? 'server storage busy'
        : (e.code === 'SHORT' ? 'only trailer/clip available' : 'no playable source');
      failures.push(`${tag}: ${reason}`);
    } finally {
      if (epFile) await host.release(epFile).catch(() => false);
      epReservation?.release?.();
    }
  }

  const telemetry = require('../../utils/telemetry');
  if (sent > 0) telemetry.recordDownloadSuccess('series', sent);
  if (failures.length > 0) telemetry.recordFailure('series', failures.length);

  if (!failures.length) return react('✅');

  await react(sent ? '⚠️' : '❌');
  const alts = sent ? [] : await engine.alternatives(job.matches, { chosen: meta }).catch(() => []);
  const hint = alts.length
    ? `\n💡 Did you mean *${alts[0].title}*${alts[0].year ? ` (${alts[0].year})` : ''}?`
    : '';
  return say(
    `⚠️ *${meta.title}* S${pad(season)} — ${sent}/${episodes.length} sent\n` +
    failures.slice(0, 3).map(f => `• ${f}`).join('\n') + hint
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

    if (!job.hasTarget) {
      return extra.reply(`❓ Specify episode/season: \`${P}series ${job.title} s01e01\``);
    }

    try {
      const matches = await engine.searchTv(job.title, job.year || undefined);
      if (!matches.length) return extra.reply(`❌ No series found for *${job.title}*.`);
      job.matches = matches;

      if (matches.length === 1) return resolveTargetAndQuality(sock, msg, extra, matches[0], job);
      return offerChoices(sock, msg, extra, matches, job);
    } catch (e) {
      log.error(`${job.title || 'search'} · ${e.code || 'FAIL'} · ${String(e.message || '').split('\n')[0]}`);
      return extra.reply(safeErrorMessage(e, {
        isOwner: Boolean(extra?.isOwner),
        fallback: '❌ Could not search series sources right now. Please try again shortly.',
      }));
    }
  },

  _parseArgs: parseArgs,
  _askQuality: askQuality,
  _resolveTargetAndQuality: resolveTargetAndQuality,
  _deliver: deliver,
};
