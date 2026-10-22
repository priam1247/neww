# ZaFar Portal (Light Theme · Separate Admin & Member Pages)

Production **Next.js 16 (App Router) + TypeScript + Tailwind CSS** web portal for **ZaFar Bot**, featuring real email sign-in, 6-digit email verification, **Cloudflare D1** persistence, and separate role-based pages for the Administrator and Members.

## Pages & Roles

- **`/login`** — Email Sign-In, Account Registration, 6-Digit Email Code Verification, and Password Reset. Automatically routes Admins to `/admin` and Members to `/dashboard`.
- **`/admin` (`troykunsauka@gmail.com`)** — Exclusive Administrator Console:
  - Allow or disallow any member account by email (automatically enabling or disabling their linked WhatsApp numbers).
  - Toggle global member access (`Active` / `Paused`).
  - Save and test your live WhatsApp Bot Server URL (`admin-server.js`) + `ADMIN_DASHBOARD_TOKEN` server-side in Cloudflare D1 so members never see server URLs or tokens.
  - Manage all WhatsApp numbers across all members.
- **`/dashboard` (Members)** — Clean self-service Member Workspace:
  - Allow personal WhatsApp numbers to use ZaFar Bot.
  - Generate 60-second WhatsApp linking codes with one click.
  - Browse bot commands and the 10,924-paper MZUNI archive.
