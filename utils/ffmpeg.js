/**
 * ffmpeg resolver — single source of truth.
 *
 * Delegates to utils/converter.js, which probes every realistic location
 * (FFMPEG_PATH env → system ffmpeg → user install → packaged fallback) and returns
 * the first binary that actually runs on this host.
 */

const { resolve, works, version } = require('./converter');

module.exports = () => resolve();
module.exports.works = works;
module.exports.version = version;
