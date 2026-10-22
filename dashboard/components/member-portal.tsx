'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Activity,
  AlertCircle,
  BookOpen,
  CheckCircle2,
  Command,
  Link2,
  Loader2,
  LogOut,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Trash2,
} from 'lucide-react';
import {
  AuthUser,
  MemberOverviewPayload,
  PairCodePayload,
  UserQuota,
} from '@/lib/types';
import {
  authHeaders,
  fetchCurrentSession,
  performSignOut,
  setSavedSessionToken,
} from '@/lib/client-session';
import { PairingCodeBanner } from './pairing-code-banner';
import { CommandDirectory } from './command-directory';
import { MediaVaultDesk } from './media-vault-desk';
import { AccountModal } from './account-modal';

type MemberTab = 'numbers' | 'commands' | 'vault';

export function MemberPortal() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [quota, setQuota] = useState<UserQuota | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);

  const [tab, setTab] = useState<MemberTab>('numbers');
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);

  const [overview, setOverview] = useState<MemberOverviewPayload>({
    ok: true,
    adminEmail: 'troykunsauka@gmail.com',
    memberAllowed: true,
    botEnabledForMembers: true,
    botServerLinked: false,
    botConnected: false,
    botNumber: null,
    numbers: [],
  });

  const [number, setNumber] = useState('');
  const [label, setLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [busyNumber, setBusyNumber] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [activePair, setActivePair] = useState<PairCodePayload | null>(null);

  const loadMemberStatus = useCallback(
    async (silent = false) => {
      if (!silent) setRefreshing(true);
      try {
        const res = await fetch('/api/member/status', {
          headers: authHeaders(),
          cache: 'no-store',
        });
        if (res.status === 401) {
          router.replace('/login');
          return;
        }
        const json = (await res.json()) as MemberOverviewPayload & {
          error?: string;
        };
        if (!res.ok) throw new Error(json.error || 'Could not load portal');
        setOverview(json);
      } catch (err) {
        setNotice({
          text: err instanceof Error ? err.message : 'Unable to refresh portal',
          bad: true,
        });
      } finally {
        setRefreshing(false);
      }
    },
    [router],
  );

  useEffect(() => {
    (async () => {
      const session = await fetchCurrentSession();
      if (!session) {
        router.replace('/login');
        return;
      }
      setUser(session.user);
      setQuota(session.quota);
      await loadMemberStatus(true);
      setChecking(false);
    })();
  }, [router, loadMemberStatus]);

  useEffect(() => {
    if (!user) return;
    const id = setInterval(() => {
      void loadMemberStatus(true);
    }, 15_000);
    return () => clearInterval(id);
  }, [user, loadMemberStatus]);

  const handleAllowNumber = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!number.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/member/numbers', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ number, label }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Could not add number');
      setOverview((prev) => ({ ...prev, numbers: json.numbers || [] }));
      setNumber('');
      setLabel('');
      setNotice({
        text: `Your WhatsApp number +${number.replace(/\D/g, '')} is now allowed to use ZaFar Bot.`,
      });
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Failed to allow number',
        bad: true,
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleOwnNumber = async (num: string, enabled: boolean) => {
    setBusyNumber(num);
    try {
      const res = await fetch(`/api/member/numbers/${encodeURIComponent(num)}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ enabled }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Update failed');
      setOverview((prev) => ({ ...prev, numbers: json.numbers || [] }));
      setNotice({
        text: enabled
          ? `Enabled bot access for +${num}.`
          : `Paused bot access for +${num}.`,
      });
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Could not update number',
        bad: true,
      });
    } finally {
      setBusyNumber(null);
    }
  };

  const handleDeleteOwnNumber = async (num: string) => {
    setBusyNumber(num);
    try {
      const res = await fetch(`/api/member/numbers/${encodeURIComponent(num)}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Could not remove number');
      setOverview((prev) => ({ ...prev, numbers: json.numbers || [] }));
      if (activePair?.number === num) setActivePair(null);
      setConfirmDelete(null);
      setNotice({ text: `Removed +${num} from your account.` });
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Could not remove number',
        bad: true,
      });
    } finally {
      setBusyNumber(null);
    }
  };

  const handleRequestCode = async (num: string) => {
    setBusyNumber(num);
    try {
      const res = await fetch('/api/member/pair', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ number: num }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Could not request code');

      if (json.pending && json.requestId) {
        setNotice({
          text: `Requesting 60-second linking code from live bot for +${num}…`,
        });
        const deadline = Date.now() + 26_000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1500));
          const pollRes = await fetch(
            `/api/member/pair?requestId=${encodeURIComponent(json.requestId)}`,
            { headers: authHeaders(), cache: 'no-store' },
          );
          const pollJson = await pollRes.json();
          if (!pollRes.ok) {
            throw new Error(pollJson?.error || 'Failed to get linking code');
          }
          if (!pollJson.pending && pollJson.code) {
            setActivePair({
              ok: true,
              code: pollJson.code,
              expiresInSeconds: Number(pollJson.expiresInSeconds) || 60,
              number: num,
              issuedAt: Date.now(),
            });
            setNotice({
              text: `Generated your 60-second WhatsApp linking code for +${num}.`,
            });
            return;
          }
        }
        throw new Error('Timed out waiting for live bot to issue pairing code.');
      }

      setActivePair({
        ok: true,
        code: json.code,
        expiresInSeconds: Number(json.expiresInSeconds) || 60,
        number: num,
        issuedAt: Date.now(),
      });
      setNotice({
        text: `Generated your 60-second WhatsApp linking code for +${num}.`,
      });
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Failed to get linking code',
        bad: true,
      });
    } finally {
      setBusyNumber(null);
    }
  };

  const handleUpdateName = async (nextName: string) => {
    const res = await fetch('/api/auth/me', {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ name: nextName }),
    });
    const json = await res.json();
    if (res.ok && json.user) {
      setUser(json.user);
      if (json.token) setSavedSessionToken(json.token);
      setNotice({ text: 'Updated your profile name.' });
    }
  };

  const handleSignOut = async () => {
    await performSignOut();
    router.replace('/login');
  };

  if (checking || !user) {
    return (
      <div className="bg-portal-canvas flex min-h-screen items-center justify-center">
        <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-5 py-3.5 text-sm font-medium text-slate-700 shadow-sm">
          <Loader2 className="h-4 w-4 animate-spin text-teal-600" />
          Loading Member Workspace…
        </div>
      </div>
    );
  }

  const canManageNumbers =
    overview.memberAllowed && (overview.botEnabledForMembers || user.isAdmin);

  return (
    <div className="bg-portal-canvas min-h-screen">
      {/* Clean Member Light Navbar (no admin server settings exposed) */}
      <header className="sticky top-0 z-30 border-b border-slate-200/90 bg-white/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1140px] flex-wrap items-center justify-between gap-3 px-5 py-3.5">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal-600 font-mono text-sm font-extrabold text-white shadow-sm">
              ZF
            </div>
            <div>
              <div className="text-sm font-bold text-slate-900">ZaFar Member Portal</div>
              <p className="text-xs text-slate-500">WhatsApp Number Access &amp; Linking</p>
            </div>
          </div>

          <nav
            aria-label="Member navigation"
            className="order-3 flex w-full items-center gap-1 overflow-x-auto rounded-xl bg-slate-100 p-1 md:order-2 md:w-auto"
          >
            <button
              type="button"
              onClick={() => setTab('numbers')}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold transition ${
                tab === 'numbers'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Smartphone
                className={`h-3.5 w-3.5 ${tab === 'numbers' ? 'text-teal-600' : ''}`}
              />
              My Numbers
            </button>

            <button
              type="button"
              onClick={() => setTab('commands')}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold transition ${
                tab === 'commands'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Command
                className={`h-3.5 w-3.5 ${tab === 'commands' ? 'text-teal-600' : ''}`}
              />
              Commands
            </button>

            <button
              type="button"
              onClick={() => setTab('vault')}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold transition ${
                tab === 'vault'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <BookOpen
                className={`h-3.5 w-3.5 ${tab === 'vault' ? 'text-teal-600' : ''}`}
              />
              Past-Paper Vault
            </button>
          </nav>

          <div className="order-2 flex items-center gap-2 md:order-3">
            {user.isAdmin && (
              <Link
                href="/admin"
                className="inline-flex items-center gap-1.5 rounded-full bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-teal-700"
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                Admin Console
              </Link>
            )}

            <button
              type="button"
              onClick={() => loadMemberStatus(false)}
              disabled={refreshing}
              title="Refresh"
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:text-slate-900"
            >
              {refreshing ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin text-teal-600" />
              ) : (
                <Activity className="h-3.5 w-3.5" />
              )}
            </button>

            <button
              type="button"
              onClick={() => setAccountOpen(true)}
              className="flex items-center gap-2 rounded-full border border-slate-200 bg-white py-1 pl-1.5 pr-3 text-xs font-semibold text-slate-800 shadow-sm hover:border-teal-300"
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-teal-50 font-mono text-[10px] font-bold uppercase text-teal-700 ring-1 ring-teal-200">
                {(user.name || user.email).slice(0, 2)}
              </span>
              <span className="max-w-[120px] truncate">{user.name}</span>
            </button>

            <button
              type="button"
              onClick={handleSignOut}
              title="Sign out"
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1140px] px-5 pb-16 pt-8">
        {/* Greeting Header */}
        <section className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <span className="text-xs font-bold uppercase tracking-widest text-teal-700">
              Welcome, {user.name}
            </span>
            <h1 className="mt-1 text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">
              Link Your WhatsApp Number
            </h1>
            <p className="mt-1.5 max-w-2xl text-sm text-slate-600">
              Allow your personal WhatsApp number to use ZaFar Bot commands or generate a 60-second code to link your number directly.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-semibold ${
                overview.memberAllowed
                  ? 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200'
                  : 'bg-rose-50 text-rose-700 ring-1 ring-rose-200'
              }`}
            >
              {overview.memberAllowed ? (
                <ShieldCheck className="h-4 w-4 text-emerald-600" />
              ) : (
                <ShieldAlert className="h-4 w-4 text-rose-600" />
              )}
              {overview.memberAllowed ? 'Account Allowed' : 'Account Disallowed'}
            </span>

            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-semibold ${
                overview.botConnected
                  ? 'bg-teal-50 text-teal-800 ring-1 ring-teal-200'
                  : overview.botReachable
                    ? 'bg-amber-50 text-amber-800 ring-1 ring-amber-200'
                    : 'bg-slate-100 text-slate-700 ring-1 ring-slate-200'
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  overview.botConnected
                    ? 'bg-teal-500'
                    : overview.botReachable
                      ? 'bg-amber-500'
                      : 'bg-rose-500'
                }`}
              />
              {overview.botConnected
                ? overview.botNumber
                  ? `Bot Online · +${overview.botNumber}`
                  : 'Bot Online'
                : overview.botReachable
                  ? 'Bot Awaiting Pairing'
                  : overview.botServerLinked
                    ? 'Bot Offline'
                    : 'Bot Not Linked'}
            </span>
          </div>
        </section>

        {overview.botServerLinked && overview.botReachable === false && (
          <div
            role="status"
            className="mb-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900"
          >
            <strong>Bot Server Offline:</strong> You can still add or pause your WhatsApp numbers right now — your whitelist changes are saved in the portal database and sync to ZaFar Bot as soon as it comes back online. Live 60-second pairing codes require the bot to be online.
          </div>
        )}

        {!overview.memberAllowed && (
          <div className="mb-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
            <strong>Access Restricted:</strong> Your member account has been disallowed by the administrator (
            <span className="font-mono">{overview.adminEmail}</span>). Contact the administrator to restore bot access.
          </div>
        )}

        {notice && (
          <div
            role="status"
            className={`mb-5 flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-xs font-medium ${
              notice.bad
                ? 'border-rose-200 bg-rose-50 text-rose-800'
                : 'border-teal-200 bg-teal-50 text-teal-900'
            }`}
          >
            <div className="flex items-center gap-2">
              {notice.bad ? (
                <AlertCircle className="h-4 w-4 shrink-0 text-rose-600" />
              ) : (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-teal-600" />
              )}
              <span>{notice.text}</span>
            </div>
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="text-[11px] font-semibold underline"
            >
              Dismiss
            </button>
          </div>
        )}

        {tab === 'numbers' && (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.2fr_0.8fr]">
            <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
              <h2 className="text-lg font-bold text-slate-900">
                My Allowed WhatsApp Numbers
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Enter your full international phone number (country code included, no spaces needed) to allow it on ZaFar Bot.
              </p>

              <form
                onSubmit={handleAllowNumber}
                className="mt-5 grid grid-cols-1 gap-2.5 sm:grid-cols-[1.15fr_0.95fr_auto] sm:items-end"
              >
                <div>
                  <label
                    htmlFor="member-wa-number"
                    className="mb-1.5 block text-xs font-medium text-slate-700"
                  >
                    Your WhatsApp number
                  </label>
                  <input
                    id="member-wa-number"
                    type="text"
                    inputMode="numeric"
                    required
                    disabled={!canManageNumbers}
                    value={number}
                    onChange={(e) => setNumber(e.target.value)}
                    placeholder="265991234567"
                    className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 font-mono text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none disabled:bg-slate-100 tabular-nums"
                  />
                </div>

                <div>
                  <label
                    htmlFor="member-wa-label"
                    className="mb-1.5 block text-xs font-medium text-slate-700"
                  >
                    Device label (optional)
                  </label>
                  <input
                    id="member-wa-label"
                    type="text"
                    maxLength={80}
                    disabled={!canManageNumbers}
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="My Primary Phone"
                    className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none disabled:bg-slate-100"
                  />
                </div>

                <button
                  type="submit"
                  disabled={!canManageNumbers || submitting}
                  className="inline-flex h-[42px] items-center justify-center gap-1.5 rounded-xl bg-teal-600 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:opacity-50"
                >
                  <Plus className="h-4 w-4" />
                  {submitting ? 'Saving…' : 'Allow Number'}
                </button>
              </form>

              <div className="mt-5">
                <PairingCodeBanner
                  activePair={activePair}
                  onDismiss={() => setActivePair(null)}
                />
              </div>

              <div className="mt-3 divide-y divide-slate-100">
                {overview.numbers.length === 0 ? (
                  <div className="py-10 text-center">
                    <p className="text-sm font-semibold text-slate-700">
                      You haven&apos;t added a WhatsApp number yet.
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      Add your number above to enable bot access and generate a WhatsApp linking code.
                    </p>
                  </div>
                ) : (
                  overview.numbers.map((item) => {
                    const busy = busyNumber === item.number;
                    const confirming = confirmDelete === item.number;
                    return (
                      <div
                        key={item.number}
                        className="flex flex-wrap items-center justify-between gap-3 py-3.5"
                      >
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-sm font-bold text-slate-900 tabular-nums">
                              +{item.number}
                            </span>
                            <span
                              className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                                item.enabled
                                  ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                                  : 'bg-slate-100 text-slate-600'
                              }`}
                            >
                              {item.enabled ? 'Active' : 'Paused'}
                            </span>
                          </div>
                          <p className="mt-0.5 text-xs text-slate-500">
                            {item.label || 'My WhatsApp'}
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={
                              !item.enabled ||
                              !canManageNumbers ||
                              busy ||
                              overview.botReachable === false
                            }
                            title={
                              overview.botReachable === false
                                ? 'Live bot is currently offline'
                                : undefined
                            }
                            onClick={() => handleRequestCode(item.number)}
                            className="inline-flex items-center gap-1.5 rounded-xl bg-teal-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:opacity-40"
                          >
                            <Link2 className="h-3.5 w-3.5" />
                            {overview.botReachable === false ? 'Bot Offline' : 'Link with Code'}
                          </button>

                          <button
                            type="button"
                            disabled={!canManageNumbers || busy}
                            onClick={() =>
                              handleToggleOwnNumber(item.number, !item.enabled)
                            }
                            className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-50"
                          >
                            {item.enabled ? 'Pause' : 'Enable'}
                          </button>

                          {confirming ? (
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => handleDeleteOwnNumber(item.number)}
                                className="rounded-xl bg-rose-600 px-3 py-2 text-xs font-semibold text-white"
                              >
                                Confirm
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDelete(null)}
                                className="rounded-xl bg-slate-100 px-2.5 py-2 text-xs font-medium text-slate-600"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmDelete(item.number)}
                              className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-xs font-semibold text-rose-600 hover:border-rose-200 hover:bg-rose-50"
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

            <MediaVaultDesk
              compact
              onExploreAll={() => setTab('vault')}
            />
          </div>
        )}

        {tab === 'commands' && <CommandDirectory hideOwnerCommands />}
        {tab === 'vault' && <MediaVaultDesk />}
      </main>

      <AccountModal
        open={accountOpen}
        onClose={() => setAccountOpen(false)}
        user={user}
        quota={quota}
        onUpdateName={handleUpdateName}
        onSignOut={handleSignOut}
      />
    </div>
  );
}
