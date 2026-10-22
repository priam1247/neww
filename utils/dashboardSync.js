/**
 * ZaFar Bot — Outbound HTTPS Dashboard Sync (`POST /api/bot/sync`)
 *
 * Works cleanly behind Hydrodactyl / Pterodactyl NAT with ZERO open ports:
 *   1. Pushes live heartbeat ("last seen Xs ago", WhatsApp socket state, disk MB)
 *   2. Pushes unsynced WhatsApp `.allow` numbers up to Cloudflare D1 and pulls
 *      versioned `whitelist.json` deltas down atomically via `accessControl.js`
 *   3. Claims queued `pair` and `restart` commands from Cloudflare D1 and reports
 *      the 8-character pairing code back immediately
 *   4. Signs every request with `HMAC-SHA256` + timestamp + random nonce
 */

'use strict';

const crypto = require('crypto');
const path = require('path');
const config = require('../config');
const { readWL, writeWL } = require('./accessControl');
const { inspectDisk } = require('./diskSpace');
const { panelRestart } = require('./panelClient');
const log = require('./logger')('dashboardSync');

const WL_FILE = path.join(__dirname, '..', 'database', 'whitelist.json');
const BOT_BOOT_AT = Date.now();

let botVersion = '';
try {
  botVersion = require('../package.json').version || '';
} catch {
  /* ignore */
}

let activeController = null;

function cleanDigits(raw) {
  return String(raw || '').replace(/[^0-9]/g, '');
}

function buildSignedHeaders(token, _method, _urlPath, bodyText = '') {
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  const sig =
    'sha256=' +
    crypto
      .createHmac('sha256', token)
      .update(`${ts}.${nonce}.${bodyText}`)
      .digest('hex');
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'X-Bot-Timestamp': ts,
    'X-Bot-Nonce': nonce,
    'X-Bot-Signature': sig,
  };
}

function collectUnsyncedLocalUsers(wlFile = WL_FILE) {
  const current = readWL({ force: true, filePath: wlFile });
  const list = Array.isArray(current?.users) ? current.users : [];
  const out = [];
  for (const u of list) {
    const num = cleanDigits(u?.number);
    if (num.length < 7 || num.length > 15) continue;
    const isUnsyncedLocal =
      !u.syncedToPortal && (!u.addedBy || u.addedBy === 'whatsapp');
    if (isUnsyncedLocal && u.enabled !== false) {
      out.push({
        number: num,
        label: String(u.label || 'Added via WhatsApp .allow'),
      });
    }
  }
  return out;
}

function applyWhitelistSnapshot(users, wlFile = WL_FILE) {
  if (!Array.isArray(users)) return false;
  const current = readWL({ force: true, filePath: wlFile });
  const existingByNum = new Map();
  for (const u of Array.isArray(current.users) ? current.users : []) {
    const num = cleanDigits(u?.number);
    if (num) existingByNum.set(num, u);
  }

  // Portal snapshot is authoritative while preserving any LID `alt` aliases learned in WhatsApp
  const remoteMap = new Map();
  for (const raw of users) {
    const num = cleanDigits(raw?.number);
    if (num.length < 7 || num.length > 15) continue;
    const prev = existingByNum.get(num);
    remoteMap.set(num, {
      number: num,
      ...(Array.isArray(prev?.alt) && prev.alt.length ? { alt: prev.alt } : {}),
      label: String(raw?.label || prev?.label || ''),
      addedBy: String(raw?.addedBy || prev?.addedBy || 'dashboard'),
      addedAt: Number(raw?.addedAt || prev?.addedAt || Date.now()),
      enabled: raw?.enabled !== false,
      syncedToPortal: true,
    });
  }

  // Keep brand-new `.allow` entries that haven't been pushed to the portal yet
  for (const [num, prev] of existingByNum.entries()) {
    if (!remoteMap.has(num) && !prev.syncedToPortal && (!prev.addedBy || prev.addedBy === 'whatsapp')) {
      remoteMap.set(num, prev);
    }
  }

  writeWL({ users: Array.from(remoteMap.values()) }, { filePath: wlFile });
  return true;
}

function upsertAllowedNumber(number, label, wlFile = WL_FILE) {
  const num = cleanDigits(number);
  if (num.length < 7 || num.length > 15) return;
  const data = readWL({ force: true, filePath: wlFile });
  if (!Array.isArray(data.users)) data.users = [];
  const existing = data.users.find((u) => cleanDigits(u?.number) === num);
  if (existing) {
    existing.enabled = true;
    existing.syncedToPortal = true;
    if (label) existing.label = String(label);
  } else {
    data.users.push({
      number: num,
      label: String(label || 'Portal Linked'),
      addedBy: 'dashboard',
      addedAt: Date.now(),
      enabled: true,
      syncedToPortal: true,
    });
  }
  writeWL(data, { filePath: wlFile });
}

function startDashboardSync(opts = {}) {
  const env = opts.env || process.env;
  const fetchImpl = opts.fetchImpl || fetch;
  const wlFile = opts.wlFile || WL_FILE;

  const baseUrl = String(opts.dashboardUrl ?? env.DASHBOARD_URL ?? '')
    .trim()
    .replace(/\/+$/, '');
  const token = String(
    opts.token ?? env.BOT_SYNC_TOKEN ?? env.ADMIN_DASHBOARD_TOKEN ?? '',
  ).trim();

  if (!baseUrl || !token) {
    return {
      enabled: false,
      stop() {},
      syncNow: async () => ({ ok: false, skipped: true }),
    };
  }

  const defaultIntervalMs = Math.max(
    2_000,
    Number(opts.intervalMs ?? env.DASHBOARD_SYNC_INTERVAL_MS ?? 10_000) || 10_000,
  );

  let stopped = false;
  let timer = null;
  let inFlight = false;
  let rerunImmediately = false;
  let lastWhitelistVersion = '';
  let consecutiveFailures = 0;
  const pendingResults = [];

  const scheduleNext = (ms) => {
    if (stopped || opts.manualOnly) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void runSyncTick();
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  };

  async function executeCommand(cmd) {
    if (!cmd || typeof cmd.id !== 'string') return;
    try {
      if (cmd.type === 'pair') {
        const number = cleanDigits(cmd.payload?.number);
        const label = String(cmd.payload?.label || 'Portal Linked');
        if (number.length < 7 || number.length > 15) {
          throw new Error('Invalid phone number in pairing command.');
        }
        upsertAllowedNumber(number, label, wlFile);
        if (typeof opts.requestPairing !== 'function') {
          throw new Error('Bot pairing handler is not wired.');
        }
        const res = await opts.requestPairing(number);
        pendingResults.push({
          id: cmd.id,
          ok: true,
          result: {
            code: res.code,
            expiresInSeconds: res.expiresInSeconds || 60,
          },
        });
        return;
      }

      if (cmd.type === 'restart') {
        pendingResults.push({
          id: cmd.id,
          ok: true,
          result: { restarting: true },
        });
        setTimeout(async () => {
          const panelRes = await panelRestart();
          if (!panelRes.ok && typeof opts.requestRestart === 'function') {
            await opts.requestRestart();
          }
        }, 600).unref?.();
        return;
      }

      pendingResults.push({
        id: cmd.id,
        ok: false,
        error: `Unsupported command type: ${String(cmd.type)}`,
      });
    } catch (err) {
      pendingResults.push({
        id: cmd.id,
        ok: false,
        error: err?.message || 'Command failed on bot',
      });
    }
  }

  async function runSyncTick() {
    if (stopped) return { ok: false, stopped: true };
    if (inFlight) {
      rerunImmediately = true;
      return { ok: true, coalesced: true };
    }

    inFlight = true;
    const status =
      typeof opts.getStatus === 'function'
        ? opts.getStatus() || {}
        : { connected: false, botNumber: null };

    let diskUsedMB;
    let diskBudgetMB;
    try {
      const d = inspectDisk();
      diskUsedMB = Math.round(d.folderUsedMB);
      diskBudgetMB = Math.round(d.budgetMB);
    } catch {
      /* non-fatal */
    }

    const localUsers = collectUnsyncedLocalUsers(wlFile);
    const batchResults = pendingResults.splice(0, pendingResults.length);
    const bodyObj = {
      connected: Boolean(status.connected),
      botNumber: status.botNumber || null,
      botName: config.botName,
      version: botVersion,
      uptimeSeconds: Math.floor((Date.now() - BOT_BOOT_AT) / 1000),
      diskUsedMB,
      diskBudgetMB,
      whitelistVersion: lastWhitelistVersion,
      ...(localUsers.length ? { localUsers } : {}),
      completedResults: batchResults,
    };

    const bodyText = JSON.stringify(bodyObj);
    const urlPath = '/api/bot/sync';

    try {
      const headers = buildSignedHeaders(token, 'POST', urlPath, bodyText);
      const res = await fetchImpl(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers,
        body: bodyText,
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        if (batchResults.length) pendingResults.unshift(...batchResults);
        consecutiveFailures++;
        const backoff = Math.min(60_000, defaultIntervalMs * Math.pow(1.6, consecutiveFailures));
        if (consecutiveFailures === 1 || consecutiveFailures % 10 === 0) {
          log.warn(`Dashboard sync answered HTTP ${res.status}; retrying in ${Math.round(backoff / 1000)}s`);
        }
        inFlight = false;
        scheduleNext(backoff);
        return { ok: false, status: res.status };
      }

      const data = await res.json().catch(() => ({}));
      consecutiveFailures = 0;

      if (data.whitelistChanged && Array.isArray(data.users)) {
        applyWhitelistSnapshot(data.users, wlFile);
        if (typeof data.whitelistVersion === 'string') {
          lastWhitelistVersion = data.whitelistVersion;
        }
      } else if (typeof data.whitelistVersion === 'string' && !lastWhitelistVersion) {
        lastWhitelistVersion = data.whitelistVersion;
      }

      const commands = Array.isArray(data.commands) ? data.commands : [];
      for (const cmd of commands) {
        await executeCommand(cmd);
      }

      inFlight = false;

      if (pendingResults.length > 0 || rerunImmediately) {
        rerunImmediately = false;
        scheduleNext(150);
      } else {
        const nextMs = Math.max(
          2_000,
          Math.min(60_000, Number(data.nextPollMs) || defaultIntervalMs),
        );
        scheduleNext(nextMs);
      }

      return { ok: true, commandsExecuted: commands.length };
    } catch (err) {
      if (batchResults.length) pendingResults.unshift(...batchResults);
      consecutiveFailures++;
      const backoff = Math.min(60_000, defaultIntervalMs * Math.pow(1.6, consecutiveFailures));
      if (consecutiveFailures === 1 || consecutiveFailures % 12 === 0) {
        log.warn(`Dashboard sync unreachable (${err.message || err}); retrying in ${Math.round(backoff / 1000)}s`);
      }
      inFlight = false;
      scheduleNext(backoff);
      return { ok: false, error: err.message || String(err) };
    }
  }

  const controller = {
    enabled: true,
    dashboardUrl: baseUrl,
    syncNow: () => runSyncTick(),
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };

  if (!opts.manualOnly) {
    activeController = controller;
    scheduleNext(250);
  }

  return controller;
}

function triggerImmediateSync() {
  if (activeController && activeController.enabled) {
    void activeController.syncNow();
  }
}

module.exports = {
  startDashboardSync,
  triggerImmediateSync,
  buildSignedHeaders,
  applyWhitelistSnapshot,
  collectUnsyncedLocalUsers,
};
