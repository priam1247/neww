// src/core/store.js — one persistent JSON KV store for bot state that is NOT
// the media cache: whitelist, on/off, runtime media settings, paper send-log.
// Merged replacement for Zafar-bot-main's database.js + accessControl.json +
// mediaSettings.json. Atomic writes, read-through cache, namespaced buckets.
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';

const FILE = path.resolve(process.cwd(), config.dataDir, 'store.json');

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
  } catch {
    cache = {};
  }
  return cache;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, FILE);              // atomic: readers never see a half-write
  } catch (e) {
    console.error(`[store] write failed: ${e.message}`);
  }
}

export const store = {
  /** whole bucket (live object — mutate via setBucket). */
  bucket(name, fallback = {}) {
    const d = load();
    if (!d[name] || typeof d[name] !== typeof fallback) d[name] = structuredClone(fallback);
    return d[name];
  },

  setBucket(name, value) {
    load()[name] = value;
    save();
  },

  get(name, key, fallback = undefined) {
    const b = load()[name];
    if (!b || typeof b !== 'object') return fallback;
    const v = b[key];
    return v === undefined ? fallback : v;
  },

  set(name, key, value) {
    const d = load();
    if (!d[name] || typeof d[name] !== 'object') d[name] = {};
    d[name][key] = value;
    save();
  },

  /** file path (diagnostics) */
  get file() { return FILE; },

  /** test hook */
  _reset() { cache = null; }
};

export default store;
