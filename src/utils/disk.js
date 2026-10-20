// src/utils/disk.js — filesystem utilities. 2.0 only shipped an "append to
// utils/disk.js" fragment; 3.0 has the complete module.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const ensureDir = (dir) => { fs.mkdirSync(dir, { recursive: true }); };

export function duBytes(dir) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { total += fs.statSync(p).size; } catch {} }
    }
  };
  walk(dir);
  return total;
}

export async function freeBytes(dir) {
  try {
    const si = await fs.promises.statfs?.(dir || '.');
    if (si) return si.bavail * si.bsize;
  } catch {}
  try {                                   // pre-22 fallback via `df`
    const out = await new Promise((res, rej) => {
      execFile('df', ['-Pk', dir || '.'], (e, o) => e ? rej(e) : res(o));
    });
    const line = out.trim().split('\n')[1];
    return Number(line?.split(/\s+/)[3]) * 1024 || null;
  } catch { return null; }
}

export function which(bin) {
  return new Promise(res => {
    execFile(process.platform === 'win32' ? 'where' : 'which', [bin], (e, out) =>
      res(!e && out.trim() ? out.trim().split('\n')[0] : null));
  });
}

export const sanitize = (name) =>
  String(name || 'media')
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/[^\w.\- ]+/g, ' ')
    .trim()
    .replace(/\s+/g, '.') || 'media';
