/**
 * ZaFar Bot — dashboard whitelist sync
 *
 * The dashboard stores member numbers in Cloudflare D1 and exposes them at
 * `GET {DASHBOARD_URL}/api/bot/whitelist` for bots behind NAT:
 *
 *   Authorization: Bearer <ADMIN_DASHBOARD_TOKEN>
 *   → { ok, botEnabledForMembers, numbers: [...], users: [{ number, label, enabled }] }
 *
 * The dashboard is the source of truth for *members*. Numbers added with
 * `.allow` on the phone are kept too (source: 'bot'), and the owner/admin
 * numbers are never in this file, so nothing here can lock the owner out.
 *
 * A failed sync is silent: WhatsApp keeps working with the last known list.
 */

const config = require('../config');
const { readWL, writeWL, cleanNumber } = require('./accessControl');
const log = require('./logger')('sync');

const STATE_FILE = require('path').join(__dirname, '..', 'database', 'dashboard_sync.json');

function readState() {
  try { return JSON.parse(require('fs').readFileSync(STATE_FILE, 'utf8')) || {}; } catch { return {}; }
}

function writeState(next) {
  try {
    const fs = require('fs');
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  } catch { /* non-fatal */ }
}

/** Merge the dashboard's members into the local whitelist. */
function mergeMembers(members) {
  const wl = readWL();
  const before = wl.users.length;

  // dashboard-managed entries are replaced wholesale; bot-added ones survive
  const kept = wl.users.filter((u) => u.source !== 'dashboard');
  const seen = new Set(kept.map((u) => String(u.number)));

  const merged = [...kept];
  for (const m of members) {
    const number = cleanNumber(String(m.number ?? m));
    if (!number || seen.has(number)) continue;
    seen.add(number);
    merged.push({
      number,
      enabled: m.enabled !== false,
      label: m.label ? String(m.label).slice(0, 60) : '',
      source: 'dashboard',
      addedAt: Number(m.addedAt || Date.now()),
    });
  }

  wl.users = merged;
  writeWL(wl);
  return { before, after: wl.users.length, enabled: wl.users.filter((u) => u.enabled !== false).length };
}

async function syncOnce() {
  const { dashboardUrl, token } = config.admin || {};
  if (!dashboardUrl || !token) return { skipped: true };

  const res = await fetch(`${dashboardUrl}/api/bot/whitelist`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) throw new Error(`whitelist HTTP ${res.status}`);
  const data = await res.json().catch(() => ({}));
  const members = Array.isArray(data.users)
    ? data.users
    : (Array.isArray(data.numbers) ? data.numbers.map((n) => ({ number: n, enabled: true })) : []);

  // "members may use the bot" off + no members listed → nobody but owner/admin
  if (data.botEnabledForMembers === false) {
    const wl = readWL();
    wl.users = wl.users.filter((u) => u.source !== 'dashboard');
    writeWL(wl);
    writeState({ at: Date.now(), ok: true, count: 0, note: 'members disabled on dashboard' });
    log.info('members disabled on the dashboard — member numbers cleared');
    return { ok: true, count: 0 };
  }

  const result = mergeMembers(members);
  writeState({ at: Date.now(), ok: true, count: result.after });
  if (result.after !== result.before) {
    log.info(`whitelist synced · ${result.after} allowed (${result.enabled} active)`);
  }
  return { ok: true, ...result };
}

/**
 * Start the background sync. No-op unless DASHBOARD_URL + token are set.
 * @returns {{stop:Function}|null}
 */
function startAllowlistSync() {
  const { dashboardUrl, token, syncMinutes } = config.admin || {};
  if (!dashboardUrl || !token) {
    log.debug('dashboard URL or token missing — whitelist pull sync stays off');
    return null;
  }

  const run = () => {
    syncOnce().catch((e) => {
      writeState({ at: Date.now(), ok: false, error: e.message });
      log.debug(`whitelist sync failed · ${e.message}`);
    });
  };

  run();
  const timer = setInterval(run, Math.max(1, Number(syncMinutes) || 5) * 60_000);
  timer.unref?.();
  log.info(`whitelist pull sync every ${Math.max(1, Number(syncMinutes) || 5)} min from ${dashboardUrl}`);
  return { stop: () => clearInterval(timer) };
}

module.exports = { syncOnce, startAllowlistSync, mergeMembers };
