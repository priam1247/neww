/**
 * ZaFar Bot — download lanes
 *
 * Two lanes keep a burst of commands from either serialising or melting the
 * box:
 *
 *   light — link/YouTube downloads (`.ytv`, `.dl`, `.song` …): 20 at a time
 *   heavy — movie/episode jobs (`.movie`, `.series`): 4 at a time
 *
 * A job that would exceed the lane limit waits in a FIFO queue and gets a ⏳
 * reaction, so a 20th download never blocks the 1st and 21 commands in one
 * minute still all run.
 *
 * Memory guard: RAM is the real ceiling on a 4 GB panel, so a slot is only
 * opened when `os.freemem()` is above config.queue.minFreeMB. It is a soft
 * check — it never rejects a job, it just delays the start until another
 * download finishes.
 */
const os = require('os');
const config = require('../config');

const limitFor = (name, fallback) => Math.max(1, Math.floor(Number(config.queue?.[name]) || fallback));

const lanes = {
  light: { fallback: 20, running: 0, waiters: [] },
  heavy: { fallback: 2, running: 0, waiters: [] },
};

const minFreeBytes = () => Math.max(0, Number(config.queue?.minFreeMB) || 0) * 1024 * 1024;

function memoryOk() {
  const need = minFreeBytes();
  if (!need) return true;
  try { return os.freemem() >= need; } catch { return true; }
}

/** Wake queued jobs until the lane is full or memory says stop. */
function drain(lane) {
  while (lane.waiters.length && lane.running < limitFor(lane.name, lane.fallback) && memoryOk()) {
    lane.running++;
    lane.waiters.shift()();
  }
}

async function runInLane(name, fn, onWait) {
  const lane = lanes[name];
  if (!lane) throw new Error(`unknown job lane: ${name}`);
  if (typeof fn !== 'function') throw new TypeError('job must be a function');
  lane.name = name;

  if (lane.running >= limitFor(name, lane.fallback) || !memoryOk()) {
    await new Promise((resolve) => {
      lane.waiters.push(() => resolve());
      if (typeof onWait === 'function') {
        try { Promise.resolve(onWait()).catch(() => {}); } catch { /* ignore */ }
      }
      // the memory guard can free up while nothing else finishes
      const timer = setTimeout(() => drain(lane), 2000);
      timer.unref?.();
    });
  } else {
    lane.running++;
  }

  try {
    return await fn();
  } finally {
    lane.running--;
    drain(lane);
  }
}

function stats() {
  return Object.fromEntries(Object.entries(lanes).map(([name, lane]) => [
    name,
    { running: lane.running, waiting: lane.waiters.length, limit: limitFor(name, lane.fallback) },
  ]));
}

module.exports = { runInLane, stats };
