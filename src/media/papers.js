// src/media/papers.js — merged from Zafar-bot-main: Mzuzu University past-paper
// vault on Drime Cloud. Cold queries serve a persistent snapshot instantly and
// refresh in the background; delta sync fetches only entries newer than the
// snapshot's max created_at and falls back to a full walk when counts disagree.
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import { log } from '../core/log.js';
import { req } from '../core/http.js';
import { ensureDir } from '../utils/disk.js';
import { tempPath, removeTemp } from './transfer.js';

const plog = log.child('papers');
const SNAPSHOT_VERSION = 1;
const SNAPSHOT_PATH = path.join(process.cwd(), config.dataDir, 'vault_snapshot.json');

// ─── SUBJECT MAP ─────────────────────────────────────────────────────────────
const SUBJECT_MAP = {
  CHEM: 'Chemistry', PHYS: 'Physics', BIOL: 'Biology',
  MATH: 'Mathematics', STAT: 'Statistics', COMP: 'Computer Science',
  NURS: 'Nursing', MEDI: 'Medicine', PHYM: 'Pharmacy',
  GEOG: 'Geography', GEOM: 'Geography (Ed)', HIST: 'History',
  ECON: 'Economics', ACCT: 'Accounting', MGTM: 'Management',
  MKTG: 'Marketing', LAWS: 'Law', EDUC: 'Education',
  ENGL: 'English', COMM: 'Communication', JOUR: 'Journalism',
  SOCI: 'Sociology', PSYC: 'Psychology', SWRK: 'Social Work',
  ENVS: 'Environmental Science', AGRI: 'Agriculture', FORE: 'Forestry',
  FOWS: 'Forest & Wood Science', FORM: 'Research Methods', GEOL: 'Geology',
  ENGR: 'Engineering', LIBR: 'Library Science', INFO: 'Information Science',
  TOUR: 'Tourism',
};

const MONTHS = ['january','february','march','april','may','june',
  'july','august','september','october','november','december'];

const WINDOW_PAGES = 20;      // restart the window well before the ~2,500-entry API cap
const PAGE_CONCURRENCY = 4;   // parallel page fetches per window
const DELTA_PAGE_CAP = 40;    // bigger delta than this → just do a full walk
const MEM_CACHE_TTL = 15 * 60_000;
const SNAPSHOT_MAX_AGE = 24 * 60 * 60_000;
const MAX_SEND_BYTES = 30 * 1024 * 1024;

export const isYear = (s) => /^(20|19)\d{2}$/.test(s);
export const isConfigured = () => Boolean(config.drimeApiToken && config.drimePapersFolderId && config.drimePapersFolderHash);

// ─── DRIME API ───────────────────────────────────────────────────────────────
function drime() {
  if (!config.drimeApiToken) {
    throw new Error('Drime API token not configured (set DRIME_API_TOKEN)');
  }
  return {
    get: (url, opts = {}) => req(`${config.drimeBaseUrl}${url}`, {
      retries: 0, timeout: opts.download ? 300_000 : 30_000,
      headers: { authorization: `Bearer ${config.drimeApiToken}` },
      ...opts,
    }),
  };
}

const getFolderCount = async (client, folderId, workspaceId) => {
  const res = await client.get(`/folders/${folderId}/count?workspaceId=${workspaceId}`);
  const count = res?.count ?? res?.data?.count;
  if (typeof count !== 'number' || count < 0) throw new Error('Drime folder count missing or invalid');
  return count;
};

// Web-client-style structured date filter: JSON -> base64 -> percent-encode.
const buildCreatedAtFilter = (lowerBound) =>
  encodeURIComponent(Buffer.from(JSON.stringify(
    [{ key: 'created_at', operator: '>=', value: lowerBound }]
  ), 'utf8').toString('base64'));

const rowToFile = (r) => ({
  id: r.id, hash: r.hash, name: r.name,
  size: r.file_size ?? r.size ?? 0, created_at: r.created_at,
});
const isFileRow = (r) => r.type !== 'folder' && !r.is_folder;

// ─── SNAPSHOT (disk persistence, compact tuples) ─────────────────────────────
function loadSnapshot() {
  try {
    const raw = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8'));
    if (!raw || raw.version !== SNAPSHOT_VERSION || !Array.isArray(raw.files)) return null;
    const files = raw.files.map(([id, hash, name, size, created_at]) => ({ id, hash, name, size, created_at }));
    let maxTs = raw.maxTs || '';
    if (!maxTs) for (const f of files) if (f.created_at > maxTs) maxTs = f.created_at;
    return { files, fetchedAt: raw.fetchedAt || 0, expected: raw.expected || files.length, folders: raw.folders || 0, maxTs };
  } catch { return null; }
}

function saveSnapshot(files, expected, folders) {
  try {
    let maxTs = '';
    const tuples = files.map(f => {
      if (f.created_at > maxTs) maxTs = f.created_at;
      return [f.id, f.hash, f.name, f.size, f.created_at];
    });
    const payload = JSON.stringify({ version: SNAPSHOT_VERSION, fetchedAt: Date.now(), expected, folders, maxTs, files: tuples });
    ensureDir(path.dirname(SNAPSHOT_PATH));
    const tmp = SNAPSHOT_PATH + '.tmp';
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, SNAPSHOT_PATH);   // atomic: readers never see a half-write
  } catch (e) {
    plog.warn('snapshot save failed:', e.message);
  }
}

// ─── VAULT (memory) ──────────────────────────────────────────────────────────
let _vault = null;
const _parseCache = new Map();

function indexVault(files, source) {
  _parseCache.clear();
  for (const f of files) _parseCache.set(f.id, parsePaper(f.name));
  _vault = { files, fetchedAt: Date.now(), source };
  return files;
}

const parsed = (file) => {
  let p = _parseCache.get(file.id);
  if (!p) { p = parsePaper(file.name); _parseCache.set(file.id, p); }
  return p;
};

// Walks the vault with inclusive created_at windows and parallel page fetches.
// startLower == null → full walk (target: `expected` unique IDs).
// startLower set    → delta walk (may throw DELTA_FALLBACK).
async function walkVault(client, folderId, folderHash, workspaceId, expected, startLower) {
  const isDelta = !!startLower;
  const seen = new Map();
  let lower = startLower || null, maxTs = startLower || null;
  let requests = 0, pagesFetched = 0, uniqueAtWindowStart = 0, prevFp = null, window = 1;
  const requestLimit = Math.max(1000, (expected || 1000) * 4);
  const deltaFallback = () => Object.assign(new Error('delta unusable'), { code: 'DELTA_FALLBACK' });

  const fetchPage = (page) => {
    if (++requests > requestLimit) throw new Error(`Drime listing request limit reached (${seen.size} collected)`);
    pagesFetched++;
    if (isDelta && pagesFetched > DELTA_PAGE_CAP) throw deltaFallback();
    const params = new URLSearchParams({
      workspaceId: String(workspaceId), folderId: folderHash, pageId: folderHash,
      page: String(page), perPage: '100', orderBy: 'created_at', orderDir: 'asc',
    });
    if (lower) params.set('filters', buildCreatedAtFilter(lower));
    return client.get(`/drive/file-entries?${params}`).then(res => ({
      page, rows: res?.data || [], cur: res?.current_page,
    }));
  };

  const processPage = ({ page, rows, cur }) => {
    if (!rows.length) {
      if (isDelta || seen.size >= expected) return 'done';
      throw new Error(`Drime returned an empty page (${seen.size}/${expected} collected)`);
    }
    // the API repeats an earlier page past ~2,500 entries: detect, never ingest
    const fp = rows.map(r => r.id).sort((a, b) => a - b).join(',');
    if (cur !== page || (prevFp && fp === prevFp)) return 'rotate';
    prevFp = fp;
    for (const r of rows) {
      if (r.parent_id !== folderId) throw new Error('Drime returned an entry from another folder — aborting');
      if (typeof r.created_at !== 'string') throw new Error('Drime returned an entry without created_at — aborting');
      if (lower && r.created_at < lower) throw new Error('Drime ignored the date filter — aborting');
      if (!seen.has(r.id)) seen.set(r.id, r);
      if (!maxTs || r.created_at > maxTs) maxTs = r.created_at;
    }
    if (!isDelta && seen.size >= expected) return 'done';
    return 'ok';
  };

  const rotate = (reason) => {
    if (maxTs === lower && seen.size === uniqueAtWindowStart) {
      if (isDelta) return false;
      throw new Error(`Drime listing cannot advance past ${lower}: too many entries share one identical timestamp.`);
    }
    lower = maxTs; uniqueAtWindowStart = seen.size; prevFp = null; window++;
    plog.info(`${reason} — new window: created_at >= ${lower} (${seen.size}/${expected || '?'})`);
    return true;
  };

  for (;;) {
    let status = 'ok';
    for (let start = 1; start <= WINDOW_PAGES && status === 'ok'; start += PAGE_CONCURRENCY) {
      const end = Math.min(start + PAGE_CONCURRENCY, WINDOW_PAGES + 1);
      const batch = [];
      for (let p = start; p < end; p++) batch.push(fetchPage(p));
      const results = await Promise.all(batch);   // concurrent I/O, ordered processing
      for (const r of results) { status = processPage(r); if (status !== 'ok') break; }
    }
    if (status === 'done') break;
    if (!rotate(status === 'rotate' ? `API repeated a page (window ${window})` : 'window page budget reached')) break;
  }
  return seen;
}

// Refresh to current truth: delta when possible, full walk otherwise.
async function refreshVault() {
  const client = drime();
  const folderId = config.drimePapersFolderId;
  const folderHash = config.drimePapersFolderHash;
  const workspaceId = config.drimeWorkspaceId || 0;
  if (!folderId) throw new Error('Drime papersFolderId not set (DRIME_PAPERS_FOLDER_ID)');
  if (!folderHash) throw new Error('Drime papersFolderHash not set (DRIME_PAPERS_FOLDER_HASH)');

  const expected = await getFolderCount(client, folderId, workspaceId);
  if (expected === 0) { saveSnapshot([], 0, 0); return { files: [], source: 'empty' }; }

  const snap = loadSnapshot();
  const needsFull = !snap || !snap.files.length || Date.now() - snap.fetchedAt > SNAPSHOT_MAX_AGE;

  if (!needsFull) {
    try {
      const seen = await walkVault(client, folderId, folderHash, workspaceId, expected, snap.maxTs);
      const merged = new Map(snap.files.map(f => [f.id, f]));
      for (const r of seen.values()) if (isFileRow(r)) merged.set(r.id, rowToFile(r));
      if (merged.size + (snap.folders || 0) !== expected) throw Object.assign(new Error('delta unusable'), { code: 'DELTA_FALLBACK' });
      const files = [...merged.values()];
      saveSnapshot(files, expected, snap.folders || 0);
      return { files, source: 'delta' };
    } catch (e) {
      if (e.code !== 'DELTA_FALLBACK') throw e;
      plog.info('delta unusable, falling back to full walk');
    }
  }

  plog.info(`full vault walk (${expected} entries)…`);
  const seen = await walkVault(client, folderId, folderHash, workspaceId, expected, null);
  const rows = [...seen.values()];
  const files = rows.filter(isFileRow).map(rowToFile);
  const folders = rows.length - files.length;
  saveSnapshot(files, expected, folders);
  return { files, source: 'full-walk' };
}

let _refreshing = null, _refreshCoolUntil = 0;

/** Single-flight refresh: concurrent callers join the same walk. */
export function refreshOnce() {
  if (!_refreshing) {
    _refreshing = refreshVault()
      .then(res => { indexVault(res.files, res.source); return res; })
      .finally(() => { _refreshing = null; });
  }
  return _refreshing;
}

function backgroundRefresh() {
  if (_refreshing || Date.now() < _refreshCoolUntil) return;
  refreshOnce()
    .then(({ files, source }) => plog.info(`background refresh done (${source}, ${files.length} files)`))
    .catch(e => {
      plog.warn('background refresh failed:', e.message);
      _refreshCoolUntil = Date.now() + 60_000;   // don't hammer a failing API
    });
}

// Serving path: memory → disk snapshot (instant + background refresh) → blocking walk.
export async function ensureVault() {
  if (_vault && Date.now() - _vault.fetchedAt < MEM_CACHE_TTL) return _vault.files;
  if (!_vault) {
    const snap = loadSnapshot();
    if (snap) { indexVault(snap.files, 'snapshot'); backgroundRefresh(); return _vault.files; }
    await refreshOnce();
    return _vault.files;
  }
  backgroundRefresh();
  return _vault.files;
}

export async function listAllFiles(useCache = true) {
  if (!useCache) {
    _refreshCoolUntil = 0;
    await refreshOnce();
    return _vault.files;
  }
  return ensureVault();
}

// ─── PARSING / SEARCH ────────────────────────────────────────────────────────
export function cleanName(filename) {
  return String(filename || '').replace(/\.pdf$/i, '').replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Parse a vault filename into {courseCode, moduleNumber, subjectName, type, year, month…}. */
export function parsePaper(filename) {
  const name = String(filename || '').toLowerCase();
  const clean = cleanName(filename);
  const codeMatch = clean.match(/\b([A-Z]{2,6})\s*(\d{3,4})\b/i);
  const courseCode = codeMatch ? codeMatch[1].toUpperCase() : '';
  const moduleNumber = codeMatch ? codeMatch[2] : '';
  const subjectName = SUBJECT_MAP[courseCode] || '';

  let type = 'Examination';
  if (/supp|supplementary/i.test(name)) type = 'Supplementary';
  if (/defer|deferr/i.test(name)) type = 'Deferred';
  if (/odel|odl/i.test(name)) type = 'ODL';
  if (/end[\s\-]of[\s\-](semester|year|term)/i.test(name)) type = 'End of Semester';

  // NOTE: \b fails on underscore filenames ("X_2023.pdf" — _ and 2 are both
  // word chars, so no boundary). Lookarounds handle every separator properly.
  const yearMatch = String(filename || '').match(/(?<![0-9])(20\d{2}|19\d{2})(?![0-9])/);
  const year = yearMatch ? yearMatch[0] : '';
  const month = MONTHS.find(m => name.includes(m)) || '';
  const monthDisplay = month ? month.charAt(0).toUpperCase() + month.slice(1) : '';

  return { courseCode, moduleNumber, subjectName, type, year, month, monthDisplay, clean };
}

/** Client-side "contains" filtering with prefix-aware course match. */
export async function searchFiles(courseCode, moduleNumber, year) {
  const all = await listAllFiles();
  const cc = courseCode.toUpperCase();
  return all.filter(f => {
    const upper = f.name.toUpperCase();
    if (!upper.includes(cc)) return false;
    if (moduleNumber && !upper.includes(String(moduleNumber).toUpperCase())) return false;
    if (year && !upper.includes(String(year))) return false;
    return true;
  });
}

export function deduplicateFiles(files, courseCode, moduleNumber) {
  const seenIds = new Set(), seenContent = new Set(), seenKeys = new Set();
  const finalList = [];
  const sc = courseCode.toUpperCase();
  for (const file of files) {
    if (seenIds.has(file.id)) continue;
    seenIds.add(file.id);
    const fp = `size:${parseInt(file.size || 0)}`;
    if (fp !== 'size:0') {
      if (seenContent.has(fp)) continue;
      seenContent.add(fp);
    }
    const p = parsed(file);
    const pc = p.courseCode;
    if (pc !== sc && !pc.startsWith(sc) && !sc.startsWith(pc)) continue;   // GEO matches GEOG, GEOM…
    if (moduleNumber && p.moduleNumber !== moduleNumber) continue;
    const key = [pc, p.moduleNumber || 'any', p.type, p.year, p.month].join('-');
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    finalList.push(file);
  }
  return finalList;
}

export function sortPapers(files) {
  return files.sort((a, b) => {
    const ya = parseInt(parsed(a).year) || 0, yb = parseInt(parsed(b).year) || 0;
    if (yb !== ya) return yb - ya;
    return parsed(a).clean.localeCompare(parsed(b).clean);
  });
}

// ─── "did you mean" (deterministic, offline, free) ───────────────────────────
export function editDistance(a, b) {
  const s = String(a || ''), t = String(b || '');
  if (s === t) return 0;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const cur = [i];
    for (let j = 1; j <= t.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[t.length];
}

export function nearest(code, module, entries, { limit = 4 } = {}) {
  const wanted = String(code || '').toUpperCase().trim();
  if (wanted.length < 2 || !Array.isArray(entries)) return [];
  const scored = [];
  for (const e of entries) {
    const have = String(e.code || '').toUpperCase();
    if (!have) continue;
    const samePrefix = have.startsWith(wanted) || wanted.startsWith(have);
    const codeDistance = editDistance(wanted, have);
    if (codeDistance > 3 && !samePrefix) continue;
    const moduleDistance = module ? editDistance(String(module), String(e.module || '')) : 0;
    if (have === wanted && module && moduleDistance > 2) continue;
    const distance = codeDistance * 2 + moduleDistance - (have === wanted ? 1 : 0);
    scored.push({ ...e, code: have, distance: Math.max(0, distance) });
  }
  return scored
    .sort((a, b) => a.distance - b.distance || (b.count || 0) - (a.count || 0))
    .slice(0, limit);
}

async function suggestNearby(courseCode, moduleNumber) {
  try {
    const tally = new Map();
    for (const f of await listAllFiles()) {
      const p = parsed(f);
      if (!p.courseCode) continue;
      const key = `${p.courseCode}:${p.moduleNumber || ''}`;
      const e = tally.get(key) || { code: p.courseCode, module: p.moduleNumber || '', count: 0, years: new Set() };
      e.count += 1;
      if (p.year) e.years.add(p.year);
      tally.set(key, e);
    }
    return nearest(courseCode, moduleNumber, [...tally.values()].map(e => ({ ...e, years: [...e.years].sort().slice(-3).join(', ') })));
  } catch { return []; }
}

export async function nearbyHint(courseCode, moduleNumber) {
  const near = await suggestNearby(courseCode, moduleNumber);
  if (!near.length) return '';
  const lines = near.map(n => `  .paper ${n.code.toLowerCase()}${n.module ? ` ${n.module}` : ''} _(${n.count}${n.years ? `, ${n.years}` : ''})_`);
  return `\n*Closest in the vault:*\n${lines.join('\n')}\n`;
}

export async function browseAll() {
  const files = await listAllFiles();
  const codes = new Map();
  for (const file of files) {
    const { courseCode } = parsed(file);
    if (!courseCode) continue;
    codes.set(courseCode, (codes.get(courseCode) || 0) + 1);
  }
  return new Map([...codes.entries()].sort());
}

export async function browseCode(courseCode) {
  const files = await searchFiles(courseCode, null, null);
  const modules = new Map();
  for (const file of files) {
    const p = parsed(file);
    const sc = courseCode.toUpperCase();
    const pc = p.courseCode;
    if (pc !== sc && !pc.startsWith(sc) && !sc.startsWith(pc)) continue;
    const key = `${pc}:${p.moduleNumber || 'Unknown'}`;
    if (!modules.has(key)) modules.set(key, []);
    modules.get(key).push(file);
  }
  return new Map([...modules.entries()].sort());
}

// Streams a paper to a temp file (never held in RAM) — caller must delete it.
export async function downloadFileToDisk(file) {
  const tmp = tempPath('paper', 'pdf');
  const client = drime();
  try {
    const res = await fetch(`${config.drimeBaseUrl}/file-entries/download/${file.hash}`, {
      headers: { authorization: `Bearer ${config.drimeApiToken}` },
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) throw new Error(`Drime download HTTP ${res.status}`);
    const { pipeline } = await import('node:stream/promises');
    const { Readable } = await import('node:stream');
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
    return tmp;
  } catch (e) {
    removeTemp(tmp);
    throw e;
  }
}

/** Boot prefetch: index the on-disk snapshot instantly (never blocks). */
try {
  const bootSnap = loadSnapshot();
  if (bootSnap) indexVault(bootSnap.files, 'snapshot');
} catch { /* cold start proceeds on first query */ }

export const SUBJECTS = SUBJECT_MAP;
export const MAX_PAPER_BYTES = MAX_SEND_BYTES;

import * as papersNamespace from './papers.js';
export default papersNamespace;
