/**
 * ZaFar Bot — .movie  (download a movie)
 *
 *   .movie <title> [year] [480|720|1080|2160]
 *
 * Quiet by design: the only chat messages are the numbered picker (only when a
 * title is ambiguous), the finished file, and ONE short line if something goes
 * wrong. Everything else is a reaction (⏳ → ✅ / ❌), like the rest of the bot.
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
const { probeMedia } = require('../../utils/mediaTransfer');
const logger = require('../../utils/logger');
const log = logger('movie');

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
  let explicitQuality = false;

  for (const a of args) {
    if (QUALITY_RX.test(a)) { quality = qualityOf(a); explicitQuality = true; continue; }
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

  return { title, year, quality, explicitQuality };
}

const help = (P) =>
  `🎬 *Movies*\n\n` +
  `*${P}movie <title> [year] [quality]*\n` +
  `e.g.  ${P}movie inception 2010 1080\n` +
  `      ${P}movie dune 2021\n\n` +
  `qualities: 480 · 720 · 1080 · 2160 (4k)`;

const sanitize = (name) => String(name || 'subtitle')
  .replace(/[\\/:*?"<>|]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 120) || 'subtitle';

/**
 * Shortest playtime a real copy can have. Fake uploads ("[Hindi] [Full movie]",
 * trailers, 2-minute teasers) are served under the film's own name.
 */
function minPlaySeconds(runtimeMin, kind = 'movie') {
  const rt = Number(runtimeMin) || 0;
  if (kind === 'episode') return rt ? rt * 60 * 0.5 : 5 * 60;
  return Math.max(40 * 60, rt * 60 * 0.6);
}

/** Throw when the downloaded file is a clip, not the title. */
async function assertFullLength(file, runtimeMin, kind = 'movie') {
  const { duration } = await probeMedia(file);
  const min = minPlaySeconds(runtimeMin, kind);
  if (duration && duration < min) {
    throw Object.assign(
      new Error(`only ${Math.max(1, Math.round(duration / 60))} min long — a trailer/fake upload, not the full ${kind}`),
      { code: 'SHORT' },
    );
  }
  return duration;
}

/** Safe error summary for chat — never forwards raw internal error text. */
const shortError = (e, extra) =>
  safeErrorMessage(e, {
    isOwner: Boolean(extra?.isOwner),
    fallback: '❌ Could not search movie sources right now. Please try again shortly.',
  });

/**
 * Resolve + download, retrying with the failed provider excluded.
 * One dead CDN link used to end the command; now the engine walks on to the
 * next source instead of telling the user "no source".
 */
async function fetchSource(meta, quality, attempts = 3) {
  const exclude = [];
  let lastErr = null;

  for (let i = 0; i < attempts; i++) {
    const resolved = await engine.resolveMovie({
      item: meta, tmdbId: meta.tmdbId, title: meta.title, year: meta.year, quality, exclude,
    });

    if (MOVIES().dryRun) return { res: resolved, file: null };

    const sizeMB = Number(resolved.sizeMB) || 0;
    if (sizeMB && sizeMB > host.maxDownloadMB()) return { res: resolved, file: null, tooBig: sizeMB };

    if (resolved.kind === 'cache' && resolved.file && fs.existsSync(resolved.file)) {
      return { res: resolved, file: resolved.file, cached: true };
    }

    const dest = await engine.targetFile(meta.title, meta.year, quality, null, null);
    let downloadedFile = dest;
    const reservation = diskSpace.reserveMovieSpace(getTempDir(), resolved.sizeMB, MOVIES(), {
      label: `movie:${meta.title}`,
      tagDir: path.dirname(dest),
      tagPrefix: path.basename(dest, path.extname(dest)),
    });
    try {
      const saved = await engine.download(resolved, dest);
      // HLS sources may land as .ts (no ffmpeg on the host) — use the real path
      const file = downloadedFile = (saved && saved.file) || dest;
      const full = resolved.meta || meta;
      await assertFullLength(file, full.runtime, 'movie');
      return { res: resolved, file, reservation };
    } catch (e) {
      reservation.release();
      lastErr = e;
      log.warn(`${meta.title} ${quality}p · ${resolved.provider} download failed · ${e.message}`);
      exclude.push(resolved.provider);
      for (const f of new Set([downloadedFile, dest, dest.replace(/\.(mp4|mkv|ts|m4v)$/i, '') + '.ts'])) {
        try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
      }
      if (exclude.length >= attempts) break;
    }
  }
  throw lastErr || new Error('no downloadable source found');
}

/**
 * Offer title choices via a WhatsApp Poll (up to 12 matches), falling back
 * automatically to a numbered list when >12 matches or when polls fail.
 */
async function offerChoices(sock, msg, extra, matches, job, kind) {
  const optionLabels = matches.map((m) => {
    const year = m.year ? ` (${m.year})` : '';
    const rating = Number(m.rating) ? ` ⭐${m.rating}` : '';
    return `${m.title}${year}${rating}`;
  });
  const lines = optionLabels.map((lbl, i) => `*${i + 1}.* ${lbl}`);
  const header = `🎬 *${matches.length} ${kind === 'series' ? 'series' : 'movies'}* for *${job.title}*`;
  const fallbackText = `${header}\n\n${lines.join('\n')}\n\n_reply with a number_`;

  await selections.sendPollOrText(sock, msg, extra, {
    pollName: `${header}\nTap a title (or reply with its number):`,
    optionLabels,
    fallbackText,
    items: matches,
    label: kind,
    ttlMs: 5 * 60 * 1000,
    run: (sock2, msg2, extra2, item) => askQuality(sock2, msg2, extra2, item, { ...job }),
  });
}

const fmtSize = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);

/**
 * Ask which quality to fetch, with the real size of each source.
 *
 * Sends a WhatsApp Poll (tap an option) and also registers a typed-number
 * fallback in `utils/selections` — if the client rejects polls it falls back
 * to a numbered text card automatically.
 */
async function askQuality(sock, msg, extra, meta, job) {
  const react = (emoji) => sock.sendMessage(extra.from, { react: { text: emoji, key: msg.key } }).catch(() => {});

  if (job.explicitQuality) return deliver(sock, msg, extra, meta, job);

  await react('🔎');
  let options = [];
  try {
    const found = await engine.qualityOptions({
      item: meta, season: job.season ?? null, episode: job.episode ?? null,
    });
    options = found.options || [];
  } catch (e) {
    log.debug(`${meta.title} · quality probe failed · ${e.message}`);
  }

  if (!options.length) return deliver(sock, msg, extra, meta, job);   // nothing to choose from
  if (options.length === 1) { job.quality = options[0].quality; return deliver(sock, msg, extra, meta, job); }

  const ids = options.map((o) => `q${o.quality}`);
  const items = options.map((o) => ({ ...o, meta }));
  const title = `${meta.title}${meta.year ? ` (${meta.year})` : ''}`;
  const header = `🎬 *${title}*\nChoose the quality:`;
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

/**
 * Attach the subtitle track that came with the stream (MovieBox serves it).
 * Best effort and silent: a missing subtitle never fails the download.
 */
async function trySubtitles(sock, chatId, msg, meta, { season = null, episode = null } = {}) {
  if ((MOVIES().subtitles ?? true) === false) return null;
  const lang = MOVIES().subtitleLang || 'en';
  const base = season != null
    ? `${meta.title} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
    : `${meta.title}${meta.year ? ` (${meta.year})` : ''}`;
  const dest = path.join(getTempDir(), `${sanitize(base)}.${lang}.srt`);

  try {
    const sub = await engine.subtitles(meta, { season, episode, lang, dest });
    if (!sub?.file || !fs.existsSync(sub.file)) return null;
    await host.sendSubtitle(sock, chatId, msg, { file: sub.file, name: base, language: sub.language || lang });
    log.info(`${base} · subtitle ${sub.language || lang}`);
    return sub;
  } catch (e) {
    log.debug(`${base} · no subtitle (${e.message})`);
    return null;
  }
}

/** Resolve → download → send. One file message, reactions for the rest. */
async function deliver(sock, msg, extra, meta, job) {
  const chatId = extra.from;
  const quality = job.quality;
  const react = (emoji) => sock.sendMessage(chatId, { react: { text: emoji, key: msg.key } }).catch(() => {});
  const say = (text) => sock.sendMessage(chatId, { text }, { quoted: msg });

  await react('⏳');
  let activeReservation = null;
  let activeFile = null;

  try {
    // resolve + download inside ONE queue slot: concurrency stays bounded, so a
    // second movie cannot over-commit bandwidth or disk
    log.info(`${meta.title}${meta.year ? ` (${meta.year})` : ''} · ${quality}p · start`);
    const t0 = Date.now();
    const jobResult = await engine.enqueue(
      chatId,
      `movie ${meta.title} ${quality}p`,
      () => fetchSource(meta, quality),
      { timeoutMs: MOVIES().jobTimeoutMs }
    );

    const { res, file, reservation } = jobResult;
    activeReservation = reservation || null;
    activeFile = file || null;

    if (MOVIES().dryRun) {
      await react('🔗');
      return say(`🔗 ${meta.title}\n${res.url || '(cached)'}`);
    }
    if (jobResult.tooBig) {
      await react('❌');
      return say(`❌ *${meta.title}* is ${jobResult.tooBig.toFixed(0)} MB — over the ${host.maxDownloadMB()} MB download cap.`);
    }

    log.info(`${meta.title} · ${res.provider} · ${res.quality || quality}p · ` +
      `${host.fmtMB(fs.statSync(file).size)} · ${Math.round((Date.now() - t0) / 1000)}s`);

    const shownQuality = res.quality || quality;
    const note = res.downgraded ? ` (${shownQuality}p)` : '';
    await host.deliver(sock, chatId, msg, {
      file,
      title: meta.title,
      caption: `🎬 *${meta.title}${meta.year ? ` (${meta.year})` : ''}*\n${shownQuality}p${note} · ${host.fmtMB(fs.statSync(file).size)}`,
    });

    await trySubtitles(sock, chatId, msg, meta);
    // The chat has the file now — delete it, nothing is cached.
    await host.release(file).catch(() => false);
    activeFile = null;
    await react('✅');
  } catch (e) {
    // full message: the logger collapses the bullets onto one line, so the
    // reason (dead host, quality mismatch, no candidates) stays visible
    log.error(`${meta.title}${meta.year ? ` (${meta.year})` : ''} · ${e.code || 'FAIL'} · ${e.message}`);
    await react('❌');
    // A bare "no source" is useless when the title matched a 0-vote ghost:
    // say what it matched and offer the film the user probably meant.
    const alts = await engine.alternatives(job.matches, { chosen: meta }).catch(() => []);
    const matched = `*${meta.title}*${meta.year ? ` (${meta.year})` : ''}`;
    const hint = alts.length
      ? `\n💡 Did you mean *${alts[0].title}*${alts[0].year ? ` (${alts[0].year})` : ''}?` +
        `\n→ ${config.prefix}movie ${alts[0].title.toLowerCase()}${alts[0].year ? ` ${alts[0].year}` : ''}`
      : '';
    if (e.code === 'SHORT' || /trailer\/fake/.test(String(e.message))) {
      return say(`❌ Only a trailer/fake clip of ${matched} is out there right now — no full-length copy yet.`);
    }
    if (e.code === 'NOT_ENOUGH_DISK') {
      return say(safeErrorMessage(e, { isOwner: Boolean(extra?.isOwner) }));
    }
    await say(`❌ No source for ${matched}.${hint}`);
  } finally {
    if (activeFile) await host.release(activeFile).catch(() => false);
    activeReservation?.release?.();
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

    try {
      const matches = await engine.searchMovie(job.title, job.year || undefined);
      if (!matches.length) return extra.reply(`❌ No movie found for *${job.title}*.`);

      // Exact single hit (or an explicit year) → choose the quality next.
      if (matches.length === 1 || job.year) {
        const best = (job.year && matches.find(m => String(m.year) === String(job.year))) || matches[0];
        job.matches = matches;
        return askQuality(sock, msg, extra, best, job);
      }

      // A vague title matches many films: show them all instead of grabbing #1.
      job.matches = matches;
      return offerChoices(sock, msg, extra, matches, job, 'movie');
    } catch (e) {
      log.error(`${job.title || 'search'} · ${e.code || 'FAIL'} · ${String(e.message).split('\n')[0]}`);
      return extra.reply(shortError(e, extra));
    }
  },

  // exported for tests
  _parseArgs: parseArgs,
  _minPlaySeconds: minPlaySeconds,
  _assertFullLength: assertFullLength,
  _deliver: deliver,
  _offerChoices: offerChoices,
  _askQuality: askQuality,
};
