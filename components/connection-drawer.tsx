'use client';

import { useEffect, useState } from 'react';
import { Eye, EyeOff, PlugZap, Server, ShieldAlert, X } from 'lucide-react';
import { ConnectionMode } from '@/lib/types';

export interface ConnectionSettings {
  botApiUrl: string;
  token: string;
  useSandbox: boolean;
}

interface ConnectionDrawerProps {
  open: boolean;
  onClose: () => void;
  settings: ConnectionSettings;
  defaultBotApiConfigured: boolean;
  currentMode: ConnectionMode;
  onSave: (next: ConnectionSettings) => Promise<void>;
}

export function ConnectionDrawer({
  open,
  onClose,
  settings,
  defaultBotApiConfigured,
  currentMode,
  onSave,
}: ConnectionDrawerProps) {
  const [botApiUrl, setBotApiUrl] = useState(settings.botApiUrl);
  const [token, setToken] = useState(settings.token);
  const [useSandbox, setUseSandbox] = useState(settings.useSandbox);
  const [showToken, setShowToken] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setBotApiUrl(settings.botApiUrl);
      setToken(settings.token);
      setUseSandbox(settings.useSandbox);
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
        useSandbox,
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
                Bot Server & Token Connection
              </h2>
              <p className="text-xs text-[#8d98aa]">
                Connect this Vercel frontend to your running ZaFar Bot{' '}
                <code className="font-mono text-[#c8d2e3]">admin-server.js</code>
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
          <div className="flex items-center justify-between rounded-xl border border-line bg-obsidian-850 px-3.5 py-3">
            <div>
              <div className="text-xs font-medium text-[#f4f7fb]">
                Interactive Sandbox Mode
              </div>
              <div className="text-[11px] text-[#8d98aa]">
                Test approving numbers & pairing codes before linking a live VPS
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={useSandbox}
              onClick={() => setUseSandbox((v) => !v)}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border transition-colors ${
                useSandbox
                  ? 'border-mint/50 bg-mint-dim'
                  : 'border-line bg-obsidian-900'
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 translate-y-0.5 rounded-full transition-transform ${
                  useSandbox ? 'translate-x-5 bg-mint' : 'translate-x-1 bg-[#8d98aa]'
                }`}
              />
            </button>
          </div>

          <div className={useSandbox ? 'opacity-50 pointer-events-none' : ''}>
            <label
              htmlFor="botApiUrlInput"
              className="mb-1.5 flex items-center justify-between text-xs font-medium text-[#8d98aa]"
            >
              <span className="flex items-center gap-1.5">
                <Server className="h-3.5 w-3.5 text-mint" />
                Bot Server URL
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
              Proxied server-side via Next.js <code className="font-mono">/api/admin/*</code> —
              works with plain <code className="font-mono">http://ip:port</code> panels without CORS errors.
            </p>
          </div>

          <div className={useSandbox ? 'opacity-50 pointer-events-none' : ''}>
            <label
              htmlFor="adminTokenInput"
              className="mb-1.5 block text-xs font-medium text-[#8d98aa]"
            >
              Admin Dashboard Token (<code className="font-mono">ADMIN_DASHBOARD_TOKEN</code>)
            </label>
            <div className="relative">
              <input
                id="adminTokenInput"
                type={showToken ? 'text' : 'password'}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Paste your shared bearer token"
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
              Current mode:{' '}
              <strong className="text-[#f4f7fb]">
                {currentMode === 'live' ? 'Live Bot Proxy' : 'Sandbox Preview'}
              </strong>
              . Session credentials stay in your browser storage and are verified with{' '}
              <code className="font-mono">crypto.timingSafeEqual</code>.
            </span>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => {
                setBotApiUrl('');
                setToken('');
                setUseSandbox(!defaultBotApiConfigured);
              }}
              className="rounded-xl bg-obsidian-700 px-3.5 py-2 text-xs font-semibold text-[#d8e0ee] transition hover:bg-obsidian-750"
            >
              Reset
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-xl bg-mint px-4 py-2 text-xs font-bold text-[#071510] transition hover:brightness-110 disabled:opacity-60"
            >
              {saving ? 'Applying…' : 'Save & Sync'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
