'use client';

import { useEffect, useState } from 'react';
import { Eye, EyeOff, PlugZap, Server, ShieldAlert, X } from 'lucide-react';

export interface ConnectionSettings {
  botApiUrl: string;
  token: string;
}

interface ConnectionDrawerProps {
  open: boolean;
  onClose: () => void;
  settings: ConnectionSettings;
  defaultBotApiConfigured: boolean;
  botServerLinked: boolean;
  onSave: (next: ConnectionSettings) => Promise<void>;
}

export function ConnectionDrawer({
  open,
  onClose,
  settings,
  defaultBotApiConfigured,
  botServerLinked,
  onSave,
}: ConnectionDrawerProps) {
  const [botApiUrl, setBotApiUrl] = useState(settings.botApiUrl);
  const [token, setToken] = useState(settings.token);
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setBotApiUrl(settings.botApiUrl);
      setToken(settings.token);
    }
  }, [open, settings]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave({
        botApiUrl: botApiUrl.trim(),
        token: token.trim(),
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="conn-modal-title"
    >
      <div className="w-full max-w-lg rounded-2xl border border-line-strong bg-obsidian-800 p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-obsidian-900 text-mint">
              <PlugZap className="h-5 w-5" />
            </div>
            <div>
              <h2 id="conn-modal-title" className="text-base font-semibold text-[#f4f7fb]">
                WhatsApp Bot Server Connection
              </h2>
              <p className="text-xs text-[#8d98aa]">
                Link this portal to your live ZaFar Bot{' '}
                <code className="font-mono text-[#c8d2e3]">admin-server.js</code> endpoint
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-[#8d98aa] hover:bg-obsidian-700 hover:text-[#f4f7fb]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          <div>
            <label
              htmlFor="botApiUrlInput"
              className="mb-1.5 flex items-center justify-between text-xs font-medium text-[#8d98aa]"
            >
              <span className="flex items-center gap-1.5">
                <Server className="h-3.5 w-3.5 text-mint" />
                Live Bot Server URL
              </span>
              {defaultBotApiConfigured && (
                <span className="rounded bg-mint-dim px-1.5 py-0.5 font-mono text-[10px] text-mint">
                  BOT_API_URL set on server
                </span>
              )}
            </label>
            <input
              id="botApiUrlInput"
              type="url"
              value={botApiUrl}
              onChange={(e) => setBotApiUrl(e.target.value)}
              placeholder={
                defaultBotApiConfigured
                  ? 'Using server BOT_API_URL (optional override)'
                  : 'http://203.0.113.10:3000'
              }
              className="w-full rounded-xl border border-line bg-obsidian-900 px-3.5 py-2.5 font-mono text-xs text-[#f4f7fb] placeholder:text-[#5d6778] focus:border-mint focus:outline-none"
            />
            <p className="mt-1 text-[11px] text-[#8d98aa]">
              Proxied server-side via Next.js <code className="font-mono">/api/admin/*</code> so plain{' '}
              <code className="font-mono">http://ip:port</code> servers work cleanly from HTTPS Vercel.
            </p>
          </div>

          <div>
            <label
              htmlFor="adminTokenInput"
              className="mb-1.5 block text-xs font-medium text-[#8d98aa]"
            >
              Bot Admin Token (<code className="font-mono">ADMIN_DASHBOARD_TOKEN</code>)
            </label>
            <div className="relative">
              <input
                id="adminTokenInput"
                type={showToken ? 'text' : 'password'}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Shared bearer token from bot .env"
                className="w-full rounded-xl border border-line bg-obsidian-900 py-2.5 pl-3.5 pr-10 font-mono text-xs text-[#f4f7fb] placeholder:text-[#5d6778] focus:border-mint focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowToken((s) => !s)}
                aria-label={showToken ? 'Hide token' : 'Show token'}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-[#8d98aa] hover:text-[#f4f7fb]"
              >
                {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <div className="flex items-start gap-2.5 rounded-xl border border-line bg-obsidian-900/70 p-3 text-[11px] text-[#8d98aa]">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-mint" />
            <span>
              Status:{' '}
              <strong className="text-[#f4f7fb]">
                {botServerLinked ? 'Connected to live bot API' : 'Storing approved numbers in database'}
              </strong>
              . Leave blank to manage approved numbers directly in Cloudflare D1 until your bot host is online.
            </span>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => {
                setBotApiUrl('');
                setToken('');
              }}
              className="rounded-xl bg-obsidian-700 px-3.5 py-2 text-xs font-semibold text-[#d8e0ee] transition hover:bg-obsidian-750"
            >
              Clear Override
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-xl bg-mint px-4 py-2 text-xs font-bold text-[#071510] transition hover:brightness-110 disabled:opacity-60"
            >
              {saving ? 'Saving…' : 'Save & Connect'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
