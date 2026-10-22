# ZaFar Control Room (Web Frontend)

Standalone **Next.js (App Router) + TypeScript + Tailwind CSS** web frontend for **ZaFar Bot**, isolated on its own branch so it deploys directly on **Vercel** with zero configuration.

## Features

- **Approved Access Control Room** — View live connection state, approve international WhatsApp numbers (`8–15` digits), revoke/re-enable access, and remove users.
- **Short-Lived Linking Codes** — Issue 60-second WhatsApp pairing codes with a live expiry countdown and one-click copy.
- **Server-Side Bot Proxy (`/api/admin/*`)** — Proxies requests from Vercel's HTTPS edge/runtime directly to your bot host's `admin-server.js` (`http://<ip>:<port>/admin/api/...`), avoiding browser CORS and Mixed-Content errors while keeping `ADMIN_DASHBOARD_TOKEN` timing-safe verified.
- **Interactive Sandbox Mode** — Works immediately out of the box on Vercel previews and local development even before `BOT_API_URL` is linked.
- **Command Directory & Vault Desk** — Searchable reference for all 21 ZaFar Bot commands, the 10,924-paper Mzuzu University vault index, and the 6 primary public metadata catalogs.

## Deploying on Vercel

1. Import this repository into **Vercel** and select branch **`arena/f0030ea7-neww`**.
2. Leave **Framework Preset** as **Next.js** and **Root Directory** as `./` (no custom build settings needed).
3. Add Environment Variables in Vercel Project Settings:
   - `BOT_API_URL` — Public URL of your running bot admin server (e.g. `http://203.0.113.10:3000`)
   - `ADMIN_DASHBOARD_TOKEN` — Strong shared secret matching `ADMIN_DASHBOARD_TOKEN` in your bot `.env`
   - `NEXT_PUBLIC_ADMIN_EMAIL` *(optional)* — Operator badge email shown in the header
4. Click **Deploy**. You can also enter or override `BOT_API_URL` and `ADMIN_DASHBOARD_TOKEN` live at runtime from the **Connection** drawer in the top navigation bar.

## Local Development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.
