// engine/core/queue.js — concurrency-limited job queue with per-chat fairness,
// per-user caps, job timeouts and live position queries.
//
// Fixed in the ZaFar Bot integration:
//   • the timeout timer is no longer unref'd — an unref'd timer never fires when
//     the event loop is otherwise idle, which is exactly the hanging-job case it
//     exists for, so the queue used to stall forever;
//   • the timer is cleared when the job settles (no leaked handles per job).
import config from '../config.js';
import { log } from './log.js';

const qlog = log.child('queue');

class JobQueue {
  constructor(limit = config.concurrency) {
    this.q = [];
    this.running = 0;
    this.limit = Math.max(1, limit);
    this.touched = 0;
    this.streak = new Map();      // jid -> consecutive dispatches (fairness)
  }

  add(jid, label, job, { timeoutMs = config.jobTimeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      this.q.push({ jid, label, job, resolve, reject, timeoutMs, at: Date.now() });
      this.touched++;
      this.#drain();
    });
  }

  async #drain() {
    if (this.running >= this.limit || !this.q.length) return;

    // fairness: a user can hold at most perUserQueueCap CONSECUTIVE slots;
    // streak resets for everyone else each time a different user is served
    let pick = -1;
    for (let i = 0; i < this.q.length; i++) {
      const c = this.streak.get(this.q[i].jid) || 0;
      if (c < config.perUserQueueCap) { pick = i; break; }
    }
    if (pick === -1) pick = 0;                    // all capped → serve anyway

    const item = this.q.splice(pick, 1)[0];
    for (const k of this.streak.keys()) if (k !== item.jid) this.streak.set(k, 0);
    this.streak.set(item.jid, (this.streak.get(item.jid) || 0) + 1);
    this.running++;

    let timer = null;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() =>
        rej(new Error(`job "${item.label}" timed out after ${Math.round(item.timeoutMs / 1000)}s`)),
        item.timeoutMs);
    });

    const started = Date.now();
    try {
      const out = await Promise.race([item.job(), timeout]);
      item.resolve(out);
    } catch (e) {
      item.reject(e);
    } finally {
      clearTimeout(timer);
      qlog.debug(`job "${item.label}" took ${Date.now() - started}ms`);
      this.running--;
      setImmediate(() => this.#drain());
    }
  }

  get size() { return this.q.length; }
  get busy() { return this.running; }
  position(jid) { return this.q.filter(i => i.jid === jid).length; }
}

export default new JobQueue();
export { JobQueue };
