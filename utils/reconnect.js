/**
 * ZaFar Bot — Reconnect scheduler with exponential backoff
 *
 * Ensures a transient failure inside `startBot()` (DNS hiccup, temporary file
 * lock, WhatsApp handshake error) schedules another retry with backoff instead
 * of leaving the bot permanently dead until a manual panel restart.
 */

'use strict';

function computeBackoffMs(attempt, { baseMs = 3000, maxMs = 60_000 } = {}) {
  const exp = Math.max(0, Math.min(10, Number(attempt) || 0));
  return Math.min(maxMs, Math.round(baseMs * Math.pow(2, exp)));
}

function createReconnector({
  start,
  baseMs = 3000,
  maxMs = 60_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onError = null,
} = {}) {
  if (typeof start !== 'function') {
    throw new TypeError('createReconnector requires a start() function');
  }

  let attempts = 0;
  let timer = null;
  let stopped = false;

  const cancel = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const reset = () => {
    stopped = false;
    attempts = 0;
    cancel();
  };

  const stop = () => {
    stopped = true;
    cancel();
  };

  const schedule = (overrideMs) => {
    if (stopped) return false;
    if (timer !== null) return false;

    const delayMs = overrideMs != null
      ? Math.max(0, Number(overrideMs) || 0)
      : computeBackoffMs(attempts, { baseMs, maxMs });
    const attemptNumber = ++attempts;

    timer = setTimer(async () => {
      timer = null;
      if (stopped) return;
      try {
        await start(attemptNumber);
      } catch (err) {
        if (typeof onError === 'function') {
          try { onError(err, attemptNumber, computeBackoffMs(attempts, { baseMs, maxMs })); } catch { /* ignore */ }
        }
        if (!stopped) schedule();
      }
    }, delayMs);
    timer?.unref?.();
    return delayMs;
  };

  return {
    schedule,
    reset,
    stop,
    cancel,
    get attempts() { return attempts; },
    get scheduled() { return timer !== null; },
  };
}

module.exports = {
  computeBackoffMs,
  createReconnector,
};
