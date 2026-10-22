'use client';

import { useState } from 'react';
import { ArrowRight, Check, Copy, Database, Mail, Server } from 'lucide-react';

const VERCEL_ENV_SNIPPET = `# Unified Koyeb Auth & Email Service (already wired by default)
ZAFAR_AUTH_API_URL=https://bloody-brigitta-ahzafar-de9b1709.koyeb.app

# Direct Gmail STARTTLS SMTP (recommended for sub-second codes to ANY email domain)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-gmail-address@gmail.com
SMTP_PASS=your-16-char-google-app-password
JWT_SECRET_KEY=your-shared-jwt-secret-key

# Shared Cloudflare D1 Database Persistence
CLOUDFLARE_ACCOUNT_ID=your-cloudflare-account-id
D1_DATABASE_ID=your-d1-database-uuid
CLOUDFLARE_API_TOKEN=your-d1-api-token

# Optional Live WhatsApp Bot Control Server
ADMIN_EMAIL=troykunsauka6@gmail.com
BOT_API_URL=http://YOUR_BOT_SERVER_IP:3000
ADMIN_DASHBOARD_TOKEN=your-bot-admin-token`;

export function SetupGuide() {
  const [copied, setCopied] = useState(false);

  const copyEnv = async () => {
    try {
      await navigator.clipboard.writeText(VERCEL_ENV_SNIPPET);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore
    }
  };

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-line bg-obsidian-800/95 p-6">
        <span className="text-xs font-bold uppercase tracking-widest text-mint">
          Production Cloud Stack
        </span>
        <h2 className="mt-1 text-xl font-bold text-[#f4f7fb]">
          Unified Email Auth, Cloudflare D1 &amp; Live Bot Bridge
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-[#8d98aa]">
          Every user signs in with a real verified email address before accessing the Control Room. No fake sample records exist anywhere in the application.
        </p>

        <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto_1fr_auto_1fr] md:items-center">
          <div className="rounded-xl border border-line bg-obsidian-900 p-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-mint">
              <Mail className="h-4 w-4" />
              1. Email Verification
            </div>
            <p className="mt-1 text-xs text-[#9fb0c5]">
              Sends real 6-digit OTP &amp; password-reset codes via Gmail STARTTLS SMTP &amp; your Koyeb{' '}
              <code className="font-mono">zafar-backend</code> service.
            </p>
          </div>

          <ArrowRight className="mx-auto hidden h-4 w-4 text-[#6d788a] md:block" />

          <div className="rounded-xl border border-line bg-obsidian-900 p-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-mint">
              <Database className="h-4 w-4" />
              2. Cloudflare D1 SQL
            </div>
            <p className="mt-1 text-xs text-[#9fb0c5]">
              Persists verified accounts, HS256 JWT sessions, and approved WhatsApp numbers across all serverless instances.
            </p>
          </div>

          <ArrowRight className="mx-auto hidden h-4 w-4 text-[#6d788a] md:block" />

          <div className="rounded-xl border border-line bg-obsidian-900 p-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-mint">
              <Server className="h-4 w-4" />
              3. WhatsApp Bot Host
            </div>
            <p className="mt-1 text-xs text-[#9fb0c5]">
              Proxies authenticated requests server-side to <code className="font-mono">admin-server.js</code> for live pairing codes.
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-line bg-obsidian-800/95 p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-base font-semibold text-[#f4f7fb]">
              Vercel Environment Variables Template
            </h3>
            <p className="mt-0.5 text-xs text-[#8d98aa]">
              Paste your real values in <strong>Vercel → Project Settings → Environment Variables</strong> (never commit secrets to Git)
            </p>
          </div>
          <button
            type="button"
            onClick={copyEnv}
            className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-obsidian-900 px-3 py-1.5 text-xs font-semibold text-[#e2e9f5] hover:border-mint/50 hover:text-mint"
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5 text-mint" />
                Copied
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                Copy Template
              </>
            )}
          </button>
        </div>
        <pre className="mt-4 overflow-x-auto rounded-xl border border-line-subtle bg-obsidian-950 p-4 font-mono text-xs leading-relaxed text-[#d6e0f0]">
          {VERCEL_ENV_SNIPPET}
        </pre>
      </section>
    </div>
  );
}
