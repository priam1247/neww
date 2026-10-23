/**
 * ZaFar Bot — Past Papers v6.2 (Drime Cloud storage)
 *
 * .paper <code>                     → all papers for a subject
 * .paper <code> <module>            → specific module
 * .paper <code> <module> <year>     → specific year
 * .paper browse                     → see all course codes
 * .paper browse <code>              → see all modules under a code
 * .countpapers                      → count all papers in the vault
 * .refreshpapers                    → (owner) force a vault refresh now
 *
 * v6.2 notes (speed + lightness):
 * - Persistent vault snapshot (database/vault_snapshot.json). Cold queries
 *   serve the snapshot instantly and refresh in the background — only the
 *   very first run ever blocks on a full walk.
 * - Delta sync: refreshes fetch only entries with created_at >= snapshot max
 *   (usually 1–3 requests) and fall back to a full walk if counts disagree.
 * - Parallel page fetch (8 concurrent) + one shared keep-alive HTTPS agent:
 *   full re-walk measured ~5× faster than sequential.
 * - Streaming downloads to disk (parallel download phase, sequential sends):
 *   RAM stays flat no matter the PDF size; no more 30s-timeout deaths.
 * - Filenames are parsed once at vault load and cached (sort/search reuse).
 */

const axios  = require('axios');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const { pipeline } = require('stream/promises');
const config    = require('../../config');
const database  = require('../../database');
const { createTempFilePath, deleteTempFile } = require('../../utils/tempManager');

// ─── SUBJECT MAP ──────────────────────────────────────────────────────────────
const SUBJECT_MAP = {
  CHEM: 'Chemistry',        PHYS: 'Physics',          BIOL: 'Biology',
  MATH: 'Mathematics',      STAT: 'Statistics',       COMP: 'Computer Science',
  NURS: 'Nursing',          MEDI: 'Medicine',         PHYM: 'Pharmacy',
  GEOG: 'Geography',        GEOM: 'Geography (Ed)',   HIST: 'History',
  ECON: 'Economics',        ACCT: 'Accounting',       MGTM: 'Management',
  MKTG: 'Marketing',        LAWS: 'Law',              EDUC: 'Education',
  ENGL: 'English',          COMM: 'Communication',    JOUR: 'Journalism',
  SOCI: 'Sociology',        PSYC: 'Psychology',       SWRK: 'Social Work',
  ENVS: 'Environmental Science', AGRI: 'Agriculture', FORE: 'Forestry',
  FOWS: 'Forest & Wood Science', FORM: 'Research Methods', GEOL: 'Geology',
  ENGR: 'Engineering',      LIBR: 'Library Science',  INFO: 'Information Science',
  TOUR: 'Tourism',
};

const MONTHS = [
  'january','february','march','april','may','june',
  'july','august','september','october','november','december',
];

// ─── TUNABLES ─────────────────────────────────────────────────────────────────
const WINDOW_PAGES      = 20;   // restart the window well before the ~2,500-entry API cap
const PAGE_CONCURRENCY  = 8;    // parallel page fetches per window (measured ~5.7× win)
const DELTA_PAGE_CAP    = 40;   // bigger delta than this → just do a full walk
const MEM_CACHE_TTL     = 15 * 60 * 1000;       // serve memory, refresh in background
const SNAPSHOT_MAX_AGE  = 24 * 60 * 60 * 1000;  // snapshot older → full re-walk
const paperSearch       = require('../../utils/paperSearch');
// No cap by default (.paper always sent every paper). Set PAPER_MAX_SEND_MB
// only if the host truly cannot push large files.
const MAX_SEND_BYTES    = Number(process.env.PAPER_MAX_SEND_MB || 0) * 1024 * 1024;
const SNAPSHOT_VERSION  = 1;
const SNAPSHOT_PATH     = path.join(__dirname, '../../database/vault_snapshot.json');

// One shared keep-alive agent for ALL Drime requests (module singleton —
// creating it per-request would defeat connection reuse).
const _httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10, timeout: 60000 });

// In-memory vault: { files, fetchedAt, source } — files carry parsed cache via _parseCache.
let _vault = null;
const _parseCache = new Map(); // file id -> parsePaper(name)

const isYear = (s) => /^(20|19)\d{2}$/.test(s);

async function react(sock, msg, emoji) {
  try { await sock.sendMessage(msg.key.remoteJid, { react: { text: emoji, key: msg.key } }); }
  catch (_) {}
}

// ─── DRIME CLOUD ──────────────────────────────────────────────────────────────
function drimeClient(download = false) {
  const token = config.drime?.apiToken;
  if (!token) throw new Error('Drime API token not configured (set the DRIME_API_TOKEN env var)');
  const client = axios.create({
    baseURL: config.drime?.baseUrl || 'https://app.drime.cloud/api/v1',
    timeout: download ? 300000 : 30000,
    httpsAgent: _httpsAgent,
    headers: { Authorization: `Bearer ${token}` },
  });

  // Surface Drime's actual error message/status instead of a bare axios
  // "Request failed with status code XXX" — makes 401/403/404s debuggable.
  client.interceptors.response.use(
    (res) => res,
    (err) => {
      if (err.response) {
        const status = err.response.status;
        let detail = '';
        try {
          const data = err.response.data;
          detail = (data && (data.message || data.error)) ||
            (Buffer.isBuffer(data) ? Buffer.from(data).toString('utf-8').slice(0, 200) : JSON.stringify(data).slice(0, 200));
        } catch (_) { /* ignore */ }
        err.message = `Drime API ${status}${detail ? `: ${detail}` : ''}`;
      }
      return Promise.reject(err);
    }
  );

  return client;
}

// Cheap headline count (1 request, always fresh).
async function getFolderCount(client, folderId, workspaceId) {
  const res = await client.get(`/folders/${folderId}/count`, { params: { workspaceId } });
  const count = res.data?.count;
  if (typeof count !== 'number' || count < 0) throw new Error('Drime folder count missing or invalid');
  return count;
}

// Web-client-style structured date filter: JSON -> base64 -> percent-encode.
// Axios's params serializer applies the second encoding on the wire.
function buildCreatedAtFilter(lowerBound) {
  const json = JSON.stringify([{ key: 'created_at', operator: '>=', value: lowerBound }]);
  return encodeURIComponent(Buffer.from(json, 'utf8').toString('base64'));
}

const deltaFallback = () => {
  const e = new Error('delta unusable');
  e.code = 'DELTA_FALLBACK';
  return e;
};

const rowToFile = (r) => ({
  id: r.id, hash: r.hash, name: r.name,
  size: r.file_size ?? r.size ?? 0, created_at: r.created_at,
});
const isFileRow = (r) => r.type !== 'folder' && !r.is_folder;

// ─── SNAPSHOT (disk persistence) ──────────────────────────────────────────────
// Compact tuple format: [id, hash, name, size, created_at] — ~1–2 MB for 11k files.
const { writeRawAtomic, readJsonSafe } = require('../../utils/jsonStore');

function loadSnapshot() {
  const res = readJsonSafe(SNAPSHOT_PATH, {
    defaultValue: null,
    validate: (raw) => raw === null || (raw && raw.version === SNAPSHOT_VERSION && Array.isArray(raw.files)),
  });
  if (!res.ok || !res.data) return null;
  const raw = res.data;
  const files = raw.files.map(([id, hash, name, size, created_at]) => ({ id, hash, name, size, created_at }));
  let maxTs = raw.maxTs || '';
  if (!maxTs) for (const f of files) if (f.created_at > maxTs) maxTs = f.created_at;
  return { files, fetchedAt: raw.fetchedAt || 0, expected: raw.expected || files.length, folders: raw.folders || 0, maxTs };
}

function saveSnapshot(files, expected, folders) {
  try {
    let maxTs = '';
    const tuples = files.map(f => {
      if (f.created_at > maxTs) maxTs = f.created_at;
      return [f.id, f.hash, f.name, f.size, f.created_at];
    });
    const payload = JSON.stringify({ version: SNAPSHOT_VERSION, fetchedAt: Date.now(), expected, folders, maxTs, files: tuples });
    writeRawAtomic(SNAPSHOT_PATH, payload);
    try { writeRawAtomic(`${SNAPSHOT_PATH}.bak`, payload); } catch { /* non-fatal */ }
  } catch (e) {
    console.warn('[paper] snapshot save failed:', e.message);
  }
}

// ─── VAULT (memory) ───────────────────────────────────────────────────────────
function indexVault(files, source) {
  _parseCache.clear();
  for (const f of files) _parseCache.set(f.id, parsePaper(f.name));
  _vault = { files, fetchedAt: Date.now(), source };
  return files;
}

// Cached filename parse (sort/search/display all reuse; ~10× fewer parses).
function parsed(file) {
  let p = _parseCache.get(file.id);
  if (!p) {
    p = parsePaper(file.name);
    _parseCache.set(file.id, p);
  }
  return p;
}

// Walks the vault with inclusive created_at windows and parallel page fetch.
// startLower == null → full walk (target: `expected` unique IDs).
// startLower set    → delta walk (drains the filtered set, may throw DELTA_FALLBACK).
async function walkVault(client, folderId, folderHash, workspaceId, expected, startLower) {
  const isDelta = !!startLower;
  const seen = new Map(); // id -> raw row
  let lower = startLower || null, maxTs = startLower || null;
  let requests = 0, pagesFetched = 0, window = 1, uniqueAtWindowStart = 0, prevFp = null;
  const requestLimit = Math.max(1000, (expected || 1000) * 4);

  const fetchPage = (page) => {
    if (++requests > requestLimit) throw new Error(`Drime listing request limit reached (${seen.size} collected)`);
    pagesFetched++;
    if (isDelta && pagesFetched > DELTA_PAGE_CAP) throw deltaFallback();
    const params = {
      workspaceId, folderId: folderHash, pageId: folderHash,
      page, perPage: 100, orderBy: 'created_at', orderDir: 'asc',
    };
    if (lower) params.filters = buildCreatedAtFilter(lower);
    return client.get('/drive/file-entries', { params }).then(res => ({
      page, rows: res.data?.data || [], cur: res.data?.current_page,
    }));
  };

  const processPage = (result) => { // 'ok' | 'done' | 'rotate' (throws on corruption)
    const { page, rows, cur } = result;
    if (!rows.length) {
      if (isDelta || seen.size >= expected) return 'done';
      throw new Error(`Drime returned an empty page (${seen.size}/${expected} collected)`);
    }
    // The API repeats an earlier page past ~2,500 entries: detect, never ingest.
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

  const rotate = (reason) => { // false → delta finished with nothing new
    if (maxTs === lower && seen.size === uniqueAtWindowStart) {
      if (isDelta) return false;
      throw new Error(
        `Drime listing cannot advance past ${lower}: too many entries share one identical timestamp. ` +
        `Aborting rather than returning a partial list.`
      );
    }
    lower = maxTs; uniqueAtWindowStart = seen.size; prevFp = null; window++;
    console.log(`[paper] ${reason} — new window: created_at >= ${lower} (${seen.size}/${expected || '?'})`);
    return true;
  };

  while (true) {
    let status = 'ok';
    for (let start = 1; start <= WINDOW_PAGES && status === 'ok'; start += PAGE_CONCURRENCY) {
      const end = Math.min(start + PAGE_CONCURRENCY, WINDOW_PAGES + 1);
      const batch = [];
      for (let p = start; p < end; p++) batch.push(fetchPage(p));
      const results = await Promise.all(batch); // concurrent I/O, ordered processing
      for (const r of results) {
        status = processPage(r);
        if (status !== 'ok') break;
      }
    }
    if (status === 'done') break;
    if (!rotate(status === 'rotate' ? `API repeated a page (window ${window})` : 'window page budget reached')) break;
  }
  return seen;
}

// Refresh to current truth: delta when possible, full walk otherwise.
async function refreshVault() {
  const client      = drimeClient();
  const folderId    = config.drime?.papersFolderId;
  const folderHash  = config.drime?.papersFolderHash;
  const workspaceId = config.drime?.workspaceId || 0;
  if (!folderId)   throw new Error('Drime papersFolderId not set in config.js');
  if (!folderHash) throw new Error('Drime papersFolderHash not set in config.js');

  const expected = await getFolderCount(client, folderId, workspaceId);
  if (expected === 0) {
    saveSnapshot([], 0, 0);
    return { files: [], source: 'empty' };
  }

  const snap = loadSnapshot();
  const needsFull = !snap || !snap.files.length || Date.now() - snap.fetchedAt > SNAPSHOT_MAX_AGE;

  if (!needsFull) {
    try {
      const seen = await walkVault(client, folderId, folderHash, workspaceId, expected, snap.maxTs);
      const merged = new Map(snap.files.map(f => [f.id, f]));
      for (const r of seen.values()) {
        if (isFileRow(r)) merged.set(r.id, rowToFile(r));
      }
      // Composition changed unexpectedly (e.g. deletions)? Fall back to full walk.
      if (merged.size + (snap.folders || 0) !== expected) throw deltaFallback();
      const files = [...merged.values()];
      saveSnapshot(files, expected, snap.folders || 0);
      return { files, source: 'delta' };
    } catch (e) {
      if (e.code !== 'DELTA_FALLBACK') throw e;
      console.log('[paper] delta unusable, falling back to full walk');
    }
  }

  console.log(`[paper] full vault walk (${expected} entries)…`);
  const seen = await walkVault(client, folderId, folderHash, workspaceId, expected, null);
  const rows = [...seen.values()];
  const files = rows.filter(isFileRow).map(rowToFile);
  const folders = rows.length - files.length;
  saveSnapshot(files, expected, folders);

  try {
    const after = await getFolderCount(client, folderId, workspaceId);
    if (after !== expected) console.warn(`[paper] vault changed during listing (${expected} -> ${after})`);
  } catch (_) { /* best-effort */ }

  return { files, source: 'full-walk' };
}

let _refreshing = null, _refreshCoolUntil = 0;
// Single-flight refresh: concurrent callers (foreground query + boot timer)
// join the same walk instead of doubling ~120 requests.
function refreshOnce() {
  if (!_refreshing) {
    _refreshing = refreshVault()
      .then(res => {
        indexVault(res.files, res.source);
        return res;
      })
      .finally(() => { _refreshing = null; });
  }
  return _refreshing;
}
function backgroundRefresh() {
  if (_refreshing || Date.now() < _refreshCoolUntil) return;
  refreshOnce()
    .then(({ files, source }) => {
      console.log(`[paper] background refresh done (${source}, ${files.length} files)`);
    })
    .catch(e => {
      console.warn('[paper] background refresh failed:', e.message);
      _refreshCoolUntil = Date.now() + 60000; // don't hammer a failing API
    });
}

// Serving path: memory → disk snapshot (instant + background refresh) → blocking walk.
async function ensureVault() {
  if (_vault && Date.now() - _vault.fetchedAt < MEM_CACHE_TTL) return _vault.files;
  if (!_vault) {
    const snap = loadSnapshot();
    if (snap) {
      indexVault(snap.files, 'snapshot');
      backgroundRefresh();
      return _vault.files;
    }
    await refreshOnce(); // true cold start: first run ever (joins any in-flight walk)
    return _vault.files;
  }
  backgroundRefresh(); // stale memory: serve it, refresh behind the scenes
  return _vault.files;
}

async function listAllFiles(useCache = true) {
  if (!useCache) {
    _refreshCoolUntil = 0; // explicit refresh bypasses the failure cooldown
    await refreshOnce();
    return _vault.files;
  }
  return ensureVault();
}

// Client-side "contains" filtering — mirrors the old Drive query behaviour.
async function searchFiles(courseCode, moduleNumber, year) {
  const all = await listAllFiles();
  const cc  = courseCode.toUpperCase();

  return all.filter(f => {
    const upper = f.name.toUpperCase();
    if (!upper.includes(cc)) return false;
    if (moduleNumber && !upper.includes(String(moduleNumber).toUpperCase())) return false;
    if (year && !upper.includes(String(year))) return false;
    return true;
  });
}

// Streams a paper to a temp file (never held in RAM) — caller must delete it.
async function downloadFileToDisk(file) {
  const tmp = createTempFilePath('paper', 'pdf');
  const client = drimeClient(true); // long timeout for big PDFs
  const res = await client.get(`/file-entries/download/${file.hash}`, { responseType: 'stream' });
  await pipeline(res.data, fs.createWriteStream(tmp));
  return tmp;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function formatSize(bytes) {
  if (!bytes) return '';
  const kb = parseInt(bytes) / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function cleanName(filename) {
  return filename.replace(/\.pdf$/i, '').replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim();
}

const NON_COURSE_WORDS = new Set([
  'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
  'JAN', 'FEB', 'MAR', 'APR', 'JUN', 'JUL', 'AUG', 'SEP', 'SEPT', 'OCT', 'NOV', 'DEC',
  'ALL', 'YEAR', 'EXAM', 'EXAMS', 'PAPER', 'PAPERS', 'PART', 'SEM', 'SEMESTER',
  'PAGE', 'LEVEL', 'BATCH', 'COHORT', 'FINAL', 'END', 'SUPP', 'DEFER', 'DEFERRED',
  'MZUNI', 'UNIVERSITY', 'DEGREE', 'DIPLOMA',
]);

function parsePaper(filename) {
  const name  = filename.toLowerCase();
  const clean = cleanName(filename);

  let courseCode = '';
  let moduleNumber = '';
  const allMatches = [...clean.matchAll(/\b([A-Z]{2,6})\s*(\d{3,4})\b/gi)];
  for (const m of allMatches) {
    const candCode = m[1].toUpperCase();
    const candNum = m[2];
    if (NON_COURSE_WORDS.has(candCode)) continue;
    courseCode = candCode;
    moduleNumber = candNum;
    break;
  }
  const subjectName = SUBJECT_MAP[courseCode] || '';

  let type = 'Examination';
  if (/supp|supplementary/i.test(name)) type = 'Supplementary';
  if (/defer|deferr/i.test(name))       type = 'Deferred';
  if (/odel|odl/i.test(name))           type = 'ODL';
  if (/end[\s\-]of[\s\-](semester|year|term)/i.test(name)) type = 'End of Semester';

  const yearMatch    = filename.match(/\b(20\d{2}|19\d{2})\b/);
  const year         = yearMatch ? yearMatch[0] : '';
  const month        = MONTHS.find(m => name.includes(m)) || '';
  const monthDisplay = month ? month.charAt(0).toUpperCase() + month.slice(1) : '';

  return { courseCode, moduleNumber, subjectName, type, year, month, monthDisplay, clean };
}

function deduplicateFiles(files, courseCode, moduleNumber) {
  const seenIds = new Set(), seenContent = new Set(), seenKeys = new Set();
  const finalList = [];
  const sc = courseCode.toUpperCase();

  for (const file of files) {
    if (seenIds.has(file.id)) continue;
    seenIds.add(file.id);

    const fp = `size:${parseInt(file.size || 0)}`;
    if (fp !== 'size:0' && seenContent.has(fp)) continue;
    if (fp !== 'size:0') seenContent.add(fp);

    const parsedP = parsed(file);
    const pc = parsedP.courseCode;

    // Prefix-aware match: GEO matches GEOG, GEOM etc.
    if (pc !== sc && !pc.startsWith(sc) && !sc.startsWith(pc)) continue;
    if (moduleNumber && parsedP.moduleNumber !== moduleNumber) continue;

    const key = [pc, parsedP.moduleNumber || 'any', parsedP.type, parsedP.year, parsedP.month].join('-');
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    finalList.push(file);
  }
  return finalList;
}

function sortPapers(files) {
  return files.sort((a, b) => {
    const ya = parseInt(parsed(a).year) || 0;
    const yb = parseInt(parsed(b).year) || 0;
    if (yb !== ya) return yb - ya;
    return parsed(a).clean.localeCompare(parsed(b).clean);
  });
}

// ─── "did you mean" ───────────────────────────────────────────────────────────
// A typo (`.paper nurs 2210`) should not dead-end. Every file name in the vault
// is already parsed for memory, so this is offline, instant and free: the
// matching is deterministic and local; this only counts what the vault holds.
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
    return paperSearch.nearest(courseCode, moduleNumber, [...tally.values()].map(e => ({ ...e, years: [...e.years].sort().slice(-3).join(', ') })));
  } catch {
    return [];
  }
}

/** One-line hint block for a not-found reply. Empty string when nothing is close. */
async function nearbyHint(courseCode, moduleNumber) {
  const near = await suggestNearby(courseCode, moduleNumber);
  if (!near.length) return '';
  const lines = near.map(n => `  .paper ${n.code.toLowerCase()}${n.module ? ` ${n.module}` : ''} _(${n.count}${n.years ? `, ${n.years}` : ''})_`);
  return `\n*Closest in the vault:*\n${lines.join('\n')}\n`;
}

async function browseAll() {
  const files = await listAllFiles();
  const codes = new Map();
  for (const file of files) {
    const { courseCode } = parsed(file);
    if (!courseCode) continue;
    codes.set(courseCode, (codes.get(courseCode) || 0) + 1);
  }
  return new Map([...codes.entries()].sort());
}

async function browseCode(courseCode) {
  const files   = await searchFiles(courseCode, null, null);
  const modules = new Map();
  const sc = courseCode.toUpperCase();
  for (const file of files) {
    const parsedP = parsed(file);
    const pc = parsedP.courseCode;
    if (!pc) continue;
    if (pc !== sc && !pc.startsWith(sc)) continue;
    const key = `${pc}:${parsedP.moduleNumber || 'Unknown'}`;
    if (!modules.has(key)) modules.set(key, []);
    modules.get(key).push(file);
  }
  return new Map([...modules.entries()].sort());
}

const BROWSE_CODES_PER_PAGE = 40;
const BROWSE_MODULES_PER_PAGE = 25;
const MAX_PAPERS_PER_QUERY = Math.max(1, Math.min(20, Number(process.env.PAPER_MAX_PER_QUERY) || 10));

// ─── .paper COMMAND ───────────────────────────────────────────────────────────
module.exports = {
  name: 'paper',
  aliases: ['papers', 'pastpaper', 'pp'],
  category: 'general',
  description: 'Search past exam papers',
  usage: '.paper <code> [module] [year]',

  async execute(sock, msg, args, extra) {
    const P = config.prefix || '.';
    const telemetry = require('../../utils/telemetry');
    try {
      if (!args.length) {
        return extra.reply(
          `📚 *Usage:* ${P}paper <code> [module] [year]\n` +
          `${P}paper browse [code] [page]`
        );
      }

      const mode = args[0].toLowerCase();

      if (mode === 'browse') {
        const status = await extra.status('🔍 Searching...');
        const arg1 = args[1] ? String(args[1]).trim() : '';
        const arg1IsPage = /^\d+$/.test(arg1);

        if (arg1 && !arg1IsPage) {
          const code    = arg1.toUpperCase();
          const reqPage = Math.max(1, parseInt(args[2], 10) || 1);
          const modules = await browseCode(code);

          if (modules.size === 0) {
            const hint = await nearbyHint(code, null);
            return status.update(
              `❌ No papers for *${code}*.` + (hint ? `\n${hint}` : '')
            );
          }

          const entries = [...modules.entries()];
          const totalPages = Math.max(1, Math.ceil(entries.length / BROWSE_MODULES_PER_PAGE));
          const page = Math.min(reqPage, totalPages);
          const slice = entries.slice((page - 1) * BROWSE_MODULES_PER_PAGE, page * BROWSE_MODULES_PER_PAGE);

          const uniqueCodes = new Set(entries.map(([k]) => k.split(':')[0]));
          const headerCode = uniqueCodes.size === 1 ? [...uniqueCodes][0] : `${code}*`;
          const subjectName = SUBJECT_MAP[headerCode] || SUBJECT_MAP[code] || '';
          let text = `📂 *${headerCode}${subjectName ? ` — ${subjectName}` : ''}* _(page ${page}/${totalPages})_\n\n`;

          for (const [key, modFiles] of slice) {
            const [actualCode, mod] = key.split(':');
            const sorted = sortPapers(modFiles);
            const years  = [...new Set(sorted.map(f => parsed(f).year).filter(Boolean))];
            text += `*${actualCode} ${mod}* (${sorted.length}) · ${years.join(', ') || '—'}\n`;
          }

          if (totalPages > 1 && page < totalPages) {
            text += `\n_Next: ${P}paper browse ${code.toLowerCase()} ${page + 1}_`;
          }
          return status.update(text.trim());

        } else {
          const reqPage = arg1IsPage ? Math.max(1, parseInt(arg1, 10) || 1) : 1;
          const codes = await browseAll();

          if (codes.size === 0) {
            return status.update('❌ Vault is empty.');
          }

          const entries = [...codes.entries()];
          const totalPages = Math.max(1, Math.ceil(entries.length / BROWSE_CODES_PER_PAGE));
          const page = Math.min(reqPage, totalPages);
          const slice = entries.slice((page - 1) * BROWSE_CODES_PER_PAGE, page * BROWSE_CODES_PER_PAGE);

          let text = `📚 *Course Codes* (${codes.size} · page ${page}/${totalPages})\n\n`;
          for (const [code, count] of slice) {
            const name = SUBJECT_MAP[code] ? ` — ${SUBJECT_MAP[code]}` : '';
            text += `*${code}*${name} (${count})\n`;
          }
          if (page < totalPages) {
            text += `\n_Next: ${P}paper browse ${page + 1}_`;
          }
          return status.update(text.trim());
        }
      }

      // ── STANDARD SEARCH ─────────────────────────────────────────────────────
      const courseCode   = args[0].toUpperCase();
      const moduleNumber = (args[1] && !isYear(args[1])) ? args[1] : null;
      const yearArgs     = args.slice(moduleNumber ? 2 : 1).filter(isYear);

      const status = await extra.status('🔍 Searching...');

      let files;
      if (yearArgs.length > 1) {
        const results = await Promise.all(yearArgs.map(y => searchFiles(courseCode, moduleNumber, y)));
        files = deduplicateFiles(results.flat(), courseCode, moduleNumber || '');
      } else {
        const raw = await searchFiles(courseCode, moduleNumber, yearArgs[0] || null);
        files = deduplicateFiles(raw, courseCode, moduleNumber || '');
      }

      if (files.length === 0) {
        const label = [courseCode, moduleNumber, ...yearArgs].filter(Boolean).join(' ');
        const hint = await nearbyHint(courseCode, moduleNumber);
        return status.update(`❌ No papers for *${label}*.` + (hint ? `\n${hint}` : ''));
      }

      const sorted     = sortPapers(files);
      const yearsFound = [...new Set(sorted.map(f => parsed(f).year).filter(Boolean))].sort();
      const label      = [courseCode, moduleNumber].filter(Boolean).join(' ');
      const summary    = `📚 *${label}* — ${sorted.length} paper${sorted.length !== 1 ? 's' : ''}${yearsFound.length ? ` (${yearsFound.join(', ')})` : ''}`;

      if (sorted.length > 15 && !moduleNumber && !yearArgs.length) {
        return status.update(
          `${summary}\nSpecify a module: \`${P}paper ${courseCode.toLowerCase()} <module>\` or \`${P}paper browse ${courseCode.toLowerCase()}\``
        );
      }

      const recentlySent = [], toSend = [];
      for (const file of sorted) {
        if (!extra.isOwner && database.wasPaperSentRecently(extra.from, file.id)) {
          recentlySent.push(file);
        } else {
          toSend.push(file);
        }
      }

      if (toSend.length === 0) {
        return status.update('♻️ Already sent in this chat within the last 3 days.');
      }

      const allSendable = [], tooLarge = [];
      for (const file of toSend) {
        (MAX_SEND_BYTES && (file.size || 0) > MAX_SEND_BYTES ? tooLarge : allSendable).push(file);
      }
      const cappedCount = allSendable.length > MAX_PAPERS_PER_QUERY ? allSendable.length - MAX_PAPERS_PER_QUERY : 0;
      const sendable = cappedCount > 0 ? allSendable.slice(-MAX_PAPERS_PER_QUERY) : allSendable;

      const statusNotes = [summary];
      if (recentlySent.length > 0) statusNotes.push(`_${recentlySent.length} recent duplicate(s) skipped_`);
      if (tooLarge.length > 0) statusNotes.push(`_${tooLarge.length} oversized skipped_`);
      if (cappedCount > 0) statusNotes.push(`_Sending ${sendable.length} newest (+${cappedCount} older — add year to filter)_`);
      await status.update(statusNotes.join('\n'));

      if (sendable.length === 0) {
        return extra.reply('❌ Matching papers exceed the file size limit.');
      }

      for (let i = 0; i < sendable.length; i += 2) {
        const chunk = sendable.slice(i, i + 2);
        const jobs = await Promise.all(chunk.map(async (file) => {
          try {
            const tmp = await downloadFileToDisk(file);
            return { file, tmp };
          } catch (e) {
            return { file, error: e };
          }
        }));

        for (const job of jobs) {
          if (job.error) {
            telemetry.recordFailure('paper');
            console.warn('[paper] download failed:', job.file.name, job.error.message);
            await extra.reply(`⚠️ Failed: *${cleanName(job.file.name)}*`);
            continue;
          }
          try {
            const { type, year: fileYear, monthDisplay, subjectName: sn } = parsed(job.file);
            const caption = [sn, type, [monthDisplay, fileYear].filter(Boolean).join(' ')].filter(Boolean).join(' · ') || undefined;

            await sock.sendMessage(extra.from, {
              document: { url: job.tmp },
              fileName: job.file.name,
              mimetype: 'application/pdf',
              ...(caption ? { caption } : {}),
            }, { quoted: msg });

            database.logPaperSent(extra.from, job.file.id);
            telemetry.recordDownloadSuccess('paper');
          } catch (fileErr) {
            telemetry.recordFailure('paper');
            console.warn('[paper] send failed:', job.file.name, fileErr.message);
            await extra.reply(`⚠️ Failed: *${cleanName(job.file.name)}*`);
          } finally {
            deleteTempFile(job.tmp);
          }
        }
      }

    } catch (error) {
      telemetry.recordFailure('paper');
      console.error('[paper] command error:', error.message);
      await react(sock, msg, '❌');
      if (error.message && (error.message.includes('not configured') || error.message.includes('not set'))) {
        return extra.reply('⚙️ Paper vault not configured.');
      }
      return extra.reply('❌ Paper vault unavailable.');
    }
  },
};

// ─── .countpapers ─────────────────────────────────────────────────────────────
const countpapersCmd = {
  name: 'countpapers',
  aliases: ['listpapers', 'papercount', 'vaultcount'],
  category: 'general',
  description: 'Count papers in vault',
  usage: '.countpapers',

  async execute(sock, msg, args, extra) {
    try {
      const status = await extra.status('🔍 Counting...');
      const client = drimeClient();
      const count = await getFolderCount(
        client,
        config.drime?.papersFolderId,
        config.drime?.workspaceId || 0
      );

      if (!count) return status.update('📭 0 papers.');
      return status.update(`📚 *${count.toLocaleString()}* papers`);
    } catch (error) {
      console.error('[countpapers] error:', error.message);
      await react(sock, msg, '❌');
      if (error.message && (error.message.includes('not configured') || error.message.includes('not set'))) {
        return extra.reply('⚙️ Paper vault not configured.');
      }
      return extra.reply('❌ Could not count papers.');
    }
  },
};

// ─── .refreshpapers ───────────────────────────────────────────────────────────
const refreshpapersCmd = {
  name: 'refreshpapers',
  aliases: ['refreshvault', 'reloadpapers'],
  category: 'admin',
  description: 'Refresh paper index',
  usage: '.refreshpapers',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    try {
      const status = await extra.status('🔄 Refreshing...');
      const t0 = Date.now();
      _refreshCoolUntil = 0;
      const { files } = await refreshOnce();
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      return status.update(`✅ *${files.length.toLocaleString()}* papers (${secs}s)`);
    } catch (error) {
      console.error('[refreshpapers] error:', error.message);
      await react(sock, msg, '❌');
      return extra.reply('❌ Refresh failed.');
    }
  },
};

const _getVaultForTests = () => _vault;
const _setVaultFilesForTests = (files) => {
  if (!files) { _vault = null; return; }
  indexVault(files, 'test');
};

module.exports = [
  Object.assign(module.exports, {
    _parsePaper: parsePaper,
    _browseAll: browseAll,
    _browseCode: browseCode,
    _getVaultForTests,
    _setVaultFilesForTests,
    MAX_PAPERS_PER_QUERY,
  }),
  countpapersCmd,
  refreshpapersCmd,
];

// ─── BOOT PREFETCH ────────────────────────────────────────────────────────────
// Index any on-disk snapshot instantly at load, then refresh in the background
// shortly after boot so the first query usually hits warm data. The timer is
// unref'd so it never holds the process (or tests) open by itself.
try {
  const bootSnap = loadSnapshot();
  if (bootSnap) indexVault(bootSnap.files, 'snapshot');
} catch (_) { /* cold start proceeds on first query */ }
setTimeout(() => backgroundRefresh(), 5000).unref();
