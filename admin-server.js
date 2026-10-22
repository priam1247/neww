const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const whitelistPath = path.join(__dirname, 'database', 'whitelist.json');
const adminEmail = 'troykunsauka6@gmail.com';

function readWhitelist() {
  try { return JSON.parse(fs.readFileSync(whitelistPath, 'utf8')); } catch { return { users: [] }; }
}
function writeWhitelist(data) {
  const tmp = `${whitelistPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, whitelistPath);
}
function normalizeNumber(input) { return String(input || '').replace(/[^0-9]/g, ''); }
function adminAuthorized(req) {
  const expected = process.env.ADMIN_DASHBOARD_TOKEN;
  const provided = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.headers['x-admin-token'];
  if (!expected || !provided) return false;
  const providedBuffer = Buffer.from(String(provided));
  const expectedBuffer = Buffer.from(String(expected));
  return providedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
function body(req) { return new Promise((resolve, reject) => { let raw = ''; req.on('data', c => { raw += c; if (raw.length > 20_000) req.destroy(); }); req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON')); } }); req.on('error', reject); }); }

function startAdminServer({ getSocket }) {
  const port = Number(process.env.ADMIN_PORT || 3000);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(path.join(__dirname, 'admin', 'index.html')));
    }
    if (!url.pathname.startsWith('/admin/api/')) return json(res, 404, { error: 'Not found' });
    if (!adminAuthorized(req)) return json(res, 401, { error: `Admin authorization required for ${adminEmail}` });
    try {
      const data = readWhitelist();
      if (req.method === 'GET' && url.pathname === '/admin/api/status') {
        const socket = getSocket();
        return json(res, 200, { ok: true, adminEmail, connected: Boolean(socket?.user), botNumber: socket?.user?.id?.split(':')[0] || null, users: data.users || [] });
      }
      if (req.method === 'POST' && url.pathname === '/admin/api/users') {
        const input = await body(req); const number = normalizeNumber(input.number);
        if (number.length < 8 || number.length > 15) return json(res, 400, { error: 'Enter a valid international number.' });
        data.users ||= [];
        if (!data.users.some(user => user.number === number)) data.users.push({ number, label: String(input.label || 'Approved user').slice(0, 80), enabled: true, addedAt: new Date().toISOString() });
        writeWhitelist(data); return json(res, 201, { ok: true, users: data.users });
      }
      const match = url.pathname.match(/^\/admin\/api\/users\/([^/]+)$/);
      if (match && req.method === 'PATCH') {
        const number = normalizeNumber(decodeURIComponent(match[1])); const input = await body(req);
        const user = (data.users || []).find(item => item.number === number);
        if (!user) return json(res, 404, { error: 'User not found.' });
        if (typeof input.enabled === 'boolean') user.enabled = input.enabled;
        writeWhitelist(data); return json(res, 200, { ok: true, user });
      }
      if (match && req.method === 'DELETE') {
        data.users = (data.users || []).filter(item => item.number !== normalizeNumber(decodeURIComponent(match[1])));
        writeWhitelist(data); return json(res, 200, { ok: true, users: data.users });
      }
      if (req.method === 'POST' && url.pathname === '/admin/api/pair') {
        const input = await body(req); const number = normalizeNumber(input.number);
        const approved = (data.users || []).some(user => user.number === number && user.enabled);
        if (!approved) return json(res, 403, { error: 'Approve and enable this number before requesting a pairing code.' });
        const socket = getSocket();
        if (!socket?.requestPairingCode) return json(res, 503, { error: 'WhatsApp socket is not ready.' });
        const code = await socket.requestPairingCode(number);
        return json(res, 200, { ok: true, code, expiresInSeconds: 60 });
      }
      return json(res, 404, { error: 'Unknown admin endpoint' });
    } catch (error) { return json(res, 500, { error: error.message || 'Server error' }); }
  });
  server.listen(port, () => console.log(`[ADMIN] Dashboard available at http://localhost:${port}/admin`));
  return server;
}
module.exports = { startAdminServer };
