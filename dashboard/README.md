# ZaFar Control Room (Web Portal)

Standalone Next.js 16 application for member sign-in, WhatsApp number self-service, and the administrator console (`/admin`). It talks to the live bot over `/admin/api/*` (`utils/adminApi.js`, started directly by `index.js`) through a server-side proxy (`lib/bot-proxy.ts`) so `ADMIN_DASHBOARD_TOKEN` never leaves the server.

## Deploying on Vercel (or Self-Hosted Node)

The WhatsApp bot lives at the repository root (`node --expose-gc index.js`). This portal has its own `dashboard/package.json` and `dashboard/package-lock.json`:

1. **Vercel → Project → Settings → General → Root Directory** → set to `dashboard` and click **Save**.
2. Keep the framework preset on **Next.js** (`npm install` / `npm run build`).
3. Configure the environment variables below, then **Deploy**.

Self-hosting with `npm start` enforces `JWT_SECRET_KEY` (minimum 16 characters) before `next start` binds a port, and `instrumentation.ts` + `lib/jwt.ts` enforce the same check on serverless/edge cold starts.

## Environment Variables

| Variable | Required? | Purpose |
|---|---|---|
| `JWT_SECRET_KEY` | **Required in production** | Signs HS256 session cookies (min 16 chars; generate via `openssl rand -hex 32`). Production startup refuses to run without it. |
| `ADMIN_EMAIL` | Recommended | Comma-separated administrator email(s) allowed into `/admin` (default: `troykunsauka@gmail.com`). |
| `ADMIN_INITIAL_PASSWORD` | Optional | Bootstraps the verified `ADMIN_EMAIL` account in D1 on first sign-in before email delivery is configured. |
| `CLOUDFLARE_ACCOUNT_ID` / `D1_DATABASE_ID` / `CLOUDFLARE_API_TOKEN` | Recommended | Cloudflare D1 database storing verified accounts (`bcryptjs`), member permissions, approved WhatsApp numbers, and bot link settings. Falls back to `.data/zafar-db.json` in local dev. |
| `RESEND_API_KEY` + `EMAIL_FROM` | Pick Resend **or** SMTP | Sends 6-digit verification & password-reset codes over HTTPS (works cleanly on serverless/edge hosts). |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | Pick Resend **or** SMTP | Direct SMTP mail delivery (e.g. Gmail App Password on port `587` or `465`). |
| `ZAFAR_AUTH_API_URL` | Optional (legacy migration only) | Leave empty. If set during migration from an older external auth service, existing accounts are verified once (6 s cap) and migrated permanently into local D1. |
| `BOT_API_URL` / `ADMIN_DASHBOARD_TOKEN` | Optional | Defaults if not yet saved inside `/admin` → **Bot & Numbers**. |

## Linking the Bot Securely (HTTPS Tunnel Recommended)

1. **On the bot host / panel** (`.env` or Startup Variables):
   ```ini
   ADMIN_API_PORT=3000
   ADMIN_DASHBOARD_TOKEN=<long-random-shared-secret>
   DASHBOARD_URL=https://your-portal.vercel.app
   # Optional if any browser origin ever calls the bot directly:
   ADMIN_CORS_ORIGINS=https://your-portal.vercel.app
   ```
   Restart the bot and confirm `🌐 Dashboard API: on (port …)` in the console.
2. **Expose `/admin/api` over HTTPS (Cloudflare Tunnel recommended)**:
   Plain `http://<node-ip>:<port>` works through the server-side proxy, but sends `ADMIN_DASHBOARD_TOKEN` unencrypted across the network. Whenever possible, put `cloudflared` or an HTTPS reverse proxy in front of the bot port:
   ```bash
   # Quick tunnel test:
   cloudflared tunnel --url http://127.0.0.1:3000

   # Permanent production tunnel (Cloudflare Zero Trust → Networks → Tunnels):
   # Route https://bot-api.yourdomain.com → http://127.0.0.1:3000
   ```
3. **Save inside `/admin` → Bot & Numbers**:
   Paste the `https://` tunnel URL (or `http://<node-ip>:<allocated-port>`) and the same `ADMIN_DASHBOARD_TOKEN`, then click **Test & Save Bot Link**.
   - Status probes time out in **3 seconds** and distinguish **Online**, **Awaiting Pair**, **Bot Offline**, and **Not Linked** immediately.
   - If the bot is behind strict NAT with no inbound port or tunnel, keep `DASHBOARD_URL` set on the bot: `utils/allowlistSync.js` pulls `/api/bot/whitelist` every 5 minutes so member Allow/Disallow changes still apply.

## Local Development

```bash
cd dashboard
npm ci
npm run dev        # http://localhost:3000 (dev outbox prints 6-digit codes locally)
npm run typecheck
npm run build
```
