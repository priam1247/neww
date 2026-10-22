/**
 * ZaFar Bot — admin-server.js
 *
 * The HTTP surface the web portal talks to. The portal (Cloudflare Pages app,
 * `lib/bot-proxy.ts`) stores a **Bot Server URL** + **ADMIN_DASHBOARD_TOKEN**
 * and then calls, with `Authorization: Bearer <token>`:
 *
 *   GET    /admin/api/status          → { connected, botNumber }
 *   GET    /admin/api/users           → { ok, users: [...] }
 *   POST   /admin/api/users           { number, label }
 *   PATCH  /admin/api/users/:number   { enabled }
 *   DELETE /admin/api/users/:number
 *   POST   /admin/api/pair            { number } → { code, expiresInSeconds }
 *
 * Inside the bot this file is not needed: index.js starts the same server
 * through `utils/adminApi` with live pairing/status hooks. Running it directly
 * is handy to check that the panel port, token and firewall are right:
 *
 *   ADMIN_DASHBOARD_TOKEN=your-token ADMIN_API_PORT=3000 node admin-server.js
 *   curl -H "Authorization: Bearer your-token" http://127.0.0.1:3000/admin/api/status
 */

const config = require('./config');
const { startAdminApi } = require('./utils/adminApi');
const { readWL } = require('./utils/accessControl');

function start(options = {}) {
  const admin = config.admin || {};
  return startAdminApi({
    port: options.port || admin.port,
    token: options.token || admin.token,
    hooks: options.hooks || {
      status: async () => ({
        connected: false,
        botNumber: null,
        botName: config.botName,
        // standalone: no WhatsApp socket is attached, only the API is up
        standalone: true,
        members: readWL().users.filter((u) => u.enabled !== false).length,
      }),
      requestPair: async () => {
        throw Object.assign(
          new Error('Pairing needs the bot process — run `node index.js`, not admin-server.js.'),
          { statusCode: 503 },
        );
      },
    },
  });
}

if (require.main === module) {
  const admin = config.admin || {};
  if (!admin.token) {
    console.error('ADMIN_DASHBOARD_TOKEN is not set — nothing to authenticate with.');
    process.exit(1);
  }
  const api = start();
  if (!api) process.exit(1);
  console.log(`admin-server listening on port ${admin.port} — Ctrl+C to stop`);
}

module.exports = { start, ...require('./utils/adminApi') };
