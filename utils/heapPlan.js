/**
 * ZaFar Bot — heap plan
 *
 * One place that decides how big the V8 old-space may be. Used by index.js
 * (which re-execs the bot once with --max-old-space-size) and by the memory
 * watchdog (which reports the budget it is working against).
 *
 * The rule: heap = RAM − reserve, where the reserve is what lives *outside*
 * the heap (Baileys buffers, sharp/libvips, the ffmpeg child, socket buffers).
 *
 *   4610 MB (4.5 GB plan) → ~4160 MB   ← the case this was tuned for
 *   4096 MB (4 GB plan)   → ~3650 MB
 *   2048 MB               → ~1750 MB
 *
 * Never more than HEAP_MAX_MB (4200) and never more than RAM − 250 MB: a heap
 * larger than the machine is an instant OOM, not a faster bot.
 */

const HEAP_MAX_MB = 4200;
const HEAP_MIN_MB = 1024;

const round = (n) => Math.round(Number(n) || 0);

/** Reserve for native memory: 450 MB on a 4 GB+ plan, 300 MB below that. */
function reserveMB(totalMB) {
  return round(totalMB) >= 4096 ? 450 : 300;
}

/** Heap for a machine of `totalMB`, ignoring any override. */
function autoHeapMB(totalMB) {
  const raw = round(totalMB) - reserveMB(totalMB);
  return Math.max(HEAP_MIN_MB, Math.min(HEAP_MAX_MB, raw));
}

/** The absolute ceiling this machine can be asked for. */
function ceilingMB(totalMB) {
  return Math.min(HEAP_MAX_MB, Math.max(HEAP_MIN_MB, round(totalMB) - 250));
}

/**
 * Final answer.
 * @param {{totalMB?:number, askedMB?:number}} opts
 * @returns {{heapMB:number, capped:boolean, totalMB:number}}
 */
function computeHeapMB({ totalMB, askedMB } = {}) {
  const total = round(totalMB) || round(require('os').totalmem() / 1048576);
  const asked = round(askedMB);
  const ceiling = ceilingMB(total);

  if (!asked || asked < 512) {
    return { heapMB: autoHeapMB(total), capped: false, totalMB: total };
  }
  if (asked > ceiling) {
    return { heapMB: ceiling, capped: true, totalMB: total };
  }
  return { heapMB: asked, capped: false, totalMB: total };
}

module.exports = {
  HEAP_MAX_MB, HEAP_MIN_MB, reserveMB, autoHeapMB, ceilingMB, computeHeapMB,
};
