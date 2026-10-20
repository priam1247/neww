// engine/host.js — bridge from the (generic) engine to the ZaFar Bot host.
//
// The engine ships with the bot, but it is written so it can also run on its
// own: everything host-specific is resolved here, lazily, behind try/catch.
// When the bot is present the engine gets its temp dir, its downloader and its
// ffmpeg binary; when it is not, the engine falls back to its own defaults.
let cached;
let tried = false;

export async function host() {
  if (tried) return cached;
  tried = true;
  try {
    const mod = await import('../../utils/movieHost.js');
    cached = mod?.default || mod || null;
  } catch {
    cached = null;                      // standalone use — not an error
  }
  return cached;
}

/** ffmpeg binary the host already verified (null → engine probes itself). */
export async function ffmpegPath() {
  const h = await host();
  try { return h?.ffmpegPath?.() || null; } catch { return null; }
}

/**
 * Last-resort download through the host's streamed downloader. DDL hosts
 * sometimes reject Node's fetch fingerprint but accept the bot's agent.
 * @returns {Promise<null|{bytes:number}>} null when the host cannot help
 */
export async function downloadFallback(url, dest, { headers = {}, onProgress } = {}) {
  const h = await host();
  if (!h?.download) return null;
  try {
    const res = await h.download(url, dest, { headers, onProgress });
    return { bytes: res.bytes };
  } catch {
    return null;
  }
}
