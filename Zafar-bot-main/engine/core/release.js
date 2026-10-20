// src/core/release.js — release-name parser. All of 2.0's parser bugs fixed:
//  • language regexes used '\bHINDI\b' (backspace chars!) — now proper \b
//  • group = LAST hyphen segment (2.0 matched "DL" out of "WEB-DL")
//  • absolute-episode detection handles "- 245 [1080p]" style anime names
export const QUALITY = /\b(2160p|1080p|720p|480p|4320p|4k)\b/i;
export const CODEC = /\b(x265|x264|h\.?265|h\.?264|hevc|av1|10bit)\b/i;
const SOURCE = [
  [/remux/i, 'REMUX'], [/bluray|bdrip|brrip|bdremux/i, 'BLURAY'],
  [/web-?dl/i, 'WEBDL'], [/webrip|web-?rip/i, 'WEBRIP'],
  [/hdtv/i, 'HDTV'], [/hdrip/i, 'HDRIP'], [/dvdrip/i, 'DVDRIP'],
  [/hdcam|camrip|\bcam\b|\bts\b|telesync/i, 'CAM']
];
const NETWORKS = /\b(NF|AMZN|DSNP|ATVP|HMAX|MAX|HULU|iT|PCOK|STAN|CRAV|BCORE|RED)\b/;
const AUDIO = [
  [/dual[ ._-]?audio/i, 'dual'], [/multi[ ._-]?audio/i, 'multi'],
  [/\bDDP?[ .]?5[. ]?1\b/i, 'dd51'], [/\bAAC(?:[ .]?2[. ]?0)?\b/i, 'aac'],
  [/\bDTS(?:-HD)?\b/i, 'dts'], [/\bAtmos\b/i, 'atmos'], [/\bTrueHD\b/i, 'truehd']
];
// FIXED: word boundaries via real \b regexes — 2.0 used raw '\b' string
// escapes which produce backspace control chars (0x08) and never match.
const LANGUAGES = [
  [/\bhindi\b|\bzin\b/i, 'hi'], [/\btamil\b/i, 'ta'], [/\btelugu\b/i, 'te'],
  [/\bmalayalam\b/i, 'ml'], [/\bkorean\b/i, 'ko'], [/\bjapanese\b/i, 'ja'],
  [/\bspanish\b|castellano|\blatino\b/i, 'es'], [/\bfrench\b|truefrench/i, 'fr'],
  [/\bgerman\b/i, 'de'], [/\bitalian\b/i, 'it'],
  [/\bportuguese\b|dublado/i, 'pt'], [/\brussian\b/i, 'ru'], [/\barabic\b/i, 'ar']
];
const EXT = /\.[a-z0-9]{2,4}$/i;

const SEASON_EP = [
  /\bs(\d{1,2})[\s._-]?e(\d{1,3})(?:[\s._-]?e(\d{1,3}))?\b/i,
  /\b(\d{1,2})x(\d{2,3})\b/,
  /\bseason[ ._-]?(\d{1,2})[ ._-]?(?:ep|episode)[ ._-]?(\d{1,3})\b/i
];
// absolute episode: standalone 1-4 digit number closed by bracket/paren/EOS
const ABS_EP = /(?:^|[\s._-])(\d{1,4})[\s._-]*(\[|\(|$)/;
const NOT_ABS = new Set(['480', '576', '720', '1080', '2160', '4320', '50', '60', '24', '25', '30', '1000', '1998', '2000']);
const SEASON_ONLY = /\b(?:s|season[ ._-]?)(\d{1,2})\b(?![ ._-]?e\d)/i;
const PACK = /\b(complete|season[ ._-]?\d|s\d{1,2}\b(?![ ._-]?e)|pack|collection)\b/i;

export function qualityOf(name) {
  const m = QUALITY.exec(name || '');
  if (!m) return 0;
  return /4k|4320p/i.test(m[1]) ? 2160 : parseInt(m[1], 10);
}

// group = last hyphen segment (handles "-GROUP[ettv]" and "-EVO" endings)
function groupOf(name) {
  const n = String(name || '').replace(EXT, '').replace(/\[[^\]]*\]\s*$/, '');
  const m = /-([A-Za-z0-9]{2,15})$/.exec(n.trim());
  return m ? m[1] : null;
}

export function parseRelease(name) {
  const n = String(name || '');
  const out = {
    quality: qualityOf(n), codec: null, sourceTag: 'UNKNOWN', network: null,
    audio: [], langs: [], group: null, isPack: false,
    season: null, episode: null, endEpisode: null, absolute: null
  };

  const c = CODEC.exec(n);
  if (c) out.codec = /265|hevc/i.test(c[1]) ? 'x265' : /av1/i.test(c[1]) ? 'av1' : 'x264';

  for (const [re, tag] of SOURCE) if (re.test(n)) { out.sourceTag = tag; break; }
  const net = NETWORKS.exec(n); if (net) out.network = net[1];
  for (const [re, a] of AUDIO) if (re.test(n)) out.audio.push(a);
  for (const [re, l] of LANGUAGES) if (re.test(n)) out.langs.push(l);
  out.group = groupOf(n);

  for (const re of SEASON_EP) {
    const m = re.exec(n);
    if (m) {
      out.season = Number(m[1]); out.episode = Number(m[2]);
      if (m[3]) out.endEpisode = Number(m[3]);
      break;
    }
  }
  if (out.episode === null) {
    const a = ABS_EP.exec(n);
    if (a && !NOT_ABS.has(a[1]) && Number(a[1]) >= 2) {
      // a bare EOS-terminated 19xx/20xx number is a YEAR, not an episode
      const yearLike = a[2] !== '[' && a[2] !== '(' && Number(a[1]) >= 1917 && Number(a[1]) <= 2127;
      if (!yearLike) {
        out.absolute = Number(a[1]);
        out.season = 1;                      // anime numbering
      }
    }
  }
  if (out.season === null) {
    const s = SEASON_ONLY.exec(n);
    if (s) out.season = Number(s[1]);
  }
  out.isPack = PACK.test(n) && out.episode === null;

  return out;
}

// does this release actually contain the season/episode we want?
export function matchesEpisode(rel, season, episode, name = '') {
  if (rel.episode !== null && rel.season !== null) {
    if (rel.season !== season) return false;
    if (rel.endEpisode !== null) return episode >= rel.episode && episode <= rel.endEpisode;
    return rel.episode === episode;
  }
  if (rel.episode !== null && rel.season === null) return rel.episode === episode;
  if (rel.absolute !== null) return season === 1 && rel.absolute === episode;
  if (rel.isPack) {
    const s = SEASON_ONLY.exec(name || '');
    return !s || Number(s[1]) === season;
  }
  return true;      // unlabelled — let verification decide
}
