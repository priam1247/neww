// src/providers/local/youtubeSearch.js — merged from Zafar-bot-main: YouTube
// search shared by .song/.ytv/.spotify. yt-dlp's ytsearch (API endpoints —
// survives the HTML-scraping blocks that break scraper libs on hosting IPs),
// so the bot can list numbered results instead of silently taking hit #1.
import YT from './ytdlp.js';

const clean = (s) => String(s || '').trim();

const toResult = ({ url, id, title, author, uploader, duration, thumbnail }) => ({
  url: url || (id ? `https://www.youtube.com/watch?v=${id}` : ''),
  id: id || YT.extractVideoId(url || '') || '',
  title: clean(title) || 'Unknown title',
  author: clean(author || uploader),
  duration: Number(duration) || 0,
  thumbnail: clean(thumbnail) || (id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : ''),
});

/**
 * @param {string} query
 * @param {{limit?:number}} [opts]
 * @returns {Promise<Array<{url,id,title,author,duration,thumbnail}>>}
 */
export async function searchYouTube(query, { limit = 5 } = {}) {
  const q = clean(query);
  if (!q) return [];

  // a link is not a search
  if (YT.isYouTubeUrl(q)) {
    const id = YT.extractVideoId(q);
    const url = YT.normalizeYouTubeUrl(q);
    let meta = {};
    try { meta = await YT.getInfo(url, { timeout: 45_000 }); } catch { /* download reports the rest */ }
    return [toResult({ url, id, title: meta.title, author: meta.uploader, duration: meta.duration, thumbnail: meta.thumbnail })];
  }

  try {
    const rows = await YT.searchVideos(q, { limit, timeout: 60_000 });
    return rows.map(toResult).filter(r => r.url);
  } catch (e) {
    return [];
  }
}

/** "1. Title — author (3:32)" list for the picker message. */
export function formatResults(results, { header = '🔎 *Results*', note = 'Reply with a number, or *cancel*.' } = {}) {
  const lines = results.map((r, i) => {
    const time = r.duration ? ` (${Math.floor(r.duration / 60)}:${String(r.duration % 60).padStart(2, '0')})` : '';
    const who = r.author ? ` — ${r.author}` : '';
    return `*${i + 1}.* ${r.title}${time}${who}`;
  });
  return `${header}\n${lines.join('\n')}\n\n${note}`;
}

export const DEFAULT_LIMIT = 5;
