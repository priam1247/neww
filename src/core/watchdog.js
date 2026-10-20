// src/core/watchdog.js — merged from Zafar-bot-main: process hardening.
//   • ENOSPC (no space left) never crashes the bot — temp is swept instead
//   • periodic temp sweeper (2 h media age / 30 min scraps)
//   • memory watchdog: logs at 70/85 %, graceful exit at 95 % (supervisors
//     restart it; V8 heap limit + cgroup budget auto-detected)
import fs from 'node:fs';
import os from 'node:os';
import v8 from 'node:v8';
import { log } from './log.js';
import { sweepJobs, jobDir } from '../media/transfer.js';
import config from '../config.js';

const wlog = log.child('watchdog');

function detectLimitMB() {
  const fromEnv = Number(process.env.MEMORY_LIMIT_MB);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  let heapMB = 0;
  try { heapMB = v8.getHeapStatistics().heap_size_limit / (1024 * 1024); } catch { /* ignore */ }
  let cgroupMB = 0;
  for (const file of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const raw = fs.readFileSync(file, 'utf8').trim();
      if (raw && raw !== 'max') {
        const mb = Number(raw) / (1024 * 1024);
        if (Number.isFinite(mb) && mb > 32 && mb < 1024 * 512) cgroupMB = cgroupMB ? Math.min(cgroupMB, mb) : mb;
      }
    } catch { /* not containerised */ }
  }
  const totalMB = os.totalmem() / (1024 * 1024);
  const candidates = [heapMB, cgroupMB, totalMB * 0.9].filter(n => Number.isFinite(n) && n > 32);
  return Math.round(candidates.length ? Math.min(...candidates) : 1700);
}

const TOTAL_MB = detectLimitMB();
const WARN = 0.70, HARD = 0.85, RESTART = 0.95;

export function handleNoSpace(scope = '') {
  try {
    const freed = sweepJobs({ maxAgeMs: 0 });   // ENOSPC: sweep everything
    wlog.warn(`ENOSPC${scope ? ` (${scope})` : ''} — swept ${freed ? `${(freed / 1048576).toFixed(1)} MB` : 'nothing'}`);
  } catch { /* best effort */ }
}

export function installProcessGuards() {
  process.on('uncaughtException', (err) => {
    if (err?.code === 'ENOSPC' || err?.errno === -28 || /no space left on device/i.test(err?.message || '')) {
      return handleNoSpace('uncaughtException');
    }
    wlog.error('uncaught exception:', err?.message || err);
  });
  process.on('unhandledRejection', (err) => {
    if (err?.code === 'ENOSPC' || err?.errno === -28 || /no space left on device/i.test(String(err?.message || ''))) {
      return handleNoSpace('unhandledRejection');
    }
    if (/rate-overlimit/i.test(String(err?.message || ''))) {
      wlog.warn('rate limit reached — slowing down');
      return;
    }
    wlog.error('unhandled rejection:', err?.message || err);
  });
}

let memTimer = null;
export function startMemoryWatchdog({ intervalMs = 30_000 } = {}) {
  if (memTimer) return;
  memTimer = setInterval(() => {
    try {
      const usedMB = process.memoryUsage().heapUsed / 1048576;
      const ratio = usedMB / TOTAL_MB;
      if (ratio >= RESTART) {
        wlog.error(`heap ${usedMB.toFixed(0)}/${TOTAL_MB} MB (${Math.round(ratio * 100)}%) — exiting for a supervisor restart`);
        process.exit(0);
      } else if (ratio >= HARD) {
        sweepJobs({});
        wlog.warn(`heap ${usedMB.toFixed(0)}/${TOTAL_MB} MB (${Math.round(ratio * 100)}%) — hard sweep done`);
      } else if (ratio >= WARN) {
        wlog.warn(`heap ${usedMB.toFixed(0)}/${TOTAL_MB} MB (${Math.round(ratio * 100)}%) — approaching limit`);
      }
    } catch { /* ignore */ }
  }, intervalMs);
  memTimer.unref?.();
  wlog.info(`memory watchdog: limit ${TOTAL_MB} MB (warn ${Math.round(WARN * 100)}%, restart ${Math.round(RESTART * 100)}%)`);
}

let sweepTimer = null;
export function startTempSweeper({ intervalMs = 10 * 60_000 } = {}) {
  if (sweepTimer) return;
  try { fs.mkdirSync(jobDir(), { recursive: true }); } catch { /* ignore */ }
  sweepTimer = setInterval(() => {
    try { sweepJobs({}); } catch { /* ignore */ }
  }, intervalMs);
  sweepTimer.unref?.();
}

export default { installProcessGuards, startMemoryWatchdog, startTempSweeper, handleNoSpace };
