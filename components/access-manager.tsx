'use client';

import { useMemo, useState } from 'react';
import {
  Link2,
  Plus,
  Search,
  ShieldBan,
  ShieldCheck,
  Trash2,
  UserCheck,
} from 'lucide-react';
import { ApprovedUser, PairCodePayload } from '@/lib/types';
import { PairingCodeBanner } from './pairing-code-banner';

type FilterMode = 'all' | 'enabled' | 'revoked';

interface AccessManagerProps {
  users: ApprovedUser[];
  busyNumber: string | null;
  activePair: PairCodePayload | null;
  onDismissPair: () => void;
  onAddUser: (number: string, label: string) => Promise<boolean>;
  onToggleUser: (number: string, enabled: boolean) => Promise<void>;
  onRemoveUser: (number: string) => Promise<void>;
  onPairUser: (number: string) => Promise<void>;
}

function formatAddedAt(iso?: string): string {
  if (!iso) return 'Approved operator';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'Approved operator';
    return `Added ${d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })}`;
  } catch {
    return 'Approved operator';
  }
}

export function AccessManager({
  users,
  busyNumber,
  activePair,
  onDismissPair,
  onAddUser,
  onToggleUser,
  onRemoveUser,
  onPairUser,
}: AccessManagerProps) {
  const [number, setNumber] = useState('');
  const [label, setLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterMode>('all');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter((u) => {
      const enabled = u.enabled !== false;
      if (filter === 'enabled' && !enabled) return false;
      if (filter === 'revoked' && enabled) return false;
      if (!q) return true;
      return (
        u.number.toLowerCase().includes(q) ||
        (u.label || '').toLowerCase().includes(q)
      );
    });
  }, [users, search, filter]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!number.trim()) return;
    setSubmitting(true);
    try {
      const ok = await onAddUser(number, label);
      if (ok) {
        setNumber('');
        setLabel('');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="rounded-2xl border border-line bg-obsidian-800/95 p-5 shadow-[0_18px_60px_rgba(0,0,0,0.3)] sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-[#f4f7fb]">
            <UserCheck className="h-5 w-5 text-mint" />
            Approved Access
          </h2>
          <p className="mt-0.5 text-xs text-[#8d98aa]">
            Only enabled international numbers can execute commands or request a short-lived linking code.
          </p>
        </div>

        <div className="flex items-center gap-1 rounded-xl border border-line bg-obsidian-900 p-1 text-[11px]">
          {(['all', 'enabled', 'revoked'] as FilterMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setFilter(mode)}
              className={`rounded-lg px-2.5 py-1 font-medium capitalize transition ${
                filter === mode
                  ? 'bg-obsidian-700 text-[#f4f7fb]'
                  : 'text-[#8d98aa] hover:text-[#f4f7fb]'
              }`}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      <form
        onSubmit={handleSubmit}
        className="mt-5 grid grid-cols-1 gap-2.5 sm:grid-cols-[1.15fr_0.95fr_auto] sm:items-end"
      >
        <div>
          <label
            htmlFor="waNumberInput"
            className="mb-1.5 block text-xs font-medium text-[#8d98aa]"
          >
            International WhatsApp number
          </label>
          <input
            id="waNumberInput"
            type="text"
            inputMode="numeric"
            required
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            placeholder="265991234567"
            className="w-full rounded-xl border border-line bg-[#0b0e14] px-3.5 py-2.5 font-mono text-sm text-[#f4f7fb] placeholder:text-[#556072] focus:border-mint focus:outline-none tabular-nums"
          />
        </div>

        <div>
          <label
            htmlFor="waLabelInput"
            className="mb-1.5 block text-xs font-medium text-[#8d98aa]"
          >
            Operator / label
          </label>
          <input
            id="waLabelInput"
            type="text"
            maxLength={80}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Team member or student rep"
            className="w-full rounded-xl border border-line bg-[#0b0e14] px-3.5 py-2.5 text-sm text-[#f4f7fb] placeholder:text-[#556072] focus:border-mint focus:outline-none"
          />
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="inline-flex h-[42px] items-center justify-center gap-1.5 rounded-xl bg-mint px-4 text-sm font-bold text-[#071510] transition hover:brightness-110 disabled:opacity-60"
        >
          <Plus className="h-4 w-4 stroke-[2.5]" />
          {submitting ? 'Adding…' : 'Add user'}
        </button>
      </form>

      <div className="mt-4">
        <PairingCodeBanner activePair={activePair} onDismiss={onDismissPair} />
      </div>

      {users.length > 2 && (
        <div className="relative mt-4">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#6e7a8c]" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by phone number or label…"
            className="w-full rounded-xl border border-line bg-obsidian-900/80 py-2 pl-9 pr-3.5 text-xs text-[#f4f7fb] placeholder:text-[#606b7d] focus:border-line-strong focus:outline-none"
          />
        </div>
      )}

      <div className="mt-4 divide-y divide-line">
        {filteredUsers.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-sm font-medium text-[#c5cfdf]">
              {users.length === 0
                ? 'No approved numbers yet.'
                : 'No users match the active filter.'}
            </p>
            <p className="mt-1 text-xs text-[#8d98aa]">
              {users.length === 0
                ? 'Add your first international WhatsApp number above to grant access.'
                : 'Clear the search box or switch the filter tab.'}
            </p>
          </div>
        ) : (
          filteredUsers.map((user) => {
            const isEnabled = user.enabled !== false;
            const isBusy = busyNumber === user.number;
            const isConfirming = confirmDelete === user.number;

            return (
              <div
                key={user.number}
                className="flex flex-wrap items-center justify-between gap-3 py-3.5 first:pt-2"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold text-[#f4f7fb] tabular-nums">
                      +{user.number}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
                        isEnabled
                          ? 'bg-mint-dim text-mint'
                          : 'bg-[#352026] text-[#ffadb1]'
                      }`}
                    >
                      {isEnabled ? (
                        <ShieldCheck className="h-3 w-3" />
                      ) : (
                        <ShieldBan className="h-3 w-3" />
                      )}
                      {isEnabled ? 'enabled' : 'revoked'}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-[#8d98aa]">
                    <span>{user.label || 'Approved user'}</span>
                    <span>·</span>
                    <span>{formatAddedAt(user.addedAt)}</span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={!isEnabled || isBusy}
                    onClick={() => onPairUser(user.number)}
                    title={
                      isEnabled
                        ? 'Request 60s WhatsApp linking code'
                        : 'Enable user first to request a linking code'
                    }
                    className="inline-flex items-center gap-1.5 rounded-xl bg-[#202936] px-3 py-2 text-xs font-semibold text-[#f4f7fb] transition hover:bg-[#2a3546] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Link2 className="h-3.5 w-3.5 text-mint" />
                    Link
                  </button>

                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => onToggleUser(user.number, !isEnabled)}
                    className={`rounded-xl px-3 py-2 text-xs font-semibold transition disabled:opacity-50 ${
                      isEnabled
                        ? 'bg-coral-dim text-[#ffb4b9] hover:brightness-110'
                        : 'bg-[#202936] text-[#f4f7fb] hover:bg-[#2a3546]'
                    }`}
                  >
                    {isEnabled ? 'Revoke' : 'Enable'}
                  </button>

                  {isConfirming ? (
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={async () => {
                          await onRemoveUser(user.number);
                          setConfirmDelete(null);
                        }}
                        className="rounded-xl bg-coral px-3 py-2 text-xs font-bold text-[#1a080b] transition hover:brightness-110"
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(null)}
                        className="rounded-xl bg-obsidian-700 px-2.5 py-2 text-xs font-medium text-[#c5cfdf]"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => setConfirmDelete(user.number)}
                      aria-label={`Remove ${user.number}`}
                      className="inline-flex items-center gap-1 rounded-xl bg-coral-dim/80 px-2.5 py-2 text-xs font-semibold text-[#ffb4b9] transition hover:bg-coral-dim disabled:opacity-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Remove
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
