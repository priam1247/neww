// src/core/events.js — global event bus. Progress, health and metrics hooks
// subscribe here so the UI layer (WhatsApp/CLI) stays decoupled from the engine.
import { EventEmitter } from 'node:events';

const bus = new EventEmitter();
bus.setMaxListeners(64);

export const EVENTS = {
  SEARCH_START: 'search:start',
  TIER_DONE: 'tier:done',
  CANDIDATE_REJECTED: 'candidate:rejected',
  RESOLVED: 'resolve:ok',
  RESOLVE_FAIL: 'resolve:fail',
  VERIFY_OK: 'verify:ok',
  VERIFY_FAIL: 'verify:fail',
  DOWNLOAD_START: 'download:start',
  DOWNLOAD_PROGRESS: 'download:progress',
  DOWNLOAD_DONE: 'download:done',
  CACHE_HIT: 'cache:hit'
};

export function emit(event, payload = {}) {
  bus.emit(event, { event, at: Date.now(), ...payload });
}

export const on = (event, fn) => bus.on(event, fn);
export const once = (event, fn) => bus.once(event, fn);
export const off = (event, fn) => bus.off(event, fn);
export default bus;
