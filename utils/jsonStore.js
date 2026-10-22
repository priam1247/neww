/**
 * ZaFar Bot — Atomic JSON persistence with last-good (.bak) recovery
 *
 * Prevents half-written or truncated JSON files when the panel kills the
 * container mid-write or hits disk limits:
 *   1. Writes go to a sibling `.tmp` file, are flushed with fsync, then
 *      atomically renamed into place.
 *   2. Every valid write also updates `<file>.bak` (atomically), keeping a
 *      known-good copy on disk.
 *   3. Reads fall back to `<file>.bak` if `<file>` is corrupt/truncated, and
 *      expose `corrupt: true` when both copies are damaged so callers like
 *      `whitelist.json` never mistake a corrupt file for "no users".
 */

'use strict';

const fs = require('fs');
const path = require('path');

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function writeRawAtomic(targetPath, payload) {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tmp = `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w', 0o600);
    fs.writeFileSync(fd, payload, 'utf8');
    try { fs.fsyncSync(fd); } catch { /* some virtual filesystems reject fsync */ }
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, targetPath);
  } catch (err) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Serialize `data` and write it atomically to `filePath`, then update
 * `${filePath}.bak` with the same verified payload.
 */
function writeJsonAtomic(filePath, data, { spaces = 2, keepBackup = true } = {}) {
  const payload = `${JSON.stringify(data, null, spaces)}\n`;
  // Sanity-check serialization before touching disk
  JSON.parse(payload);

  // If an existing valid file is on disk and no .bak exists yet, preserve it first
  const bakPath = `${filePath}.bak`;
  if (keepBackup && fs.existsSync(filePath) && !fs.existsSync(bakPath)) {
    try {
      const existing = fs.readFileSync(filePath, 'utf8');
      JSON.parse(existing);
      writeRawAtomic(bakPath, existing);
    } catch { /* existing file wasn't valid; new payload will become .bak */ }
  }

  writeRawAtomic(filePath, payload);

  if (keepBackup) {
    try {
      writeRawAtomic(bakPath, payload);
    } catch (e) {
      console.warn(`[jsonStore] wrote ${path.basename(filePath)} but could not update .bak: ${e.message}`);
    }
  }
  return true;
}

function tryParseFile(filePath, validate) {
  const raw = fs.readFileSync(filePath, 'utf8');
  if (!raw.trim()) throw new Error('file is empty');
  const parsed = JSON.parse(raw);
  if (typeof validate === 'function' && !validate(parsed)) {
    throw new Error('JSON structure failed validation');
  }
  return parsed;
}

/**
 * Safely read a JSON file, falling back to `${filePath}.bak` if corrupt.
 *
 * @param {string} filePath
 * @param {object} [opts]
 * @param {any} [opts.defaultValue] returned ONLY when neither file nor .bak exists
 * @param {(data:any)=>boolean} [opts.validate] optional schema check
 * @returns {{ok:boolean, exists:boolean, recovered:boolean, corrupt:boolean, data:any, error?:Error}}
 */
function readJsonSafe(filePath, { defaultValue = {}, validate = null } = {}) {
  const bakPath = `${filePath}.bak`;
  const hasMain = fs.existsSync(filePath);
  const hasBak = fs.existsSync(bakPath);

  if (!hasMain && !hasBak) {
    return {
      ok: true,
      exists: false,
      recovered: false,
      corrupt: false,
      data: clone(defaultValue),
    };
  }

  let mainErr = null;
  if (hasMain) {
    try {
      const data = tryParseFile(filePath, validate);
      return { ok: true, exists: true, recovered: false, corrupt: false, data };
    } catch (err) {
      mainErr = err;
    }
  }

  // Primary is missing or corrupt — try last-good backup
  if (hasBak) {
    try {
      const data = tryParseFile(bakPath, validate);
      console.warn(
        `[jsonStore] ${path.basename(filePath)} was ${hasMain ? `corrupt (${mainErr.message})` : 'missing'} — restored from ${path.basename(bakPath)}`
      );
      try {
        if (hasMain) {
          const corruptCopy = `${filePath}.corrupt`;
          try { fs.copyFileSync(filePath, corruptCopy); } catch { /* best-effort */ }
        }
        writeRawAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`);
      } catch (restoreErr) {
        console.warn(`[jsonStore] could not rewrite restored ${path.basename(filePath)}: ${restoreErr.message}`);
      }
      return { ok: true, exists: true, recovered: true, corrupt: false, data };
    } catch (bakErr) {
      mainErr = mainErr || bakErr;
    }
  }

  // Both primary and backup failed on an existing file
  if (hasMain) {
    try { fs.copyFileSync(filePath, `${filePath}.corrupt`); } catch { /* ignore */ }
  }
  return {
    ok: false,
    exists: true,
    recovered: false,
    corrupt: true,
    data: null,
    error: mainErr || new Error(`corrupt JSON in ${path.basename(filePath)}`),
  };
}

module.exports = {
  writeRawAtomic,
  writeJsonAtomic,
  readJsonSafe,
};
