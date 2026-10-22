/**
 * ZaFar Bot — Admin HTTP API (the endpoint the web dashboard talks to)
 *
 * The dashboard (PriamNeW web app) links to a bot with two values it stores in
 * Cloudflare D1: a Bot Server URL and an ADMIN_DASHBOARD_TOKEN. It then calls
 * exactly these routes (see lib/bot-proxy.ts in the dashboard):
 *
 *   GET    /admin/api/status          → { connected, botNumber, … }
 *   GET    /admin/api/users           → { ok, users: [{ number, label, enabled }] }
 *   POST   /admin/api/users           { number, label }   → register / re-enable
 *   PATCH  /admin/api/users/:number   { enabled }         → allow / disallow
 *   DELETE /admin/api/users/:number                       → remove
 *   POST   /admin/api/pair            { number }          → { code, expiresInSeconds }
 *
 * Every route needs `Authorization: Bearer <ADMIN_DASHBOARD_TOKEN>`; the
 * listeners are on the *bot* side, so a bot behind NAT can either be reached
 * directly or pull the whitelist itself (utils/allowlistSync.js).
 *
 * Deliberately tiny: no framework, no Express, one socket, in-memory routing.
 */

const http = require('http');
const crypto = require('crypto');
const { readWL, writeWL, cleanNumber, findUserIndex } = require('./accessControl');
const log = require('./logger')('admin-api');

const MAX_BODY_BYTES = 64 * 1024;

function timingSafeEqualStr(a, b) {
  const A = Buffer.from(String(a || ''));
  const B = Buffer.from(String(b || ''));
  if (A.length !== B.length) return false;
  try { return crypto.timingSafeEqual(A, B); } catch { return false; }
}

function normalizeOrigin(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    return new URL(raw).origin;
  } catch {
    return '';
  }
}

function buildAllowedOrigins(explicit = []) {
  const set = new Set();
  const add = (val) => {
    const o = normalizeOrigin(val);
    if (o) set.add(o);
  };
  for (const item of Array.isArray(explicit) ? explicit : [explicit]) add(item);
  for (const part of String(process.env.ADMIN_CORS_ORIGINS || '').split(',')) add(part);
  add(process.env.DASHBOARD_URL);
  return set;
}

function corsHeadersFor(req, allowedOrigins) {
  const origin = normalizeOrigin(req?.headers?.origin);
  if (!origin || !allowedOrigins || !allowedOrigins.has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Admin-Token',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  };
}

function send(res, statusCode, body, extraHeaders = {}) {
  const payload = JSON.stringify(body ?? {});
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(Object.assign(new Error('invalid JSON body'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

/** Normalise the many shapes a number can arrive in. */
const toNumber = (value) => cleanNumber(String(value ?? ''));

/** Public shape of a whitelist entry, matching what the dashboard renders. */
const publicUser = (u) => ({
  number: String(u.number || ''),
  label: String(u.label || ''),
  enabled: u.enabled !== false,
  addedAt: Number(u.addedAt || 0),
  source: u.source || 'bot',
});

function listUsers() {
  return readWL().users.map(publicUser);
}

/**
 * Register (or re-enable) a number.
 * @returns {{user:object, created:boolean}|null}
 */
function upsertUser(number, label = '', { enabled = true, source = 'dashboard' } = {}) {
  const n = toNumber(number);
  if (!n) return null;
  const wl = readWL();
  const idx = findUserIndex(wl.users, `${n}@s.whatsapp.net`);
  if (idx === -1) {
    const entry = { number: n, addedAt: Date.now(), enabled, source };
    if (label) entry.label = String(label).slice(0, 60);
    wl.users.push(entry);
    writeWL(wl);
    return { user: publicUser(entry), created: true };
  }
  const entry = wl.users[idx];
  entry.enabled = enabled !== false;
  entry.source = source;
  if (label) entry.label = String(label).slice(0, 60);
  writeWL(wl);
  return { user: publicUser(entry), created: false };
}

function setUserEnabled(number, enabled) {
  const n = toNumber(number);
  if (!n) return null;
  const wl = readWL();
  const idx = findUserIndex(wl.users, `${n}@s.whatsapp.net`);
  if (idx === -1) return null;
  wl.users[idx].enabled = enabled !== false;
  writeWL(wl);
  return publicUser(wl.users[idx]);
}

function removeUser(number) {
  const n = toNumber(number);
  if (!n) return false;
  const wl = readWL();
  const idx = findUserIndex(wl.users, `${n}@s.whatsapp.net`);
  if (idx === -1) return false;
  wl.users.splice(idx, 1);
  writeWL(wl);
  return true;
}

/**
 * Start the API.
 * @param {object} opts
 * @param {number} opts.port
 * @param {string} opts.token
 * @param {object} opts.hooks  { status(), requestPair(number) }
 */
function startAdminApi({ port, token, allowedOrigins = [], hooks = {} } = {}) {
  if (!token) {
    log.warn('ADMIN_DASHBOARD_TOKEN is not set — dashboard API stays off');
    return null;
  }
  if (!port) {
    log.warn('no port configured — dashboard API stays off');
    return null;
  }

  const originAllowlist = buildAllowedOrigins(allowedOrigins);

  const status = async () => {
    try {
      return await (hooks.status ? hooks.status() : { connected: false, botNumber: null });
    } catch (e) {
      return { connected: false, botNumber: null, error: e.message };
    }
  };

  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    let pathname = '/';
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { /* keep default */ }

    const cors = corsHeadersFor(req, originAllowlist);
    const reply = (code, body, extra = {}) => send(res, code, body, { ...cors, ...extra });

    // health is the only unauthenticated route (uptime checks / port probes)
    if (req.method === 'GET' && (pathname === '/health' || pathname === '/ping')) {
      return reply(200, { ok: true });
    }
    if (req.method === 'OPTIONS') {
      if (req.headers.origin && !cors['Access-Control-Allow-Origin']) {
        return reply(403, { error: 'Origin not allowed' });
      }
      return reply(204, {});
    }

    const provided = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
      || String(req.headers['x-admin-token'] || '').trim();
    if (!provided || !timingSafeEqualStr(provided, token)) {
      return reply(401, { error: 'Unauthorized' });
    }

    // Accept both /admin/api/x and /api/x so BOT_API_URL can be either form.
    const route = pathname.replace(/^\/admin\/api(?=\/|$)/, '/api').replace(/\/+$/, '') || '/';

    try {
      if (req.method === 'GET' && route === '/api/status') {
        const s = await status();
        return reply(200, {
          ok: true,
          service: 'zafar-bot',
          uptimeSeconds: Math.round(process.uptime()),
          users: listUsers().length,
          ...s,
        });
      }

      if (req.method === 'GET' && (route === '/api/users' || route === '/api/whitelist')) {
        return reply(200, { ok: true, users: listUsers() });
      }

      if (req.method === 'POST' && route === '/api/users') {
        const body = await readBody(req);
        const result = upsertUser(body.number, body.label, { enabled: body.enabled !== false });
        if (!result) return reply(400, { error: 'A valid phone number (with country code) is required.' });
        log.info(`user ${result.user.number} ${result.created ? 'added' : 'updated'}`);
        return reply(result.created ? 201 : 200, { ok: true, ...result });
      }

      const userMatch = route.match(/^\/api\/users\/([^/]+)$/);
      if (userMatch) {
        const number = decodeURIComponent(userMatch[1]);

        if (req.method === 'PATCH') {
          const body = await readBody(req);
          const updated = setUserEnabled(number, body.enabled !== false);
          if (!updated) return reply(404, { error: 'That number is not registered on this bot.' });
          log.info(`user ${updated.number} ${updated.enabled ? 'enabled' : 'disabled'}`);
          return reply(200, { ok: true, user: updated });
        }

        if (req.method === 'DELETE') {
          const gone = removeUser(number);
          if (!gone) return reply(404, { error: 'That number is not registered on this bot.' });
          log.info(`user ${toNumber(number)} removed`);
          return reply(200, { ok: true });
        }
      }

      if (req.method === 'POST' && route === '/api/pair') {
        const body = await readBody(req);
        const number = toNumber(body.number);
        if (!number) return reply(400, { error: 'A valid phone number (with country code) is required.' });
        if (typeof hooks.requestPair !== 'function') {
          return reply(501, { error: 'Pairing is not available on this bot build.' });
        }
        const result = await hooks.requestPair(number);
        return reply(200, {
          ok: true,
          code: String(result.code || ''),
          expiresInSeconds: Number(result.expiresInSeconds) || 60,
          number,
          issuedAt: Date.now(),
        });
      }

      return reply(404, { error: `No route for ${req.method} ${pathname}` });
    } catch (e) {
      const code = e.statusCode || (e.code === 'PAIR_BUSY' ? 409 : e.code === 'WHITELIST_CORRUPT' ? 503 : 500);
      log.warn(`${req.method} ${pathname} → ${code} · ${e.message}`);
      return reply(code, { error: e.message || 'Bot error' });
    } finally {
      log.debug(`${req.method} ${pathname} · ${Date.now() - startedAt}ms`);
    }
  });

  server.on('error', (e) => {
    log.error(`could not listen on :${port} · ${e.message}`);
  });

  // 0.0.0.0: the dashboard (or a tunnel/port map in front of the panel) has to
  // reach this from outside the container.
  server.listen(port, '0.0.0.0', () => {
    log.info(`dashboard API listening on 0.0.0.0:${port} (/admin/api/status)`);
  });

  return {
    server,
    port,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

module.exports = {
  startAdminApi, listUsers, upsertUser, setUserEnabled, removeUser, toNumber, publicUser,
};
