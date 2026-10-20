// src/providers/local/spotify.js — merged from Zafar-bot-main: Spotify metadata
// without API keys. Spotify itself does not allow third-party downloads, so
// .spotify resolves the track's METADATA (public oEmbed endpoint), finds the
// same song on YouTube, and hands the URL to the normal audio pipeline.
// With SPOTIFY_CLIENT_ID/SECRET configured the Web API also gives album+duration.
import config from '../../config.js';
import { req } from '../../core/http.js';

const SPOTIFY_RE = /https?:\/\/(?:open\.)?spotify\.com\/(?:intl-[a-z-]+\/)?(track|album|playlist|episode)\/([A-Za-z0-9]+)/i;

export const parseSpotifyUrl = (text) => {
  const m = String(text || '').match(SPOTIFY_RE);
  return m ? { type: m[1].toLowerCase(), id: m[2], url: `https://open.spotify.com/${m[1].toLowerCase()}/${m[2]}` } : null;
};

let _token = null;

async function clientCredentialsToken() {
  const id = config.spotifyClientId, secret = config.spotifyClientSecret;
  if (!id || !secret) return null;
  if (_token && Date.now() < _token.expiresAt) return _token.value;
  const data = await req('https://accounts.spotify.com/api/token', {
    method: 'POST', retries: 0, timeout: 15_000,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
  }).catch(() => null);
  const token = data?.access_token;
  if (!token) return null;
  _token = { value: token, expiresAt: Date.now() + ((Number(data.expires_in) || 3600) - 60) * 1000 };
  return token;
}

/** Metadata via the official Web API (only when credentials exist). */
async function viaWebApi(parsed) {
  const token = await clientCredentialsToken();
  if (!token) return null;
  const d = await req(`https://api.spotify.com/v1/${parsed.type}s/${parsed.id}`, {
    retries: 0, timeout: 15_000, headers: { authorization: `Bearer ${token}` },
  });
  const artists = Array.isArray(d.artists) ? d.artists.map(a => a.name).join(', ')
    : (d.owner?.display_name || d.show?.publisher || '');
  return {
    title: d.name || '', artists,
    album: d.album?.name || d.show?.name || '',
    durationMs: d.duration_ms || 0,
    cover: d.album?.images?.[0]?.url || d.images?.[0]?.url || '',
    source: 'spotify-api',
  };
}

/** Metadata via public oEmbed (no credentials required). */
async function viaOembed(parsed) {
  const d = await req(`https://open.spotify.com/oembed?url=${encodeURIComponent(parsed.url)}`, {
    retries: 1, timeout: 15_000, headers: { accept: 'application/json' },
  });
  return {
    title: d.title || '',
    artists: d.author_name || '',   // oEmbed puts "Artist" or "Artist · Track" here
    album: '', durationMs: 0,
    cover: d.thumbnail_url || '',
    source: 'spotify-oembed',
  };
}

/** Resolve a Spotify link (or bare "artist - title") to search terms. */
export async function resolveTrack(input) {
  const parsed = parseSpotifyUrl(input);
  if (!parsed) {
    const query = String(input || '').trim();
    if (!query) throw new Error('Nothing to look up');
    return { title: query, artists: '', album: '', cover: '', durationMs: 0, searchQuery: query, source: 'query' };
  }

  let meta = null;
  try { meta = await viaWebApi(parsed); } catch { /* fall through */ }
  if (!meta) {
    try { meta = await viaOembed(parsed); }
    catch (e) {
      throw Object.assign(new Error('Spotify did not answer — is the link public?'), { code: 'SPOTIFY_META' });
    }
  }
  if (!meta.title) throw Object.assign(new Error('Spotify returned no track metadata'), { code: 'SPOTIFY_META' });

  // "Artist - Title" is what YouTube matches best.
  const searchQuery = [meta.artists, meta.title].filter(Boolean).join(' - ').trim();
  return { ...meta, searchQuery, type: parsed.type };
}
