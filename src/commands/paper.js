// src/commands/paper.js — merged from Zafar-bot-main: Mzuzu University past
// papers (Drime Cloud vault).
//   .paper <code> [module] [year]   → all/specific papers
//   .paper browse [code]            → courses / modules
//   .countpapers                    → vault count (1 cheap request)
//   .refreshpapers                  → (owner) force a vault refresh now
import config from '../config.js';
import papers from '../media/papers.js';
import { store } from '../core/store.js';
import { log } from '../core/log.js';

const palog = log.child('cmd.paper');
const SUBJECTS = papers.SUBJECTS;

const formatSize = (bytes) => {
  if (!bytes) return '';
  const kb = parseInt(bytes) / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
};

// papers sent per chat in the last 3 days (persisted, auto-cleaned)
const sentRecently = (chatId, fileId, days = 3) => {
  const log_ = store.bucket('paperLog', {});
  const ts = log_[chatId]?.[fileId];
  if (!ts) return false;
  if (Date.now() - ts > 7 * 24 * 3600_000) { delete log_[chatId][fileId]; store.setBucket('paperLog', log_); return false; }
  return Date.now() - ts < days * 24 * 3600_000;
};
const markSent = (chatId, fileId) => {
  const log_ = store.bucket('paperLog', {});
  log_[chatId] = log_[chatId] || {};
  log_[chatId][fileId] = Date.now();
  store.setBucket('paperLog', log_);
};

export const help = (P) =>
  `📚 *Past Papers*\n\n*.paper <code>* — all papers for a subject\n*.paper <code> <module> [year]* — narrow it\n*.paper browse [code]* — explore the vault\n*.countpapers* — how many papers\n\n_Examples: .paper nurs 2201 2024 · .paper browse geog_`;

const notConfigured = () =>
  '⚙️ *Papers feature not configured.* Set DRIME_API_TOKEN, DRIME_PAPERS_FOLDER_ID and DRIME_PAPERS_FOLDER_HASH in .env.';

export async function run(ctx, args) {
  const P = config.prefix;

  if (!isConfiguredSafe()) return ctx.say(notConfigured());

  if (!args.length) return ctx.say(help(P));
  const mode = args[0].toLowerCase();

  // ── BROWSE ────────────────────────────────────────────────────────────────
  if (mode === 'browse') {
    const status = ctx.status ? ctx.status('🔍 Searching...') : null;
    const update = (t) => status ? status.update(t) : ctx.say(t);
    if (args[1]) {
      const code = args[1].toUpperCase();
      const modules = await papers.browseCode(code);
      if (modules.size === 0) {
        const hint = await papers.nearbyHint(code, null);
        return update(`😔 Sorry, no papers found for *${code}*\nTry *.paper browse* to see all available codes.\n${hint ? `\n${hint}\n` : ''}🙏 If anyone has that, please send it to help our friend!`);
      }
      const firstKey = [...modules.keys()][0];
      const firstCode = firstKey.split(':')[0];
      const subjectName = SUBJECTS[firstCode] || SUBJECTS[code] || '';
      let text = `📂 *${firstCode}${subjectName ? ` — ${subjectName}` : ''}*\n_${modules.size} module(s) in vault_\n\n`;
      for (const [key, modFiles] of modules) {
        const [actualCode, mod] = key.split(':');
        const sorted = papers.sortPapers(modFiles);
        const years = [...new Set(sorted.map(f => papers.parsePaper(f.name).year).filter(Boolean))];
        text += `*${actualCode} ${mod}* — ${sorted.length} paper(s)  📅 ${years.join(', ') || 'various'}\n  ↳ ${P}paper ${actualCode.toLowerCase()} ${mod}\n\n`;
      }
      return update(`📚 Found *${modules.size} module(s)* for *${firstCode}*.\n\n${text}`);
    }

    const codes = await papers.browseAll();
    if (codes.size === 0) return update('❌ No papers in the vault yet.');
    let text = `╭─ 📚 *${config.botName} — Paper Vault*\n│ ${codes.size} course code(s) available\n│\n`;
    for (const [code, count] of codes) {
      const name = SUBJECTS[code] ? ` — ${SUBJECTS[code]}` : '';
      text += `*${code}*${name}  _(${count} paper${count !== 1 ? 's' : ''})_\n`;
    }
    return update(`📚 Found *${codes.size} course code(s)*.\n\n${text}\n╰─ _${P}paper browse <code> to see modules_`);
  }

  // ── STANDARD SEARCH ───────────────────────────────────────────────────────
  const courseCode = args[0].toUpperCase();
  const moduleNumber = (args[1] && !papers.isYear(args[1])) ? args[1] : null;
  const yearArgs = args.slice(moduleNumber ? 2 : 1).filter(papers.isYear);

  const status = ctx.status ? ctx.status('🔍 Searching...') : null;
  const update = (t) => status ? status.update(t) : ctx.say(t);

  let files;
  if (yearArgs.length > 1) {
    const results = await Promise.all(yearArgs.map(y => papers.searchFiles(courseCode, moduleNumber, y)));
    files = papers.deduplicateFiles(results.flat(), courseCode, moduleNumber || '');
  } else {
    const raw = await papers.searchFiles(courseCode, moduleNumber, yearArgs[0] || null);
    files = papers.deduplicateFiles(raw, courseCode, moduleNumber || '');
  }

  if (files.length === 0) {
    const subjectName = SUBJECTS[courseCode] || '';
    const label = [courseCode, moduleNumber, ...yearArgs].filter(Boolean).join(' ');
    let reply = `😔 Sorry, no papers found for *${label}*`;
    if (subjectName) reply += ` _(${subjectName})_`;
    reply += `\n\n*Try:*\n`;
    if (yearArgs.length && moduleNumber) reply += `  ${P}paper ${courseCode} ${moduleNumber}\n`;
    if (moduleNumber) reply += `  ${P}paper ${courseCode}\n`;
    reply += `  ${P}paper browse ${courseCode.toLowerCase()}\n\n`;
    const hint = await papers.nearbyHint(courseCode, moduleNumber);
    if (hint) reply += `${hint}\n`;
    reply += `🙏 If anyone has that, please send it to help our friend!`;
    return update(reply);
  }

  const sorted = papers.sortPapers(files);
  const yearsFound = [...new Set(sorted.map(f => papers.parsePaper(f.name).year).filter(Boolean))].sort();
  const label = [courseCode, moduleNumber].filter(Boolean).join(' ');
  const summary = `📚 Found *${sorted.length} paper${sorted.length !== 1 ? 's' : ''}* for *${label}*${yearsFound.length ? ` (${yearsFound.join(', ')})` : ''}.`;

  if (sorted.length > 10) {
    return update(`${summary}\n\n_Too many to send — narrow your search:_\n  ${P}paper ${courseCode.toLowerCase()} ${moduleNumber || '[module]'} [year]\n  ${P}paper browse ${courseCode.toLowerCase()}`);
  }

  const toSend = [], recentlySent = [];
  for (const file of sorted) {
    (!ctx.isOwner && sentRecently(ctx.jid, file.id) ? recentlySent : toSend).push(file);
  }
  if (toSend.length === 0) {
    return update('♻️ These papers were already sent in this chat within the last 3 days — check earlier messages.');
  }

  const sendable = [], tooLarge = [];
  for (const file of toSend) ((file.size || 0) > papers.MAX_PAPER_BYTES ? tooLarge : sendable).push(file);

  await update(summary);
  if (recentlySent.length > 0) await ctx.say(`_⏩ ${recentlySent.length} paper(s) skipped — sent here recently._`);
  if (tooLarge.length > 0) {
    const names = tooLarge.map(f => `*${papers.cleanName(f.name)}* (${formatSize(f.size)})`).join(', ');
    await ctx.say(`_⚠️ ${tooLarge.length} paper(s) skipped — over 30 MB:_ ${names}`);
  }
  if (sendable.length === 0) return ctx.say('❌ Nothing sent — every match exceeds the 30 MB send limit.');

  // download everything first (parallel, streamed to disk), then send in order
  const jobs = await Promise.all(sendable.map(async (file) => {
    try { return { file, tmp: await papers.downloadFileToDisk(file) }; }
    catch (e) { return { file, error: e }; }
  }));

  for (const job of jobs) {
    if (job.error) {
      await ctx.say(`⚠️ Could not download *${papers.cleanName(job.file.name)}*: ${job.error.message}`);
      continue;
    }
    try {
      const p = papers.parsePaper(job.file.name);
      const metaLine = [p.subjectName, p.type, [p.monthDisplay, p.year].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
      await ctx.sendDoc(job.tmp, metaLine ? `╭─ ${metaLine}\n╰─ ${config.botName}` : `╰─ ${config.botName}`, {
        fileName: job.file.name, mimetype: 'application/pdf',
      });
      markSent(ctx.jid, job.file.id);
    } catch (fileErr) {
      await ctx.say(`⚠️ Could not send *${papers.cleanName(job.file.name)}*: ${fileErr.message}`);
    } finally {
      const { removeTemp } = await import('../media/transfer.js');
      removeTemp(job.tmp);
    }
  }
}

function isConfiguredSafe() {
  try { return papers.isConfigured(); } catch { return false; }
}

// ── .countpapers ─────────────────────────────────────────────────────────────
export async function countpapers(ctx) {
  if (!isConfiguredSafe()) return ctx.say(notConfigured());
  const status = ctx.status ? ctx.status('🔍 Counting papers...') : null;
  try {
    const { req } = await import('../core/http.js');
    const res = await req(`${config.drimeBaseUrl}/folders/${config.drimePapersFolderId}/count?workspaceId=${config.drimeWorkspaceId || 0}`, {
      retries: 0, timeout: 30_000, headers: { authorization: `Bearer ${config.drimeApiToken}` },
    });
    const count = res?.count ?? res?.data?.count;
    if (!count) return status ? status.update('📭 The vault is empty. No papers yet.') : ctx.say('📭 The vault is empty.');
    const text = `📚 Found *${count} paper${count !== 1 ? 's' : ''}* in the vault.\n\n╭─ 🗄️ *${config.botName} — Paper Vault*\n│ ${count} paper${count !== 1 ? 's' : ''} in the vault\n╰─ _${config.prefix}paper browse to explore them_`;
    return status ? status.update(text) : ctx.say(text);
  } catch (e) {
    return status ? status.update(`❌ ${e.message}`) : ctx.say(`❌ ${e.message}`);
  }
}

// ── .refreshpapers (owner) ───────────────────────────────────────────────────
export async function refreshpapers(ctx) {
  if (!isConfiguredSafe()) return ctx.say(notConfigured());
  const status = ctx.status ? ctx.status('🔄 Refreshing paper vault...') : null;
  const t0 = Date.now();
  try {
    const { files, source } = await papers.refreshOnce();
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    const text = `✅ Vault refreshed in ${secs}s — *${files.length} papers* (${source}).`;
    return status ? status.update(text) : ctx.say(text);
  } catch (e) {
    const text = `❌ ${e.message}`;
    return status ? status.update(text) : ctx.say(text);
  }
}
