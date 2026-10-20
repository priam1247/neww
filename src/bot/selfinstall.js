// src/bot/selfinstall.js — panel-friendly self-healing for the WhatsApp adapter.
//
// Why this exists: Pterodactyl-style eggs run `npm install --omit=dev` ONLY when
// node_modules is absent, and npm SILENTLY SKIPS optional dependencies that fail
// to install. A panel deploy can therefore come up "green" without Baileys and
// the bot would die with "Baileys not installed". Instead of exiting, the bot
// now runs a one-shot, bounded `npm install` of just the adapter packages and
// continues booting when it succeeds.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Adapter packages, mirrored from package.json dependencies. */
export const ADAPTER_SPECS = [
  '@whiskeysockets/baileys@^6.7.9',
  'qrcode-terminal@^0.12.0',
];

/** Auto-install is skipped in hermetic/test runs or when explicitly disabled. */
export function shouldAutoInstall(env = process.env) {
  if (String(env.OFFLINE).trim() === '1') return false;
  if (String(env.WA_AUTOSTALL).trim() === '0') return false;
  return true;
}

/** Quiet, non-mutating install args (--no-save keeps package.json authoritative). */
export function npmInstallArgs(specs = ADAPTER_SPECS) {
  return ['install', '--no-save', '--no-audit', '--no-fund', '--loglevel=error', ...specs];
}

// Project root (src/bot/ → up two levels). Panels run the process with cwd at
// the project root already; this is a safety net for pm2/services started elsewhere.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Installed Baileys version from node_modules (null when absent) — boot log/verification. */
export function installedAdapterVersion(cwd = ROOT) {
  try {
    const p = path.join(cwd, 'node_modules', '@whiskeysockets', 'baileys', 'package.json');
    return JSON.parse(fs.readFileSync(p, 'utf8')).version || null;
  } catch {
    return null;
  }
}

/**
 * One-shot `npm install` of the adapter packages.
 * Resolves { ok, code?, error?, ms } — never throws, never retries.
 * stdio is inherited so panel consoles show npm's progress live.
 */
export function selfInstall({ timeoutMs = 5 * 60_000, cwd = ROOT, specs = ADAPTER_SPECS } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn('npm', npmInstallArgs(specs), {
        cwd,
        stdio: 'inherit',
        shell: process.platform === 'win32',
        // npm 12 blocks git-hosted deps by default (EALLOWGIT); baileys needs
        // its libsignal fork from git. Unknown env vars are ignored by older
        // npm, so this is safe on any version. (.npmrc covers the egg's own
        // npm install; this covers our runtime self-install.)
        env: { ...process.env, NPM_CONFIG_ALLOW_GIT: 'all' },
      });
    } catch (e) {
      resolve({ ok: false, error: e.message, ms: 0 });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);
    timer.unref?.();
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message, ms: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, ms: Date.now() - started });
    });
  });
}
