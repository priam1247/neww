# ZaFar Control Room

Production **Next.js 16 (App Router) + TypeScript + Tailwind CSS** web frontend for **ZaFar**, integrated with real email verification, **Cloudflare D1** persistence, and your **Koyeb `zafar-backend`** service.

## Architecture

- **Real Email Authentication (`/api/auth/*`)**
  - Requires email registration, 6-digit OTP inbox verification, sign-in, password reset via 6-digit email code, HS256 JWT sessions (`HttpOnly` cookie + Bearer header), and profile updates.
  - Bridges directly to your live Koyeb service (`ZAFAR_AUTH_API_URL`) out of the box **and** supports direct STARTTLS email delivery via **Nodemailer (`smtp.gmail.com:587`)** when `SMTP_USER` and `SMTP_PASS` are configured in Vercel Environment Variables.
- **Zero Sample / Mock Data**
  - All fake/sample phone numbers and sandbox badges are completely removed.
  - Approved WhatsApp numbers persist in **Cloudflare D1** (`portal_whatsapp_access`) when D1 credentials are configured, and proxy live to `${BOT_API_URL}/admin/api/*` when connected to a running `admin-server.js` instance.

## Vercel Environment Variables

Add your secrets in **Vercel → Project Settings → Environment Variables** (never commit credentials into Git):

- `ZAFAR_AUTH_API_URL` — Public URL of your Koyeb `zafar-backend` service
- `SMTP_HOST` — `smtp.gmail.com`
- `SMTP_PORT` — `587`
- `SMTP_USER` — Gmail address sending verification codes
- `SMTP_PASS` — 16-character Google App Password
- `JWT_SECRET_KEY` — Shared 64-hex HS256 secret key
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare Account ID for D1
- `D1_DATABASE_ID` — Cloudflare D1 Database UUID
- `CLOUDFLARE_API_TOKEN` — Cloudflare D1 Read/Write API Token
- `ADMIN_EMAIL` — Primary administrator email
- `BOT_API_URL` *(optional)* — Running WhatsApp bot `admin-server.js` URL
- `ADMIN_DASHBOARD_TOKEN` *(optional)* — Shared token for `admin-server.js`

## Local Development

```bash
npm install
npm run dev
```
