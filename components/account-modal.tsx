'use client';

import { useEffect, useState } from 'react';
import { BookOpen, CheckCircle2, LogOut, Mail, ShieldCheck, X } from 'lucide-react';
import { AuthUser, UserQuota } from '@/lib/types';

interface AccountModalProps {
  open: boolean;
  onClose: () => void;
  user: AuthUser;
  quota: UserQuota | null;
  onUpdateName: (name: string) => Promise<void>;
  onSignOut: () => Promise<void>;
}

export function AccountModal({
  open,
  onClose,
  user,
  quota,
  onUpdateName,
  onSignOut,
}: AccountModalProps) {
  const [name, setName] = useState(user.name);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setName(user.name);
  }, [open, user.name]);

  if (!open) return null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onUpdateName(name.trim());
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
      aria-labelledby="account-modal-title"
    >
      <div className="w-full max-w-md rounded-2xl border border-line-strong bg-obsidian-800 p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-mint/40 bg-mint-dim font-mono text-sm font-bold uppercase text-mint">
              {(user.name || user.email).slice(0, 2)}
            </div>
            <div>
              <h2 id="account-modal-title" className="text-base font-semibold text-[#f4f7fb]">
                {user.name}
              </h2>
              <div className="mt-0.5 flex items-center gap-1.5 text-xs text-[#9fb0c5]">
                <Mail className="h-3 w-3 text-mint" />
                <span>{user.email}</span>
              </div>
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

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-mint-dim px-2.5 py-0.5 text-[11px] font-semibold text-mint">
            <CheckCircle2 className="h-3 w-3" />
            Verified Email
          </span>
          {user.isAdmin && (
            <span className="inline-flex items-center gap-1 rounded-full border border-mint/30 bg-obsidian-900 px-2.5 py-0.5 text-[11px] font-semibold text-[#f4f7fb]">
              <ShieldCheck className="h-3 w-3 text-mint" />
              Administrator
            </span>
          )}
        </div>

        {quota && (
          <div className="mt-4 rounded-xl border border-line bg-obsidian-900/90 p-3.5">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-[#f4f7fb]">
              <BookOpen className="h-3.5 w-3.5 text-mint" />
              Daily ZaFar Library Quota
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-lg border border-line bg-obsidian-800 p-2.5">
                <div className="text-[#8d98aa]">Past Papers Left</div>
                <div className="mt-0.5 font-mono text-base font-bold text-mint tabular-nums">
                  {quota.papers_left} / {quota.papers_limit}
                </div>
              </div>
              <div className="rounded-lg border border-line bg-obsidian-800 p-2.5">
                <div className="text-[#8d98aa]">Books Left</div>
                <div className="mt-0.5 font-mono text-base font-bold text-mint tabular-nums">
                  {quota.books_left} / {quota.books_limit}
                </div>
              </div>
            </div>
          </div>
        )}

        <form onSubmit={handleSave} className="mt-4 space-y-3">
          <div>
            <label
              htmlFor="account-display-name"
              className="mb-1 block text-xs font-medium text-[#8d98aa]"
            >
              Display name
            </label>
            <input
              id="account-display-name"
              type="text"
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-xl border border-line bg-obsidian-900 px-3.5 py-2 text-sm text-[#f4f7fb] focus:border-mint focus:outline-none"
            />
          </div>

          <div className="flex items-center justify-between gap-2 pt-2">
            <button
              type="button"
              onClick={onSignOut}
              className="inline-flex items-center gap-1.5 rounded-xl bg-coral-dim px-3.5 py-2 text-xs font-semibold text-[#ffb4b9] transition hover:brightness-110"
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign out
            </button>

            <button
              type="submit"
              disabled={saving}
              className="rounded-xl bg-mint px-4 py-2 text-xs font-bold text-[#071510] transition hover:brightness-110 disabled:opacity-60"
            >
              {saving ? 'Saving…' : 'Save Profile'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
