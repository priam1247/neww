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

The portal is completely standalone: `dashboard/package.json` +
`dashboard/package-lock.json` are its only dependencies, `next.config.mjs` only
sets the image/headers policy, and nothing outside `dashboard/` is imported. A
clean `cd dashboard && npm ci && npm run build` succeeds without the bot's
`node_modules` (verified: 21 routes).

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

The portal never talks to WhatsApp directly — every screen is served by the
bot's `/admin/api/*` (`utils/adminApi.js`, started from `index.js`).

1. **On the panel** (bot side): set two startup variables and restart.
   * `ADMIN_DASHBOARD_TOKEN` — a long random string (this is the shared secret).
   * `ADMIN_API_PORT` — the **Allocated Port** from the panel's *Network* tab.
     The API listens on `0.0.0.0`, so the node IP can reach it.
   The console prints `🌐 Dashboard API: on (port …)` once it is up.
2. **Check it from outside**: `curl http://<node-ip>:<port>/admin/api/status -H
   "Authorization: Bearer <token>"` must answer `{"connected":…}`.
   *No answer?* The panel firewall/NAT is blocking the port, or the port was
   not allocated. Open it, or put a Cloudflare Tunnel in front of
   `http://127.0.0.1:<port>` and use the tunnel's `https://` URL.
3. **In the portal**: `/admin` → **Bot Connection** → Bot Server URL
   `http://<node-ip>:<port>` (or the tunnel URL) + the same token →
   **Test connection**. These are stored in D1, not in Vercel env vars.
4. If the bot cannot be reached inbound at all, set `DASHBOARD_URL` on the bot
   instead: it pulls `/api/bot/whitelist` every few minutes, so member
   Allow/Disallow still applies. Only live status and pairing need the port.

Why server-side: the browser calls this Next.js app (`/api/admin/*`), which
proxies to the bot (`lib/bot-proxy.ts`). The bot token never reaches the
browser, and no CORS setup is needed on the panel.

## Local development

```bash
cd dashboard
npm install
npm run dev      # http://localhost:3000
npm run build    # what Vercel runs
npm run typecheck
```
