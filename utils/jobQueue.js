const config = require('../config');

const laneLimit = (name, fallback) => Math.max(1, Math.floor(Number(config.queue?.[name]) || fallback));
const lanes = {
  light: { fallback: 3, running: 0, waiters: [] },
  heavy: { fallback: 2, running: 0, waiters: [] },
};

async function runInLane(name, fn, onWait) {
  const lane = lanes[name];
  if (!lane) throw new Error(`unknown job lane: ${name}`);
  if (typeof fn !== 'function') throw new TypeError('job must be a function');

  if (lane.running >= laneLimit(name, lane.fallback)) {
    let release;
    const turn = new Promise((resolve) => { release = resolve; });
    lane.waiters.push(release);
    if (typeof onWait === 'function') {
      try { Promise.resolve(onWait()).catch(() => {}); } catch { /* ignore */ }
    }
    await turn;
  } else {
    lane.running++;
  }

  try {
    return await fn();
  } finally {
    const next = lane.waiters.shift();
    if (next) next();
    else lane.running--;
  }
}

function stats() {
  return Object.fromEntries(Object.entries(lanes).map(([name, lane]) => [
    name,
    { running: lane.running, waiting: lane.waiters.length },
  ]));
}

module.exports = { runInLane, stats };
