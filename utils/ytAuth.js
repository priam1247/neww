'use strict';

/**
 * ZaFar Bot — YouTube OAuth2 Device-Code Credentials (`.ytlogin`)
 *
 * Adapted from levanter's TV OAuth2 flow (`youtubei.js` session.signIn()):
 *   • Owner runs `.ytlogin` → gets `https://www.google.com/device` + an 8-char code.
 *   • Once approved on phone/PC, OAuth2 tokens (`access_token`, `refresh_token`,
 *     `expiry_date`) are saved atomically to `database/yt_auth.json`.
 *   • Unlike browser `cookies.txt` (which expire or rotate whenever a browser
 *     session changes), OAuth2 refresh tokens renew automatically on use via
 *     `credentials-update` and survive SFTP deploys (`database/*.json` is
 *     never overwritten by deploy-panel.yml).
 */

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic, readJsonSafe } = require('./jsonStore');

const DB_DIR = path.join(__dirname, '..', 'database');
const AUTH_FILE = path.join(DB_DIR, 'yt_auth.json');

const _listeners = new Set();

function onAuthChange(fn) {
  if (typeof fn === 'function') _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function notifyAuthChange() {
  for (const fn of _listeners) {
    try { fn(); } catch { /* ignore */ }
  }
}

const isValidCreds = (v) =>
  Boolean(v && typeof v === 'object' && !Array.isArray(v) && (v.refresh_token || v.access_token));

function authFilePath() {
  return process.env.YT_AUTH_FILE ? path.resolve(process.env.YT_AUTH_FILE) : AUTH_FILE;
}

function getYtCreds() {
  const target = authFilePath();
  if (!fs.existsSync(target)) return null;
  const res = readJsonSafe(target, { defaultValue: null });
  if (!res.ok || !isValidCreds(res.data)) return null;
  return res.data;
}

function hasYtCreds() {
  return Boolean(getYtCreds());
}

function saveYtCreds(creds, { notify = true } = {}) {
  if (!isValidCreds(creds)) {
    throw Object.assign(new Error('Invalid YouTube OAuth credentials'), { code: 'BAD_YT_CREDS' });
  }
  const target = authFilePath();
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const payload = {
    ...creds,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(target, payload);
  try { fs.chmodSync(target, 0o600); } catch { /* windows */ }
  if (notify) notifyAuthChange();
  return payload;
}

function clearYtCreds() {
  const target = authFilePath();
  let removed = false;
  try {
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
      removed = true;
    }
  } catch { /* ignore */ }
  notifyAuthChange();
  return removed;
}

let _ytModule = null;
async function loadYoutubei() {
  if (_ytModule) return _ytModule;
  _ytModule = await import('youtubei.js');
  return _ytModule;
}

/** Override for deterministic offline unit tests. */
let _innertubeFactory = null;
function _setInnertubeFactoryForTest(fn) {
  _innertubeFactory = fn;
}

/**
 * Start a Google TV OAuth2 device-code login session.
 *
 * @param {{ onCode?: (data: { verificationUrl: string, userCode: string, expiresIn: number }) => any, timeoutMs?: number }} [opts]
 * @returns {Promise<object>} saved OAuth credentials
 */
async function startYtLogin({ onCode, timeoutMs } = {}) {
  let innertube;
  if (_innertubeFactory) {
    innertube = await _innertubeFactory();
  } else {
    const yt = await loadYoutubei();
    innertube = await yt.Innertube.create({
      cache: new yt.UniversalCache(false),
      generate_session_locally: true,
    });
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(val);
    };

    innertube.session.once('auth-pending', (data) => {
      const expiresSec = Math.max(30, Number(data?.expires_in) || 300);
      const waitMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : (expiresSec + 10) * 1000;
      timer = setTimeout(() => {
        finish(reject, Object.assign(new Error('Login timed out — code expired. Run .ytlogin again.'), { code: 'LOGIN_TIMEOUT' }));
      }, waitMs);
      timer.unref?.();

      const verificationUrl = String(data?.verification_url || 'https://www.google.com/device').trim();
      const userCode = String(data?.user_code || '').trim();
      if (typeof onCode === 'function') {
        Promise.resolve(onCode({ verificationUrl, userCode, expiresIn: expiresSec })).catch(() => {});
      }
    });

    innertube.session.once('auth', ({ credentials }) => {
      try {
        const saved = saveYtCreds(credentials);
        finish(resolve, saved);
      } catch (err) {
        finish(reject, err);
      }
    });

    innertube.session.once('auth-error', (err) => {
      const error = err instanceof Error ? err : new Error(err?.message || 'YouTube OAuth failed');
      finish(reject, error);
    });

    Promise.resolve(innertube.session.signIn()).catch((err) => {
      finish(reject, err instanceof Error ? err : new Error(String(err)));
    });
  });
}

module.exports = {
  authFilePath,
  getYtCreds,
  hasYtCreds,
  saveYtCreds,
  clearYtCreds,
  onAuthChange,
  startYtLogin,
  _setInnertubeFactoryForTest,
};
