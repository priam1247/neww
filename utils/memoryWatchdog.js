/**
 * Memory Watchdog - Monitors RAM and cleans up before the panel hits OOM.
 *
 * The budget is read from the real heap limit (see index.js: the bot re-execs
 * itself with --max-old-space-size, so this tracks the plan it is running on —
 * ~4.1 GB on a 4.5 GB box, ~3.6 GB on a 4 GB one):
 *   >= 70% — soft clean: trim old store entries + temp files
 *   >= 85% — hard clean: wipe entire store
 *   >= 95% — graceful restart: clean exit so the panel restarts us
 *
 * Usage in index.js (already patched):
 *   const { startMemoryWatchdog } = require('./utils/memoryWatchdog');
 *   startMemoryWatchdog();
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const v8   = require('v8');

/**
 * How much heap may this process use?
 * `--max-old-space-size` (set by index.js from the real RAM) is the honest
 * number — a hard-coded value was wrong on every plan but one. The V8 heap
 * limit wins; a tighter cgroup limit still overrides it (that is the number
 * the kernel will actually enforce), and MEMORY_LIMIT_MB overrides both.
 */
function detectLimitMB() {
  const fromEnv = Number(process.env.MEMORY_LIMIT_MB);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;

  let heapMB = 0;
  try { heapMB = v8.getHeapStatistics().heap_size_limit / (1024 * 1024); } catch { /* ignore */ }

  // cgroup v2 / v1 container limits when they are tighter than the heap limit
  let cgroupMB = 0;
  for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const raw = fs.readFileSync(file, 'utf8').trim();
      if (raw && raw !== 'max') {
        const mb = Number(raw) / (1024 * 1024);
        // Ignore "unlimited" sentinels (huge numbers)
        if (Number.isFinite(mb) && mb > 32 && mb < 1024 * 512) cgroupMB = cgroupMB ? Math.min(cgroupMB, mb) : mb;
      }
    } catch { /* not containerised */ }
  }

  // The heap limit already leaves room for native memory, so use it as-is
  // instead of multiplying again — that double-reserve is what kept the
  // watchdog at ~2.7 GB on a 4.5 GB box. Only a container limit may be lower.
  const candidates = [heapMB, cgroupMB].filter(n => Number.isFinite(n) && n > 32);
  if (candidates.length) return Math.round(Math.min(...candidates));

  // No heap limit and no cgroup (bare `node index.js` on the host): plan one.
  return require('./heapPlan').autoHeapMB(os.totalmem() / (1024 * 1024));
}

const TOTAL_MB          = detectLimitMB();
const WARN_THRESHOLD    = 0.70;  // 70%  soft clean
const HARD_THRESHOLD    = 0.85;  // 85%  hard clean
const RESTART_THRESHOLD = 0.95;  // 95%  graceful restart
const CHECK_INTERVAL    = 30_000; // every 30 seconds

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function getHeapMB() {
  return process.memoryUsage().heapUsed / (1024 * 1024);
}

function tryGC() {
  if (typeof global.gc === 'function') {
    global.gc();
    console.log('[MEMORY] GC triggered');
  }
}

// Clean the temp folder the bot uses. Same age rules as utils/cleanup.js:
// this used to delete every file older than 60 s whenever the heap passed
// 70 %, which removed .dl/.movie files while they were still being sent.
function cleanTempFiles() {
  const { cleanupOldFiles } = require('./cleanup');
  for (const dir of [path.join(__dirname, '../temp'), path.join(__dirname, '../temp/baileys_store')]) {
    if (fs.existsSync(dir)) cleanupOldFiles(dir);
  }
}

// ─── SOFT CLEAN ───────────────────────────────────────────────────────────────
// Trims message store — keeps only the 5 most recent messages per chat
function softClean(store) {
  let freed = 0;
  if (store?.messages) {
    for (const [, msgs] of store.messages.entries()) {
      if (msgs.size > 5) {
        const keys = [...msgs.keys()];
        keys.slice(0, keys.length - 5).forEach(k => { msgs.delete(k); freed++; });
      }
    }
    if (freed > 0) console.log(`[MEMORY] Soft clean — trimmed ${freed} messages from store`);
  }
  cleanTempFiles();
  tryGC();
}

// ─── HARD CLEAN ───────────────────────────────────────────────────────────────
// Wipes entire message store
function hardClean(store) {
  if (store?.messages) {
    const n = store.messages.size;
    store.messages.clear();
    console.log(`[MEMORY] Hard clean — cleared store (${n} chats)`);
  }
  cleanTempFiles();
  tryGC();
}

// ─── GRACEFUL RESTART ─────────────────────────────────────────────────────────
function gracefulRestart(heapMB) {
  console.error(`[MEMORY] CRITICAL: ${heapMB.toFixed(0)} MB / ${TOTAL_MB} MB — restarting cleanly`);
  setTimeout(() => process.exit(1), 500); // let log flush, then exit
}

// ─── START WATCHDOG ───────────────────────────────────────────────────────────
function startMemoryWatchdog(store = null) {
  const limitGB = (TOTAL_MB / 1024).toFixed(1);
  console.log(
    `[MEMORY] Watchdog started — limit: ${TOTAL_MB} MB (${limitGB} GB) · ` +
    `soft ${Math.round(TOTAL_MB * WARN_THRESHOLD)} · hard ${Math.round(TOTAL_MB * HARD_THRESHOLD)} · ` +
    `restart ${Math.round(TOTAL_MB * RESTART_THRESHOLD)} MB · every ${CHECK_INTERVAL / 1000}s`
  );

  setInterval(() => {
    const heapMB  = getHeapMB();
    const ratio   = heapMB / TOTAL_MB;
    const pct     = (ratio * 100).toFixed(1);

    if (ratio >= RESTART_THRESHOLD) {
      console.error(`[MEMORY] 🔴 ${heapMB.toFixed(0)} MB (${pct}%) — CRITICAL`);
      hardClean(store);
      gracefulRestart(heapMB);

    } else if (ratio >= HARD_THRESHOLD) {
      console.warn(`[MEMORY] 🟠 ${heapMB.toFixed(0)} MB (${pct}%) — hard clean`);
      hardClean(store);

    } else if (ratio >= WARN_THRESHOLD) {
      console.warn(`[MEMORY] 🟡 ${heapMB.toFixed(0)} MB (${pct}%) — soft clean`);
      softClean(store);

    }

    // Green zone — silent. Uncomment below to log all checks:
    // else { console.log(`[MEMORY] 🟢 ${heapMB.toFixed(0)} MB (${pct}%) — OK`); }

  }, CHECK_INTERVAL);
}

module.exports = { startMemoryWatchdog, detectLimitMB };
