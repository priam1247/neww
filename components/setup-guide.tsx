'use client';

import { useState } from 'react';
import { ArrowRight, Check, Copy, Layers, Shield, Server } from 'lucide-react';

const VERCEL_ENV_SNIPPET = `BOT_API_URL=http://YOUR_BOT_SERVER_IP:3000
ADMIN_DASHBOARD_TOKEN=replace-with-a-strong-shared-secret
NEXT_PUBLIC_ADMIN_EMAIL=troykunsauka6@gmail.com`;

const BOT_ENV_SNIPPET = `ADMIN_PORT=3000
ADMIN_DASHBOARD_TOKEN=replace-with-a-strong-shared-secret`;

export function SetupGuide() {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const copyBlock = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1800);
    } catch {
      // ignore
    }
  };

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-line bg-obsidian-800/95 p-6">
        <span className="text-xs font-bold uppercase tracking-widest text-mint">
          Clean Split Architecture
        </span>
        <h2 className="mt-1 text-xl font-bold text-[#f4f7fb]">
          How Vercel & Your Bot Server Connect
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-[#8d98aa]">
          This branch contains strictly the Next.js frontend and server-side proxy routes so Vercel builds cleanly in seconds without native bot binaries.
        </p>

        <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto_1fr_auto_1fr] md:items-center">
          <div className="rounded-xl border border-line bg-obsidian-900 p-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-mint">
              <Layers className="h-4 w-4" />
              1. Browser UI (HTTPS)
            </div>
            <p className="mt-1 text-xs text-[#9fb0c5]">
              Hosted on Vercel (<code className="font-mono">*.vercel.app</code>). Calls relative{' '}
              <code className="font-mono">/api/admin/*</code> routes.
            </p>
          </div>

          <ArrowRight className="mx-auto hidden h-4 w-4 text-[#6d788a] md:block" />

          <div className="rounded-xl border border-line bg-obsidian-900 p-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-mint">
              <Shield className="h-4 w-4" />
              2. Next.js Server Proxy
            </div>
            <p className="mt-1 text-xs text-[#9fb0c5]">
              Verifies <code className="font-mono">ADMIN_DASHBOARD_TOKEN</code> via{' '}
              <code className="font-mono">timingSafeEqual</code> & avoids CORS/Mixed-Content.
            </p>
          </div>

          <ArrowRight className="mx-auto hidden h-4 w-4 text-[#6d788a] md:block" />

          <div className="rounded-xl border border-line bg-obsidian-900 p-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-mint">
              <Server className="h-4 w-4" />
              3. ZaFar Bot Host
            </div>
            <p className="mt-1 text-xs text-[#9fb0c5]">
              Runs on your bot branch (<code className="font-mono">admin-server.js</code>) managing live Baileys sockets.
            </p>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <section className="rounded-2xl border border-line bg-obsidian-800/95 p-6">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-base font-semibold text-[#f4f7fb]">
                Step 1 · Vercel Environment Variables
              </h3>
              <p className="mt-0.5 text-xs text-[#8d98aa]">
                Vercel Project → Settings → Environment Variables
              </p>
            </div>
            <button
              type="button"
              onClick={() => copyBlock('vercel', VERCEL_ENV_SNIPPET)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-obsidian-900 px-3 py-1.5 text-xs font-semibold text-[#e2e9f5] hover:border-mint/50 hover:text-mint"
            >
              {copiedId === 'vercel' ? (
                <>
                  <Check className="h-3.5 w-3.5 text-mint" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  Copy
                </>
              )}
            </button>
          </div>
          <pre className="mt-4 overflow-x-auto rounded-xl border border-line-subtle bg-obsidian-950 p-4 font-mono text-xs leading-relaxed text-[#d6e0f0]">
            {VERCEL_ENV_SNIPPET}
          </pre>
        </section>

        <section className="rounded-2xl border border-line bg-obsidian-800/95 p-6">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-base font-semibold text-[#f4f7fb]">
                Step 2 · Bot Host <code className="font-mono">.env</code>
              </h3>
              <p className="mt-0.5 text-xs text-[#8d98aa]">
                Use the exact same token on your VPS / panel running ZaFar Bot
              </p>
            </div>
            <button
              type="button"
              onClick={() => copyBlock('bot', BOT_ENV_SNIPPET)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-obsidian-900 px-3 py-1.5 text-xs font-semibold text-[#e2e9f5] hover:border-mint/50 hover:text-mint"
            >
              {copiedId === 'bot' ? (
                <>
                  <Check className="h-3.5 w-3.5 text-mint" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  Copy
                </>
              )}
            </button>
          </div>
          <pre className="mt-4 overflow-x-auto rounded-xl border border-line-subtle bg-obsidian-950 p-4 font-mono text-xs leading-relaxed text-[#d6e0f0]">
            {BOT_ENV_SNIPPET}
          </pre>
        </section>
      </div>
    </div>
  );
}
