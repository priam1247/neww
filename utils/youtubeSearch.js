/**
 * ZaFar Bot — YouTube search
 *
 * Shared by .song / .ytv / .spotify so a query never dead-ends:
 *   1. yt-search (fast, gives durations and thumbnails — scrapes the HTML),
 *   2. yt-dlp's ytsearch: (API endpoints, survives HTML changes).
 *
 * Returns a list, so commands can show numbered results and let the user pick
 * instead of silently downloading the first hit.
 */

const YT = require('./youtubedl');

const DEFAULT_LIMIT = 5;

const clean = (s) => String(s || '').trim();

/** Normalise both sources into the same shape (yt-dlp says "uploader"). */
const toResult = ({ url, id, title, author, uploader, duration, thumbnail }) => ({
  url: url || (id ? `https://www.youtube.com/watch?v=${id}` : ''),
  id: id || YT.extractVideoId(url || '') || '',
  title: clean(title) || 'Unknown title',
  author: clean(author || uploader),
  duration: Number(duration) || 0,
  thumbnail: clean(thumbnail) || (id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : ''),
});

async function viaYtSearch(query, limit) {
  try {
    const yts = require('yt-search'); // lazy: scraping library, only needed here
    const found = await yts(query);
    const videos = (found && found.videos) || [];
    return videos.slice(0, limit).map(v => toResult({
      url: v.url,
      id: v.videoId || YT.extractVideoId(v.url || ''),
      title: v.title,
      author: v.author?.name,
      duration: v.seconds,
      thumbnail: v.thumbnail,
    })).filter(r => r.url);
  } catch (e) {
    console.warn('[search] yt-search failed:', e.message);
    return [];
  }
}

async function viaYtDlp(query, limit) {
  try {
    const rows = await YT.searchVideos(query, { limit, timeout: 60000 });
    return rows.map(toResult).filter(r => r.url);
  } catch (e) {
    console.warn('[search] yt-dlp search failed:', e.message);
    return [];
  }
}

/**
 * @param {string} query
 * @param {{limit?:number}} [opts]
 * @returns {Promise<Array<{url:string,id:string,title:string,author:string,duration:number,thumbnail:string}>>}
 */
async function searchYouTube(query, { limit = DEFAULT_LIMIT } = {}) {
  const q = clean(query);
  if (!q) return [];

  // A link is not a search
  if (YT.isYouTubeUrl(q)) {
    const id = YT.extractVideoId(q);
    const url = YT.normalizeYouTubeUrl(q);
    let meta = {};
    try { meta = await YT.getInfo(url, { timeout: 45000 }); } catch { /* download reports the rest */ }
    return [toResult({ url, id, title: meta.title, author: meta.uploader, duration: meta.duration, thumbnail: meta.thumbnail })];
  }

  // yt-search first (durations + thumbnails), yt-dlp as the reliable fallback.
  const wide = Math.max(limit, 5);
  const first = await viaYtSearch(q, wide);
  if (first.length >= limit) return first.slice(0, limit);

  const second = await viaYtDlp(q, limit);
  const merged = [...first];
  for (const r of second) {
    if (!merged.some(x => x.id && r.id && x.id === r.id)) merged.push(r);
  }
  return merged.slice(0, limit);
}

/** "1. Title — artist (3:32)" list for the picker message. */
function formatResults(results, { header = '🔎 *Results*', note = 'Reply with a number, or *cancel*.' } = {}) {
  const lines = results.map((r, i) => {
    const time = r.duration
      ? ` (${Math.floor(r.duration / 60)}:${String(r.duration % 60).padStart(2, '0')})`
      : '';
    const who = r.author ? ` — ${r.author}` : '';
    return `*${i + 1}.* ${r.title}${time}${who}`;
  });
  return `${header}\n${lines.join('\n')}\n\n${note}`;
}

module.exports = { searchYouTube, formatResults, DEFAULT_LIMIT };
