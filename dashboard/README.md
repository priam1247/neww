# ZaFar Control Room (web portal)

Next.js 16 app for sign-in, member self-service and the admin console. It talks
to the bot over HTTP (see `lib/bot-proxy.ts` and the bot's `admin-server.js`).

## Deploying on Vercel

The bot lives at the repository root and must stay there — the panel runs
`node index.js` from the root. This portal is a **separate project root**, so:

1. Vercel → your project → **Settings → General → Root Directory** → set it to
   `dashboard`, then **Save**.
2. **Build & Output Settings** stay on the framework preset *Next.js*
   (install `npm install`, build `npm run build`).
3. Redeploy. The log now shows `Cloning …` followed by a Next.js build; the
   `[NEXT_NO_VERSION]` error is gone because `dashboard/package.json` has
   `next` in its dependencies.

Without step 1 Vercel reads the repository's root `package.json`, which is the
WhatsApp bot (no Next.js), and the build fails with `NEXT_NO_VERSION`.

Different portal on the same repo? Nothing else is required — the bot's
dependencies and the portal's are separate (`dashboard/package-lock.json`), and
neither deploy touches the other's files.

## Environment variables (Vercel → Settings → Environment Variables)

| Key | What it is |
|---|---|
| `JWT_SECRET_KEY` | signs session cookies — long random string |
| `ADMIN_EMAIL` | administrator account (`troykunsauka@gmail.com`) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | verification + reset mail |
| `CLOUDFLARE_ACCOUNT_ID` / `D1_DATABASE_ID` / `CLOUDFLARE_API_TOKEN` | Cloudflare D1 storage |
| `ZAFAR_AUTH_API_URL` | shared auth backend base URL |

`BOT_API_URL` and `ADMIN_DASHBOARD_TOKEN` are optional here: the admin console
saves them into D1 at runtime, so nobody needs to see them in Vercel.

## Linking the bot

1. Bot host: set `ADMIN_DASHBOARD_TOKEN` (same value you paste here) and
   `ADMIN_API_PORT` (a port allocated in the panel), then restart — the console
   prints `🌐 Dashboard API: on (port …)`.
2. Portal → `/admin` → **Bot Connection** → Bot Server URL
   `http://<node-ip>:<port>`, same token → **Test connection**.
3. If the bot is not reachable inbound (NAT), set `DASHBOARD_URL` on the bot
   instead: it pulls `/api/bot/whitelist` every few minutes, so member
   Allow/Disallow still applies; only live status and pairing need the port.

## Local development

```bash
cd dashboard
npm install
npm run dev      # http://localhost:3000
npm run build    # what Vercel runs
npm run typecheck
```
