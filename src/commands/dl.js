// src/commands/dl.js — merged from Zafar-bot-main: universal downloader plus
// the site shortcuts. One command for every site the engine can read: YouTube,
// TikTok, Instagram, Facebook, X/Twitter, Reddit, SoundCloud, Pinterest,
// Vimeo, Twitch clips … (yt-dlp supports ~1000 sites; cobalt covers the rest).
import config from '../config.js';
import YT from '../providers/local/ytdlp.js';
import { downloadAndSend, parseOptions } from '../media/pipeline.js';
import { log } from '../core/log.js';
import { metrics } from '../core/metrics.js';

const dlog = log.child('cmd.dl');

export const help = (P) =>
  `📥 *${config.botName} — Download*\n\n*${P}dl <link> [audio|video] [quality]*\n*${P}tiktok <link>* · *${P}x <link>* · *${P}pinterest <link>*\nWorks with ~1000 sites.`;

export async function run(ctx, args) {
  const { kind, height, rest } = parseOptions(args);
  const url = YT.extractUrl(rest.join(' ').trim());
  if (!url) {
    return ctx.say(
      'Usage: .dl <link> [audio|video] [quality]\n' +
      'Example: .dl https://vm.tiktok.com/xxxx\n         .dl https://x.com/user/status/123 audio\n\n' +
      'Works with YouTube, TikTok, Instagram, Facebook, X/Twitter, Reddit, SoundCloud, Pinterest and ~1000 more sites.'
    );
  }
  metrics.bump('command.dl');
  return downloadAndSend(ctx, { url, kind, height });
}

// ── site shortcuts (validating wrappers around the same pipeline) ───────────
const makeShortcut = ({ name, aliases, domains, hostLabel, defaultKind = 'video' }) => ({
  name, aliases, domains, hostLabel, defaultKind,
});

export const SHORTCUTS = [
  makeShortcut({
    name: 'tiktok', aliases: ['tt'],
    domains: ['tiktok.com', 'vt.tiktok.com', 'vm.tiktok.com'], hostLabel: 'TikTok',
  }),
  makeShortcut({
    name: 'x', aliases: ['twitter', 'xtwitter'],
    domains: ['twitter.com', 'x.com', 't.co', 'nitter.'], hostLabel: 'X/Twitter',
  }),
  makeShortcut({
    name: 'pinterest', aliases: ['pin'],
    domains: ['pinterest.', 'pin.it'], hostLabel: 'Pinterest',
  }),
  makeShortcut({
    name: 'instagram', aliases: ['ig', 'insta', 'reels'],
    domains: ['instagram.com', 'instagr.am'], hostLabel: 'Instagram',
  }),
  makeShortcut({
    name: 'fb', aliases: ['facebook'],
    domains: ['facebook.com', 'fb.watch', 'fb.com'], hostLabel: 'Facebook',
  }),
];

/** Shared executor for every shortcut (exported for tests). */
export async function runShortcut(ctx, shortcut, args) {
  const { kind, height, rest } = parseOptions(args, { kind: shortcut.defaultKind });
  const url = YT.extractUrl(rest.join(' ').trim());
  if (!url) return ctx.say(`Usage: ${ctx.prefix || '.'}${shortcut.name} <link>\nExample: ${ctx.prefix || '.'}${shortcut.name} https://...`);
  const known = shortcut.domains.some(d => url.toLowerCase().includes(d));
  if (!known) {
    // not this site — hand it to the universal pipeline instead of failing
    await ctx.say(`ℹ️ That is not a ${shortcut.hostLabel} link — using the general downloader.`);
  }
  metrics.bump(`command.${shortcut.name}`);
  return downloadAndSend(ctx, { url, kind, height });
}

export const shortcuts = SHORTCUTS;
