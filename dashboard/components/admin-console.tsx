'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Activity,
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  HelpCircle,
  Link2,
  Loader2,
  LogOut,
  Plus,
  Power,
  RefreshCw,
  Search,
  Server,
  ShieldBan,
  ShieldCheck,
  Smartphone,
  Trash2,
  UserCheck,
  UserPlus,
  Users,
} from 'lucide-react';
import {
  AdminOverviewPayload,
  AuthUser,
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
import { AccountModal } from './account-modal';

type AdminTab = 'members' | 'bot' | 'guide';
type MemberFilter = 'all' | 'allowed' | 'disallowed';

const BOT_ENV_EXAMPLE = `ADMIN_API_PORT=3000
ADMIN_DASHBOARD_TOKEN=choose-a-strong-shared-secret
DASHBOARD_URL=https://your-portal.vercel.app`;

export function AdminConsole() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [quota, setQuota] = useState<UserQuota | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);

  const [tab, setTab] = useState<AdminTab>('members');
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);

  const [data, setData] = useState<AdminOverviewPayload>({
    ok: true,
    adminEmail: 'troykunsauka@gmail.com',
    botServerLinked: false,
    botApiUrl: '',
    hasBotToken: false,
    botEnabledForMembers: true,
    storageEngine: 'persistent-db',
    upstreamHost: null,
    connected: false,
    botNumber: null,
    users: [],
    members: [],
  });

  // Member management state
  const [memberSearch, setMemberSearch] = useState('');
  const [memberFilter, setMemberFilter] = useState<MemberFilter>('all');
  const [newMemberEmail, setNewMemberEmail] = useState('');
  const [newMemberName, setNewMemberName] = useState('');
  const [addingMember, setAddingMember] = useState(false);
  const [busyEmail, setBusyEmail] = useState<string | null>(null);

  // Bot & numbers state
  const [botUrlInput, setBotUrlInput] = useState('');
  const [botTokenInput, setBotTokenInput] = useState('');
  const [showBotToken, setShowBotToken] = useState(false);
  const [savingBot, setSavingBot] = useState(false);

  const [numInput, setNumInput] = useState('');
  const [numLabel, setNumLabel] = useState('');
  const [addingNumber, setAddingNumber] = useState(false);
  const [busyNumber, setBusyNumber] = useState<string | null>(null);
  const [confirmDeleteNum, setConfirmDeleteNum] = useState<string | null>(null);
  const [activePair, setActivePair] = useState<PairCodePayload | null>(null);
  const [copiedSnippet, setCopiedSnippet] = useState(false);

  const loadOverview = useCallback(
    async (silent = false, hydrateInputs = false) => {
      if (!silent) setRefreshing(true);
      try {
        const res = await fetch('/api/admin/status', {
          headers: authHeaders(),
          cache: 'no-store',
        });
        if (res.status === 401) {
          router.replace('/login');
          return;
        }
        if (res.status === 403) {
          router.replace('/dashboard');
          return;
        }
        const json = (await res.json()) as AdminOverviewPayload & { error?: string };
        if (!res.ok) throw new Error(json.error || 'Failed to load admin console');
        setData(json);
        if (hydrateInputs) {
          setBotUrlInput(json.botApiUrl || '');
          setBotTokenInput(json.hasBotToken ? '••••••••' : '');
        }
      } catch (err) {
        setNotice({
          text: err instanceof Error ? err.message : 'Unable to fetch admin status',
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
      if (!session.user.isAdmin) {
        router.replace('/dashboard');
        return;
      }
      setUser(session.user);
      setQuota(session.quota);
      await loadOverview(true, true);
      setChecking(false);
    })();
  }, [router, loadOverview]);

  useEffect(() => {
    if (!user) return;
    const id = setInterval(() => {
      void loadOverview(true, false);
    }, 15_000);
    return () => clearInterval(id);
  }, [user, loadOverview]);

  const filteredMembers = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    return data.members.filter((m) => {
      if (memberFilter === 'allowed' && !m.allowed) return false;
      if (memberFilter === 'disallowed' && m.allowed) return false;
      if (!q) return true;
      return (
        m.email.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
      );
    });
  }, [data.members, memberSearch, memberFilter]);

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMemberEmail.trim()) return;
    setAddingMember(true);
    try {
      const res = await fetch('/api/admin/members', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          email: newMemberEmail.trim(),
          name: newMemberName.trim(),
          allowed: true,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Could not add member');
      setData((prev) => ({ ...prev, members: json.members }));
      setNewMemberEmail('');
      setNewMemberName('');
      setNotice({ text: `Allowed member ${newMemberEmail.trim().toLowerCase()}.` });
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Failed to allow member',
        bad: true,
      });
    } finally {
      setAddingMember(false);
    }
  };

  const handleToggleMember = async (
    email: string,
    allowed: boolean,
    name: string,
  ) => {
    setBusyEmail(email);
    try {
      const res = await fetch('/api/admin/members', {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ email, allowed, name }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Failed to update member');
      setData((prev) => ({
        ...prev,
        members: json.members || prev.members,
        users: json.users || prev.users,
      }));
      setNotice({
        text: allowed
          ? `Allowed member ${email} to use ZaFar Bot.`
          : `Disallowed member ${email} and disabled their linked numbers.`,
      });
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Update failed',
        bad: true,
      });
    } finally {
      setBusyEmail(null);
    }
  };

  const handleSaveBotConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingBot(true);
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          botApiUrl: botUrlInput.trim(),
          botAdminToken: botTokenInput.trim(),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Failed to save bot link');

      await loadOverview(true, false);
      if (json.probe?.reachable) {
        setNotice({
          text: `Connected to live bot server (${json.probe.latencyMs ?? 0}ms) — WhatsApp socket is ${
            json.probe.connected ? 'ONLINE' : 'waiting to pair'
          }.`,
        });
      } else if (botUrlInput.trim()) {
        setNotice({
          text: `Saved Bot URL in cloud database, though probe reported: ${
            json.probe?.error || 'server not reachable yet'
          }.`,
          bad: true,
        });
      } else {
        setNotice({ text: 'Cleared Bot Server URL.' });
      }
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Failed to save bot settings',
        bad: true,
      });
    } finally {
      setSavingBot(false);
    }
  };

  const handleToggleGlobalBot = async () => {
    const nextState = !data.botEnabledForMembers;
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ botEnabledForMembers: nextState }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Failed to toggle bot access');
      setData((prev) => ({ ...prev, botEnabledForMembers: nextState }));
      setNotice({
        text: nextState
          ? 'Enabled bot number linking for all allowed members.'
          : 'Paused new number linking for members.',
      });
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Could not update setting',
        bad: true,
      });
    }
  };

  const handleAddNumber = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!numInput.trim()) return;
    setAddingNumber(true);
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ number: numInput, label: numLabel }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Could not approve number');
      setData((prev) => ({ ...prev, users: json.users }));
      setNumInput('');
      setNumLabel('');
      setNotice({ text: `Approved WhatsApp number +${numInput.replace(/\D/g, '')}.` });
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Failed to add number',
        bad: true,
      });
    } finally {
      setAddingNumber(false);
    }
  };

  const handleToggleNumber = async (number: string, enabled: boolean) => {
    setBusyNumber(number);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(number)}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ enabled }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Update failed');
      await loadOverview(true, false);
      setNotice({
        text: enabled
          ? `Allowed WhatsApp number +${number}.`
          : `Disallowed WhatsApp number +${number}.`,
      });
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Failed to update number',
        bad: true,
      });
    } finally {
      setBusyNumber(null);
    }
  };

  const handleDeleteNumber = async (number: string) => {
    setBusyNumber(number);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(number)}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Remove failed');
      setData((prev) => ({ ...prev, users: json.users || [] }));
      if (activePair?.number === number) setActivePair(null);
      setConfirmDeleteNum(null);
      setNotice({ text: `Removed +${number}.` });
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Failed to remove number',
        bad: true,
      });
    } finally {
      setBusyNumber(null);
    }
  };

  const handlePairNumber = async (number: string) => {
    setBusyNumber(number);
    try {
      const res = await fetch('/api/admin/pair', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ number }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Could not request code');
      setActivePair({
        ok: true,
        code: json.code,
        expiresInSeconds: Number(json.expiresInSeconds) || 60,
        number,
        issuedAt: Date.now(),
      });
      setNotice({ text: `Generated linking code for +${number}.` });
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Failed to request pairing code',
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
      setNotice({ text: 'Updated administrator display name.' });
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
          Loading Admin Console…
        </div>
      </div>
    );
  }

  const allowedMembersCount = data.members.filter((m) => m.allowed).length;
  const enabledNumbersCount = data.users.filter((u) => u.enabled).length;

  return (
    <div className="bg-portal-canvas min-h-screen">
      {/* Light Top Navbar */}
      <header className="sticky top-0 z-30 border-b border-slate-200/90 bg-white/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1180px] flex-wrap items-center justify-between gap-3 px-5 py-3.5">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal-600 font-mono text-sm font-extrabold text-white shadow-sm">
              ZF
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-bold text-slate-900">
                  ZaFar Admin Console
                </span>
                <span className="rounded-full bg-teal-50 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-teal-700 ring-1 ring-teal-200">
                  Admin Only
                </span>
              </div>
              <p className="hidden text-xs text-slate-500 sm:block">
                Controlling members, WhatsApp numbers &amp; live bot link
              </p>
            </div>
          </div>

          <nav
            aria-label="Admin sections"
            className="order-3 flex w-full items-center gap-1 overflow-x-auto rounded-xl bg-slate-100 p-1 md:order-2 md:w-auto"
          >
            <button
              type="button"
              onClick={() => setTab('members')}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold transition ${
                tab === 'members'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Users className={`h-3.5 w-3.5 ${tab === 'members' ? 'text-teal-600' : ''}`} />
              Members ({data.members.length})
            </button>

            <button
              type="button"
              onClick={() => setTab('bot')}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold transition ${
                tab === 'bot'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Server className={`h-3.5 w-3.5 ${tab === 'bot' ? 'text-teal-600' : ''}`} />
              Bot &amp; Numbers ({data.users.length})
            </button>

            <button
              type="button"
              onClick={() => setTab('guide')}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold transition ${
                tab === 'guide'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <HelpCircle className={`h-3.5 w-3.5 ${tab === 'guide' ? 'text-teal-600' : ''}`} />
              How to Link Bot
            </button>
          </nav>

          <div className="order-2 flex items-center gap-2 md:order-3">
            <Link
              href="/dashboard"
              className="hidden items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-teal-300 hover:bg-teal-50 hover:text-teal-800 sm:inline-flex"
            >
              Member Page
              <ExternalLink className="h-3 w-3" />
            </Link>

            <button
              type="button"
              onClick={() => loadOverview(false, false)}
              disabled={refreshing}
              title="Refresh live data"
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
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
              className="flex items-center gap-2 rounded-full border border-slate-200 bg-white py-1 pl-1.5 pr-3 text-xs font-semibold text-slate-800 shadow-sm transition hover:border-teal-300"
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-teal-600 font-mono text-[10px] font-bold uppercase text-white">
                {(user.name || user.email).slice(0, 2)}
              </span>
              <span className="max-w-[120px] truncate">{user.name}</span>
            </button>

            <button
              type="button"
              onClick={handleSignOut}
              title="Sign out"
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1180px] px-5 pb-16 pt-8">
        {/* Page Heading */}
        <section className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <span className="text-xs font-bold uppercase tracking-widest text-teal-700">
              Administrator Control Room · {user.email}
            </span>
            <h1 className="mt-1 text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">
              Control Members &amp; Bot Operations
            </h1>
            <p className="mt-1.5 max-w-2xl text-sm text-slate-600">
              Allow or disallow members by email, connect your live WhatsApp bot server once for everyone, and manage all linked phone numbers.
            </p>
          </div>

          <button
            type="button"
            onClick={handleToggleGlobalBot}
            className={`inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-xs font-bold shadow-sm transition ${
              data.botEnabledForMembers
                ? 'border-teal-200 bg-teal-50 text-teal-800 hover:bg-teal-100'
                : 'border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100'
            }`}
          >
            <Power className="h-4 w-4" />
            {data.botEnabledForMembers
              ? 'Member Access: ACTIVE (Click to Pause)'
              : 'Member Access: PAUSED (Click to Enable)'}
          </button>
        </section>

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

        {data.botServerLinked && data.botReachable === false && (
          <div
            role="alert"
            className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-950"
          >
            <div className="flex items-start gap-2.5">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div>
                <strong className="font-bold">Bot Offline:</strong>{' '}
                {data.botError || 'Could not reach the bot server within 3 seconds.'}{' '}
                <span className="text-amber-800">
                  Member &amp; number changes still save to D1 and sync automatically once the bot is back online.
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setTab('bot')}
              className="shrink-0 rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-amber-900 hover:bg-amber-100"
            >
              Check Bot Link
            </button>
          </div>
        )}

        {/* Summary Metric Cards */}
        <section className="mb-7 grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-3.5">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="text-xs font-medium text-slate-500">Allowed Members</div>
            <div className="mt-1.5 flex items-baseline gap-2">
              <b className="font-mono text-2xl font-bold text-slate-900 tabular-nums">
                {allowedMembersCount}
              </b>
              <span className="text-xs text-slate-500">of {data.members.length}</span>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="text-xs font-medium text-slate-500">Active Numbers</div>
            <div className="mt-1.5 flex items-baseline gap-2">
              <b className="font-mono text-2xl font-bold text-slate-900 tabular-nums">
                {enabledNumbersCount}
              </b>
              <span className="text-xs text-slate-500">of {data.users.length}</span>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="text-xs font-medium text-slate-500">Live Bot Socket</div>
            <div className="mt-1.5 flex items-center gap-2">
              <span
                className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                  data.connected
                    ? 'bg-teal-500'
                    : data.botReachable
                      ? 'bg-amber-500'
                      : data.botServerLinked
                        ? 'bg-rose-500'
                        : 'bg-slate-300'
                }`}
              />
              <b className="text-base font-bold text-slate-900 sm:text-xl">
                {data.botServerLinked
                  ? data.connected
                    ? 'Online'
                    : data.botReachable
                      ? 'Awaiting Pair'
                      : 'Bot Offline'
                  : 'Not Linked'}
              </b>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between text-xs font-medium text-slate-500">
              <span>Bot WhatsApp ID</span>
              <Smartphone className="h-3.5 w-3.5 text-teal-600" />
            </div>
            <b className="mt-1.5 block font-mono text-xl font-bold text-slate-900 tabular-nums">
              {data.botNumber ? `+${data.botNumber}` : '—'}
            </b>
          </div>
        </section>

        {/* TAB 1: MEMBERS CONTROL */}
        {tab === 'members' && (
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900">
                  <UserCheck className="h-5 w-5 text-teal-600" />
                  Member Access Control
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  Allow or disallow members by email. Disallowing a member immediately blocks them from adding numbers or linking WhatsApp devices.
                </p>
              </div>

              <div className="flex items-center gap-1 rounded-xl bg-slate-100 p-1 text-xs">
                {(['all', 'allowed', 'disallowed'] as MemberFilter[]).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setMemberFilter(f)}
                    className={`rounded-lg px-3 py-1 font-semibold capitalize transition ${
                      memberFilter === f
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>

            {/* Pre-allow / Add Member Form */}
            <form
              onSubmit={handleAddMember}
              className="mt-5 grid grid-cols-1 gap-2.5 rounded-2xl border border-slate-200 bg-slate-50/70 p-4 sm:grid-cols-[1.2fr_1fr_auto] sm:items-end"
            >
              <div>
                <label
                  htmlFor="add-member-email"
                  className="mb-1 block text-xs font-medium text-slate-700"
                >
                  Allow / pre-approve member email
                </label>
                <input
                  id="add-member-email"
                  type="email"
                  required
                  value={newMemberEmail}
                  onChange={(e) => setNewMemberEmail(e.target.value)}
                  placeholder="member@gmail.com"
                  className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                />
              </div>
              <div>
                <label
                  htmlFor="add-member-name"
                  className="mb-1 block text-xs font-medium text-slate-700"
                >
                  Member name (optional)
                </label>
                <input
                  id="add-member-name"
                  type="text"
                  value={newMemberName}
                  onChange={(e) => setNewMemberName(e.target.value)}
                  placeholder="Student or team member"
                  className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                />
              </div>
              <button
                type="submit"
                disabled={addingMember}
                className="inline-flex h-[38px] items-center justify-center gap-1.5 rounded-xl bg-teal-600 px-4 text-xs font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:opacity-60"
              >
                <UserPlus className="h-4 w-4" />
                {addingMember ? 'Saving…' : 'Allow Member'}
              </button>
            </form>

            {/* Search bar */}
            <div className="relative mt-4">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                value={memberSearch}
                onChange={(e) => setMemberSearch(e.target.value)}
                placeholder="Search members by email or name…"
                className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2 pl-10 pr-4 text-xs text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:bg-white focus:outline-none"
              />
            </div>

            {/* Members list */}
            <div className="mt-4 divide-y divide-slate-100">
              {filteredMembers.length === 0 ? (
                <div className="py-10 text-center text-sm text-slate-500">
                  No members match this view yet. Registered members appear here automatically.
                </div>
              ) : (
                filteredMembers.map((member) => {
                  const busy = busyEmail === member.email;
                  return (
                    <div
                      key={member.email}
                      className="flex flex-wrap items-center justify-between gap-3 py-3.5"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-bold text-slate-900">
                            {member.name}
                          </span>
                          {member.isAdmin ? (
                            <span className="rounded-full bg-teal-50 px-2.5 py-0.5 text-[11px] font-bold text-teal-800 ring-1 ring-teal-200">
                              Admin
                            </span>
                          ) : member.allowed ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-200">
                              <ShieldCheck className="h-3 w-3" />
                              Allowed
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2.5 py-0.5 text-[11px] font-semibold text-rose-700 ring-1 ring-rose-200">
                              <ShieldBan className="h-3 w-3" />
                              Disallowed
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                          <span className="break-all font-mono text-slate-700">{member.email}</span>
                          <span>·</span>
                          <span>{member.numbersCount} linked number(s)</span>
                        </div>
                      </div>

                      <div>
                        {member.isAdmin ? (
                          <span className="text-xs font-medium text-slate-400">
                            Protected Owner
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              handleToggleMember(
                                member.email,
                                !member.allowed,
                                member.name,
                              )
                            }
                            className={`rounded-xl px-4 py-2 text-xs font-semibold transition disabled:opacity-50 ${
                              member.allowed
                                ? 'border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100'
                                : 'bg-teal-600 text-white hover:bg-teal-700'
                            }`}
                          >
                            {busy
                              ? 'Updating…'
                              : member.allowed
                                ? 'Disallow Member'
                                : 'Allow Member'}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>
        )}

        {/* TAB 2: BOT SERVER LINK & ALL NUMBERS */}
        {tab === 'bot' && (
          <div className="space-y-6">
            {/* Link Bot Server Card */}
            <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900">
                    <Server className="h-5 w-5 text-teal-600" />
                    Link Live WhatsApp Bot Server
                  </h2>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Saved securely in Cloudflare D1 — once linked here, all allowed members automatically use this bot connection on their own page without seeing your URL or token.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setTab('guide')}
                  className="text-xs font-semibold text-teal-700 hover:underline"
                >
                  Step-by-step Bot Setup Guide →
                </button>
              </div>

              <form
                onSubmit={handleSaveBotConfig}
                className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-[1.2fr_1fr_auto] md:items-end"
              >
                <div>
                  <label
                    htmlFor="admin-bot-url"
                    className="mb-1 block text-xs font-medium text-slate-700"
                  >
                    Bot Server Public URL (<code className="font-mono">/admin/api</code>)
                  </label>
                  <input
                    id="admin-bot-url"
                    type="url"
                    value={botUrlInput}
                    onChange={(e) => setBotUrlInput(e.target.value)}
                    placeholder="https://your-whatsapp-bot.koyeb.app or http://IP:3000"
                    className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                  />
                </div>

                <div>
                  <label
                    htmlFor="admin-bot-token"
                    className="mb-1 block text-xs font-medium text-slate-700"
                  >
                    Shared Token (<code className="font-mono">ADMIN_DASHBOARD_TOKEN</code>)
                  </label>
                  <div className="relative">
                    <input
                      id="admin-bot-token"
                      type={showBotToken ? 'text' : 'password'}
                      value={botTokenInput}
                      onChange={(e) => setBotTokenInput(e.target.value)}
                      placeholder="Same token set in bot .env"
                      className="w-full rounded-xl border border-slate-300 bg-white py-2.5 pl-3.5 pr-10 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setShowBotToken((s) => !s)}
                      aria-label={showBotToken ? 'Hide token' : 'Show token'}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
                    >
                      {showBotToken ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={savingBot}
                  className="inline-flex h-[40px] items-center justify-center gap-1.5 rounded-xl bg-teal-600 px-5 text-xs font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:opacity-60"
                >
                  {savingBot ? 'Testing…' : 'Test & Save Bot Link'}
                </button>
              </form>

              {(data.isInsecureHttp || /^http:\/\/(?!localhost|127\.0\.0\.1)/i.test(botUrlInput.trim())) && (
                <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900">
                  <strong>HTTPS Tunnel Recommended:</strong> Plain <code className="font-mono">http://IP:PORT</code> works via the server-side proxy, but sends <code className="font-mono">ADMIN_DASHBOARD_TOKEN</code> unencrypted over the network. Put a free Cloudflare Tunnel (<code className="font-mono">cloudflared tunnel --url http://127.0.0.1:3000</code>) or HTTPS reverse proxy in front of the bot whenever possible.
                </p>
              )}
            </section>

            {/* All WhatsApp Numbers Table */}
            <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
              <h2 className="text-lg font-bold text-slate-900">
                All Linked &amp; Approved WhatsApp Numbers
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                View every WhatsApp number registered across all members, generate 60-second pairing codes, or revoke access.
              </p>

              <form
                onSubmit={handleAddNumber}
                className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-[1.1fr_1fr_auto] sm:items-end"
              >
                <div>
                  <label
                    htmlFor="admin-add-num"
                    className="mb-1 block text-xs font-medium text-slate-700"
                  >
                    International WhatsApp number
                  </label>
                  <input
                    id="admin-add-num"
                    type="text"
                    inputMode="numeric"
                    required
                    value={numInput}
                    onChange={(e) => setNumInput(e.target.value)}
                    placeholder="265991234567"
                    className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 font-mono text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none tabular-nums"
                  />
                </div>
                <div>
                  <label
                    htmlFor="admin-add-label"
                    className="mb-1 block text-xs font-medium text-slate-700"
                  >
                    Label / note
                  </label>
                  <input
                    id="admin-add-label"
                    type="text"
                    value={numLabel}
                    onChange={(e) => setNumLabel(e.target.value)}
                    placeholder="Operator phone"
                    className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                  />
                </div>
                <button
                  type="submit"
                  disabled={addingNumber}
                  className="inline-flex h-[42px] items-center justify-center gap-1.5 rounded-xl bg-teal-600 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:opacity-60"
                >
                  <Plus className="h-4 w-4" />
                  {addingNumber ? 'Adding…' : 'Approve Number'}
                </button>
              </form>

              <div className="mt-5">
                <PairingCodeBanner
                  activePair={activePair}
                  onDismiss={() => setActivePair(null)}
                />
              </div>

              <div className="mt-3 divide-y divide-slate-100">
                {data.users.length === 0 ? (
                  <p className="py-8 text-center text-sm text-slate-500">
                    No WhatsApp numbers approved yet.
                  </p>
                ) : (
                  data.users.map((u) => {
                    const busy = busyNumber === u.number;
                    const confirming = confirmDeleteNum === u.number;
                    return (
                      <div
                        key={u.number}
                        className="flex flex-wrap items-center justify-between gap-3 py-3.5"
                      >
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-sm font-bold text-slate-900 tabular-nums">
                              +{u.number}
                            </span>
                            <span
                              className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                                u.enabled
                                  ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                                  : 'bg-rose-50 text-rose-700 ring-1 ring-rose-200'
                              }`}
                            >
                              {u.enabled ? 'Allowed' : 'Disallowed'}
                            </span>
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                            <span>{u.label || 'Approved number'}</span>
                            {u.addedBy && (
                              <>
                                <span>·</span>
                                <span className="font-mono text-slate-600">
                                  Owner: {u.addedBy}
                                </span>
                              </>
                            )}
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={!u.enabled || busy}
                            onClick={() => handlePairNumber(u.number)}
                            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-800 transition hover:border-teal-300 hover:bg-teal-50 hover:text-teal-800 disabled:opacity-40"
                          >
                            <Link2 className="h-3.5 w-3.5 text-teal-600" />
                            Get Code
                          </button>

                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => handleToggleNumber(u.number, !u.enabled)}
                            className={`rounded-xl px-3 py-2 text-xs font-semibold transition ${
                              u.enabled
                                ? 'border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100'
                                : 'bg-teal-600 text-white hover:bg-teal-700'
                            }`}
                          >
                            {u.enabled ? 'Disallow' : 'Allow'}
                          </button>

                          {confirming ? (
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => handleDeleteNumber(u.number)}
                                className="rounded-xl bg-rose-600 px-3 py-2 text-xs font-semibold text-white"
                              >
                                Confirm
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteNum(null)}
                                className="rounded-xl bg-slate-100 px-2.5 py-2 text-xs font-medium text-slate-600"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteNum(u.number)}
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
          </div>
        )}

        {/* TAB 3: STEP-BY-STEP HOW TO LINK BOT GUIDE */}
        {tab === 'guide' && (
          <section className="space-y-5 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div>
              <span className="text-xs font-bold uppercase tracking-widest text-teal-700">
                Connection Guide
              </span>
              <h2 className="mt-1 text-xl font-bold text-slate-900">
                How to Connect Your WhatsApp Bot to This Website
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Your WhatsApp bot includes the built-in dashboard bridge in{' '}
                <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-800">
                  index.js
                </code>{' '}
                (<code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-800">utils/adminApi.js</code>). Follow these 3 quick steps:
              </p>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
                <div className="font-mono text-xs font-bold text-teal-700">STEP 1</div>
                <h3 className="mt-1 text-sm font-bold text-slate-900">
                  Set Token on Your Bot Host
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-slate-600">
                  Where you run your WhatsApp bot (Koyeb, KataBump, Railway, or VPS), add these two variables in its Environment / <code className="font-mono">.env</code>:
                </p>
                <pre className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white p-3 font-mono text-[11px] text-slate-800">
                  {BOT_ENV_EXAMPLE}
                </pre>
                <button
                  type="button"
                  onClick={async () => {
                    await navigator.clipboard.writeText(BOT_ENV_EXAMPLE);
                    setCopiedSnippet(true);
                    setTimeout(() => setCopiedSnippet(false), 1800);
                  }}
                  className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-teal-700 hover:underline"
                >
                  {copiedSnippet ? (
                    <>
                      <Check className="h-3.5 w-3.5" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      Copy .env lines
                    </>
                  )}
                </button>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
                <div className="font-mono text-xs font-bold text-teal-700">STEP 2</div>
                <h3 className="mt-1 text-sm font-bold text-slate-900">
                  Copy Your Bot&apos;s Public Address
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-slate-600">
                  Copy the HTTPS tunnel URL (recommended) or allocated IP:Port pointing to <code className="font-mono">ADMIN_API_PORT</code>:
                </p>
                <ul className="mt-2.5 space-y-1.5 text-xs text-slate-600">
                  <li>
                    • <strong>Cloudflare Tunnel (HTTPS):</strong>{' '}
                    <code className="font-mono text-slate-800">
                      cloudflared tunnel --url http://127.0.0.1:3000
                    </code>
                  </li>
                  <li>
                    • <strong>Koyeb / Railway:</strong>{' '}
                    <code className="font-mono text-slate-800">
                      https://your-bot.koyeb.app
                    </code>
                  </li>
                  <li>
                    • <strong>Panel Allocated Port:</strong>{' '}
                    <code className="font-mono text-slate-800">
                      http://SERVER_IP:PORT
                    </code>
                  </li>
                </ul>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
                <div className="font-mono text-xs font-bold text-teal-700">STEP 3</div>
                <h3 className="mt-1 text-sm font-bold text-slate-900">
                  Save Inside &ldquo;Bot &amp; Numbers&rdquo;
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-slate-600">
                  Open the <strong>Bot &amp; Numbers</strong> tab above, paste your Bot URL and the same <code className="font-mono">ADMIN_DASHBOARD_TOKEN</code>, and click <strong>Test &amp; Save Bot Link</strong>.
                </p>
                <button
                  type="button"
                  onClick={() => setTab('bot')}
                  className="mt-3 rounded-xl bg-teal-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-teal-700"
                >
                  Open Bot Link Form →
                </button>
              </div>
            </div>
          </section>
        )}
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
