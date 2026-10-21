/**
 * ffmpeg resolver — single source of truth.
 *
 * Delegates to utils/converter.js, which probes every realistic location
 * (FFMPEG_PATH env → system ffmpeg → user install → packaged fallback) and returns
 * the first binary that actually runs on this host.
 */

const fs = require('fs');
const path = require('path');
const { resolve: resolveConverter, works, version } = require('./converter');

function findOnPath(command, pathValue = process.env.PATH) {
  const name = String(command || '');
  if (!name || path.isAbsolute(name)) return null;
  for (const dir of String(pathValue || '').split(path.delimiter)) {
    const candidate = path.resolve(dir || process.cwd(), name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* try the next PATH entry */ }
  }
  return null;
}

function resolve() {
  const binary = resolveConverter();
  if (path.isAbsolute(binary) || path.basename(binary) !== binary) return binary;
  return findOnPath(binary) || binary;
}

module.exports = resolve;
module.exports.works = works;
module.exports.version = version;
module.exports.findOnPath = findOnPath;
