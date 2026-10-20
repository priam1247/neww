// src/media/subs.js — NEW in 3.0: subtitle search via OpenSubtitles API
// (optional — enabled when OPENSUBTITLES_API_KEY is set).
import config from '../config.js';
import { req } from '../core/http.js';

const API = 'https://api.opensubtitles.com/api/v1';

export async function searchSubs({ imdbId, season, episode, language = 'en' }) {
  if (!config.openSubsKey) {
    throw new Error('subtitles disabled — set OPENSUBTITLES_API_KEY in .env to enable');
  }

  const params = new URLSearchParams({ languages: language });
  if (imdbId) params.set('imdb_id', String(imdbId).replace('tt', ''));
  if (season != null) params.set('season_number', String(season));
  if (episode != null) params.set('episode_number', String(episode));

  const d = await req(`${API}/subtitles?${params}`, {
    headers: { 'Api-Key': config.openSubsKey, 'User-Agent': config.userAgent }
  });

  return (d.data || []).slice(0, 5).map(e => ({
    id: e.id,
    title: e.attributes?.feature_details?.movie_title || e.attributes?.release || 'subtitle',
    language: e.attributes?.language,
    download: e.attributes?.files?.[0]?.link || null,
    downloads: e.attributes?.download_count || 0
  })).filter(s => s.download);
}

export async function downloadSub(link, dest) {
  const res = await fetch(link, {
    headers: { 'Api-Key': config.openSubsKey, 'User-Agent': config.userAgent },
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw new Error(`subs HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const fs = await import('node:fs');
  fs.writeFileSync(dest, buf);
  return dest;
}
