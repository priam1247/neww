'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
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
import { LiveAnalytics } from './live-analytics';

type AdminTab = 'server' | 'members';
type MemberFilter = 'all' | 'allowed' | 'disallowed';

export function AdminConsole() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [quota, setQuota] = useState<UserQuota | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);

  const [tab, setTab] = useState<AdminTab>('server');
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
  const [botSyncTokenInput, setBotSyncTokenInput] = useState('');
  const [showBotToken, setShowBotToken] = useState(false);
  const [savingBot, setSavingBot] = useState(false);

  // Hydrodactyl / Pterodactyl Panel Control state
  const [panelUrlInput, setPanelUrlInput] = useState('https://panel.xsystemshosting.com');
  const [panelServerIdInput, setPanelServerIdInput] = useState('');
  const [panelKeyInput, setPanelKeyInput] = useState('');
  const [showPanelKey, setShowPanelKey] = useState(false);
  const [savingPanel, setSavingPanel] = useState(false);
  const [sendingPower, setSendingPower] = useState<string | null>(null);

  const [numInput, setNumInput] = useState('');
  const [numLabel, setNumLabel] = useState('');
  const [addingNumber, setAddingNumber] = useState(false);
  const [busyNumber, setBusyNumber] = useState<string | null>(null);
  const [confirmDeleteNum, setConfirmDeleteNum] = useState<string | null>(null);
  const [activePair, setActivePair] = useState<PairCodePayload | null>(null);

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
        if (!res.ok) throw new Error(json.error || 'Failed to load server status');
        setData(json);
        if (hydrateInputs) {
          setBotUrlInput(json.botApiUrl || '');
          setBotTokenInput(json.hasBotToken ? '••••••••' : '');
          setBotSyncTokenInput(json.hasBotSyncToken ? '••••••••' : '');
          setPanelUrlInput(json.panelUrl || 'https://panel.xsystemshosting.com');
          setPanelServerIdInput(json.panelServerId || '');
          setPanelKeyInput(json.hasPanelApiKey ? '••••••••' : '');
        }
      } catch (err) {
        setNotice({
          text: err instanceof Error ? err.message : 'Unable to fetch status',
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
    }, 10_000);
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
      setNotice({ text: `Allowed ${newMemberEmail.trim().toLowerCase()}` });
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
        text: allowed ? `Allowed ${email}` : `Disallowed ${email}`,
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
          botSyncToken: botSyncTokenInput.trim(),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Failed to save sync settings');

      await loadOverview(true, false);
      if (json.probe?.reachable) {
        setNotice({
          text: `Sync verified (${json.probe.connected ? 'ONLINE' : 'STANDBY'})`,
        });
      } else {
        setNotice({ text: 'Sync settings saved.' });
      }
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Failed to save sync settings',
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
      if (!res.ok) throw new Error(json?.error || 'Failed to toggle access');
      setData((prev) => ({ ...prev, botEnabledForMembers: nextState }));
      setNotice({
        text: nextState ? 'Member access enabled.' : 'Member access paused.',
      });
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Could not update access',
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
      setNotice({ text: `Approved +${numInput.replace(/\D/g, '')}` });
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
        text: enabled ? `Allowed +${number}` : `Disallowed +${number}`,
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
      setNotice({ text: `Removed +${number}` });
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Failed to remove number',
        bad: true,
      });
    } finally {
      setBusyNumber(null);
    }
  };

  const handleSavePanel = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingPanel(true);
    try {
      const res = await fetch('/api/admin/panel', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          action: 'save_and_discover',
          panelUrl: panelUrlInput.trim(),
          panelServerId: panelServerIdInput.trim(),
          panelApiKey: panelKeyInput.trim(),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Could not save panel settings');
      if (json.panelServerId) setPanelServerIdInput(json.panelServerId);
      if (json.hasPanelApiKey) setPanelKeyInput('••••••••');
      await loadOverview(true, false);

      if (json.discoveryOk) {
        const names = (json.servers || [])
          .map((s: { name: string; id: string }) => `${s.name} (${s.id})`)
          .join(', ');
        setNotice({
          text: `Panel verified: ${names || json.panelServerId || 'OK'}`,
        });
      } else if (json.discoveryError) {
        setNotice({
          text: `Saved (${json.discoveryError})`,
          bad: true,
        });
      } else {
        setNotice({ text: 'Panel saved.' });
      }
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Failed to save panel settings',
        bad: true,
      });
    } finally {
      setSavingPanel(false);
    }
  };

  const handlePanelPower = async (signal: 'restart' | 'start' | 'stop') => {
    setSendingPower(signal);
    try {
      const res = await fetch('/api/admin/panel', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ action: 'power', signal }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || `Could not ${signal} bot`);
      setNotice({ text: json.message || `Signal sent: ${signal}` });
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Power command failed',
        bad: true,
      });
    } finally {
      setSendingPower(null);
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

      if (json.pending && json.requestId) {
        setNotice({ text: `Requesting code for +${number}…` });
        const deadline = Date.now() + 26_000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1500));
          const pollRes = await fetch(
            `/api/admin/pair?requestId=${encodeURIComponent(json.requestId)}`,
            { headers: authHeaders(), cache: 'no-store' },
          );
          const pollJson = await pollRes.json();
          if (!pollRes.ok) {
            throw new Error(pollJson?.error || 'Pairing failed.');
          }
          if (!pollJson.pending && pollJson.code) {
            setActivePair({
              ok: true,
              code: pollJson.code,
              expiresInSeconds: Number(pollJson.expiresInSeconds) || 60,
              number,
              issuedAt: Date.now(),
            });
            setNotice({ text: `Code issued for +${number}` });
            return;
          }
        }
        throw new Error('Timed out waiting for bot.');
      }

      setActivePair({
        ok: true,
        code: json.code,
        expiresInSeconds: Number(json.expiresInSeconds) || 60,
        number,
        issuedAt: Date.now(),
      });
      setNotice({ text: `Code issued for +${number}` });
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Failed to request code',
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
      setNotice({ text: 'Display name updated.' });
    }
  };

  const handleSignOut = async () => {
    await performSignOut();
    router.replace('/login');
  };

  if (checking || !user) {
    return (
      <div className="bg-portal-canvas flex min-h-screen items-center justify-center px-4">
        <div className="flex items-center gap-2.5 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-xs font-semibold text-slate-700 shadow-sm">
          <Loader2 className="h-4 w-4 animate-spin text-teal-600" />
          Connecting…
        </div>
      </div>
    );
  }

  const allowedMembersCount = data.members.filter((m) => m.allowed).length;
  const enabledNumbersCount = data.users.filter((u) => u.enabled).length;

  return (
    <div className="bg-portal-canvas min-h-screen w-full overflow-x-hidden">
      {/* Top Server Console Bar */}
      <header className="sticky top-0 z-30 border-b border-slate-200/90 bg-white/95 backdrop-blur-md">
        <div className="mx-auto max-w-[1140px] px-3.5 py-2.5 sm:px-5 sm:py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-teal-600 font-mono text-xs font-extrabold text-white shadow-sm">
                ZF
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-bold text-slate-900">
                    ZaFar Server
                  </span>
                  <span className="shrink-0 rounded bg-teal-50 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase text-teal-700 ring-1 ring-teal-200">
                    ROOT
                  </span>
                </div>
                <div className="truncate font-mono text-[10px] text-slate-500">
                  {data.storageEngine}
                  {data.botVersion ? ` · v${data.botVersion}` : ''}
                </div>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              <Link
                href="/dashboard"
                title="Member View"
                className="inline-flex h-8 items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 px-2.5 text-xs font-semibold text-slate-700 transition hover:border-teal-300 hover:bg-teal-50 hover:text-teal-800"
              >
                <span className="hidden sm:inline">Portal</span>
                <ExternalLink className="h-3.5 w-3.5" />
              </Link>

              <button
                type="button"
                onClick={() => loadOverview(false, false)}
                disabled={refreshing}
                title="Refresh"
                className="flex h-8 w-8 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
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
                className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-800 shadow-sm transition hover:border-teal-300"
              >
                <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-teal-600 font-mono text-[10px] font-bold uppercase text-white">
                  {(user.name || user.email).slice(0, 2)}
                </span>
                <span className="hidden max-w-[96px] truncate sm:inline">
                  {user.name}
                </span>
              </button>

              <button
                type="button"
                onClick={handleSignOut}
                title="Sign out"
                className="flex h-8 w-8 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600"
              >
                <LogOut className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <nav
            aria-label="Server sections"
            className="mt-2.5 grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1"
          >
            <button
              type="button"
              onClick={() => setTab('server')}
              className={`flex min-w-0 items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${
                tab === 'server'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Server
                className={`h-3.5 w-3.5 shrink-0 ${tab === 'server' ? 'text-teal-600' : ''}`}
              />
              <span className="truncate">
                Server &amp; Numbers ({enabledNumbersCount}/{data.users.length})
              </span>
            </button>

            <button
              type="button"
              onClick={() => setTab('members')}
              className={`flex min-w-0 items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${
                tab === 'members'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Users
                className={`h-3.5 w-3.5 shrink-0 ${tab === 'members' ? 'text-teal-600' : ''}`}
              />
              <span className="truncate">
                Members ({allowedMembersCount}/{data.members.length})
              </span>
            </button>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-[1140px] px-3.5 pb-14 pt-4 sm:px-5 sm:pt-6">
        {/* Live Server Analytics: Commands, Successful Downloads, Failed, Uptime + RAM/Disk/Queues */}
        <LiveAnalytics
          reachable={data.botReachable}
          connected={data.connected}
          botNumber={data.botNumber}
          lastSeenSecondsAgo={data.lastSeenSecondsAgo}
          uptimeSeconds={data.uptimeSeconds}
          commandsTotal={data.commandsTotal}
          downloadsSuccess={data.downloadsSuccess}
          failedTotal={data.failedTotal}
          ramUsedMB={data.ramUsedMB}
          diskUsedMB={data.diskUsedMB}
          diskBudgetMB={data.diskBudgetMB}
          queueLight={data.queueLight}
          queueHeavy={data.queueHeavy}
          showResources
        />

        {/* Quick Server Operations Bar (Power + Member Gate) */}
        <section className="mb-5 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm sm:px-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              disabled={sendingPower !== null}
              onClick={() => handlePanelPower('restart')}
              className="inline-flex items-center gap-1.5 rounded-xl bg-teal-600 px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:opacity-50"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${sendingPower === 'restart' ? 'animate-spin' : ''}`}
              />
              {sendingPower === 'restart' ? 'Restarting…' : 'Restart'}
            </button>

            <button
              type="button"
              disabled={sendingPower !== null}
              onClick={() => handlePanelPower('start')}
              className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 transition hover:bg-emerald-100 disabled:opacity-50"
            >
              {sendingPower === 'start' ? 'Starting…' : 'Start'}
            </button>

            <button
              type="button"
              disabled={sendingPower !== null}
              onClick={() => handlePanelPower('stop')}
              className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 transition hover:bg-rose-100 disabled:opacity-50"
            >
              {sendingPower === 'stop' ? 'Stopping…' : 'Stop'}
            </button>
          </div>

          <button
            type="button"
            onClick={handleToggleGlobalBot}
            className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-bold transition ${
              data.botEnabledForMembers
                ? 'border-teal-200 bg-teal-50 text-teal-800 hover:bg-teal-100'
                : 'border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100'
            }`}
          >
            <Power className="h-3.5 w-3.5 shrink-0" />
            <span>
              Members: {data.botEnabledForMembers ? 'ACTIVE' : 'PAUSED'}
            </span>
          </button>
        </section>

        {notice && (
          <div
            role="status"
            className={`mb-4 flex items-center justify-between gap-2 rounded-xl border px-3.5 py-2.5 text-xs font-medium ${
              notice.bad
                ? 'border-rose-200 bg-rose-50 text-rose-800'
                : 'border-teal-200 bg-teal-50 text-teal-900'
            }`}
          >
            <div className="flex min-w-0 items-center gap-2">
              {notice.bad ? (
                <AlertCircle className="h-4 w-4 shrink-0 text-rose-600" />
              ) : (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-teal-600" />
              )}
              <span className="min-w-0 break-words">{notice.text}</span>
            </div>
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="shrink-0 text-[11px] font-semibold underline"
            >
              Close
            </button>
          </div>
        )}

        {/* TAB 1: SERVER & WHATSAPP NUMBERS */}
        {tab === 'server' && (
          <div className="space-y-4">
            {/* Approved WhatsApp Numbers */}
            <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-bold text-slate-900 sm:text-base">
                  WhatsApp Numbers
                </h2>
                <span className="font-mono text-xs text-slate-500 tabular-nums">
                  {enabledNumbersCount} active / {data.users.length} total
                </span>
              </div>

              <form
                onSubmit={handleAddNumber}
                className="mt-3.5 grid grid-cols-1 gap-2.5 sm:grid-cols-[1.1fr_1fr_auto] sm:items-end"
              >
                <div className="min-w-0">
                  <label
                    htmlFor="admin-add-num"
                    className="mb-1 block text-xs font-medium text-slate-700"
                  >
                    Number
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
                <div className="min-w-0">
                  <label
                    htmlFor="admin-add-label"
                    className="mb-1 block text-xs font-medium text-slate-700"
                  >
                    Label
                  </label>
                  <input
                    id="admin-add-label"
                    type="text"
                    value={numLabel}
                    onChange={(e) => setNumLabel(e.target.value)}
                    placeholder="Operator"
                    className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                  />
                </div>
                <button
                  type="submit"
                  disabled={addingNumber}
                  className="inline-flex h-[42px] items-center justify-center gap-1.5 rounded-xl bg-teal-600 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:opacity-60"
                >
                  <Plus className="h-4 w-4" />
                  {addingNumber ? 'Adding…' : 'Approve'}
                </button>
              </form>

              <div className="mt-4">
                <PairingCodeBanner
                  activePair={activePair}
                  onDismiss={() => setActivePair(null)}
                />
              </div>

              <div className="mt-2 divide-y divide-slate-100">
                {data.users.length === 0 ? (
                  <p className="py-6 text-center font-mono text-xs text-slate-400">
                    No numbers approved
                  </p>
                ) : (
                  data.users.map((u) => {
                    const busy = busyNumber === u.number;
                    const confirming = confirmDeleteNum === u.number;
                    return (
                      <div
                        key={u.number}
                        className="flex flex-col gap-2.5 py-3.5 sm:flex-row sm:items-center sm:justify-between"
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-sm font-bold text-slate-900 tabular-nums">
                              +{u.number}
                            </span>
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                                u.enabled
                                  ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                                  : 'bg-rose-50 text-rose-700 ring-1 ring-rose-200'
                              }`}
                            >
                              {u.enabled ? 'Allowed' : 'Blocked'}
                            </span>
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                            <span className="truncate">{u.label || 'Approved'}</span>
                            {u.addedBy && (
                              <>
                                <span>·</span>
                                <span className="break-all font-mono text-[11px] text-slate-600">
                                  {u.addedBy}
                                </span>
                              </>
                            )}
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            disabled={!u.enabled || busy}
                            onClick={() => handlePairNumber(u.number)}
                            className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-semibold text-slate-800 transition hover:border-teal-300 hover:bg-teal-50 hover:text-teal-800 disabled:opacity-40"
                          >
                            <Link2 className="h-3.5 w-3.5 text-teal-600" />
                            Code
                          </button>

                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => handleToggleNumber(u.number, !u.enabled)}
                            className={`rounded-xl px-2.5 py-1.5 text-xs font-semibold transition ${
                              u.enabled
                                ? 'border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100'
                                : 'bg-teal-600 text-white hover:bg-teal-700'
                            }`}
                          >
                            {u.enabled ? 'Block' : 'Allow'}
                          </button>

                          {confirming ? (
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => handleDeleteNumber(u.number)}
                                className="rounded-xl bg-rose-600 px-2.5 py-1.5 text-xs font-semibold text-white"
                              >
                                Confirm
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteNum(null)}
                                className="rounded-xl bg-slate-100 px-2.5 py-1.5 text-xs font-medium text-slate-600"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteNum(u.number)}
                              className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-rose-600 hover:border-rose-200 hover:bg-rose-50"
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

            {/* Bot Sync & Hydrodactyl Credentials Rack */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
                    <Server className="h-4 w-4 text-teal-600" />
                    Bot Sync Bridge
                  </h2>
                  <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase text-slate-600">
                    {data.connectionMode || 'sync'}
                  </span>
                </div>

                <form onSubmit={handleSaveBotConfig} className="mt-3.5 space-y-3">
                  <div className="min-w-0">
                    <label
                      htmlFor="admin-bot-sync-token"
                      className="mb-1 block font-mono text-[11px] font-semibold text-slate-600"
                    >
                      BOT_SYNC_TOKEN
                    </label>
                    <div className="relative">
                      <input
                        id="admin-bot-sync-token"
                        type={showBotToken ? 'text' : 'password'}
                        value={botSyncTokenInput}
                        onChange={(e) => setBotSyncTokenInput(e.target.value)}
                        placeholder="Sync token"
                        className="w-full rounded-xl border border-slate-300 bg-white py-2 pl-3 pr-9 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
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

                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    <div className="min-w-0">
                      <label
                        htmlFor="admin-bot-url"
                        className="mb-1 block font-mono text-[11px] font-semibold text-slate-600"
                      >
                        INBOUND_URL (optional)
                      </label>
                      <input
                        id="admin-bot-url"
                        type="url"
                        value={botUrlInput}
                        onChange={(e) => setBotUrlInput(e.target.value)}
                        placeholder="Blank = outbound"
                        className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                      />
                    </div>

                    <div className="min-w-0">
                      <label
                        htmlFor="admin-bot-token"
                        className="mb-1 block font-mono text-[11px] font-semibold text-slate-600"
                      >
                        ADMIN_DASHBOARD_TOKEN
                      </label>
                      <input
                        id="admin-bot-token"
                        type={showBotToken ? 'text' : 'password'}
                        value={botTokenInput}
                        onChange={(e) => setBotTokenInput(e.target.value)}
                        placeholder="Optional"
                        className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={savingBot}
                    className="inline-flex h-[38px] w-full items-center justify-center rounded-xl bg-teal-600 px-4 text-xs font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:opacity-60 sm:w-auto"
                  >
                    {savingBot ? 'Saving…' : 'Save Sync'}
                  </button>
                </form>
              </section>

              <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900">
                    <Power className="h-4 w-4 text-teal-600" />
                    Panel API
                  </h2>
                  <span
                    className={`rounded px-2 py-0.5 font-mono text-[10px] font-semibold uppercase ${
                      data.panelConfigured
                        ? 'bg-emerald-50 text-emerald-700'
                        : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {data.panelConfigured ? 'Configured' : 'Unset'}
                  </span>
                </div>

                <form onSubmit={handleSavePanel} className="mt-3.5 space-y-3">
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-[1.3fr_0.7fr]">
                    <div className="min-w-0">
                      <label
                        htmlFor="admin-panel-url"
                        className="mb-1 block font-mono text-[11px] font-semibold text-slate-600"
                      >
                        PANEL_URL
                      </label>
                      <input
                        id="admin-panel-url"
                        type="url"
                        value={panelUrlInput}
                        onChange={(e) => setPanelUrlInput(e.target.value)}
                        placeholder="https://panel.xsystemshosting.com"
                        className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                      />
                    </div>

                    <div className="min-w-0">
                      <label
                        htmlFor="admin-panel-sid"
                        className="mb-1 block font-mono text-[11px] font-semibold text-slate-600"
                      >
                        SERVER_ID
                      </label>
                      <input
                        id="admin-panel-sid"
                        type="text"
                        value={panelServerIdInput}
                        onChange={(e) => setPanelServerIdInput(e.target.value)}
                        placeholder="Auto"
                        className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                      />
                    </div>
                  </div>

                  <div className="min-w-0">
                    <label
                      htmlFor="admin-panel-key"
                      className="mb-1 block font-mono text-[11px] font-semibold text-slate-600"
                    >
                      PANEL_API_KEY (hydro_ / ptlc_)
                    </label>
                    <div className="relative">
                      <input
                        id="admin-panel-key"
                        type={showPanelKey ? 'text' : 'password'}
                        value={panelKeyInput}
                        onChange={(e) => setPanelKeyInput(e.target.value)}
                        placeholder="API key"
                        className="w-full rounded-xl border border-slate-300 bg-white py-2 pl-3 pr-9 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPanelKey((s) => !s)}
                        aria-label={showPanelKey ? 'Hide API key' : 'Show API key'}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
                      >
                        {showPanelKey ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={savingPanel}
                    className="inline-flex h-[38px] w-full items-center justify-center rounded-xl border border-teal-600 bg-teal-50 px-4 text-xs font-semibold text-teal-800 transition hover:bg-teal-100 disabled:opacity-60 sm:w-auto"
                  >
                    {savingPanel ? 'Verifying…' : 'Verify & Save Panel'}
                  </button>
                </form>
              </section>
            </div>
          </div>
        )}

        {/* TAB 2: MEMBERS ACCESS CONTROL */}
        {tab === 'members' && (
          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900 sm:text-base">
                <UserCheck className="h-4 w-4 text-teal-600" />
                Members
              </h2>

              <div className="flex items-center gap-1 rounded-xl bg-slate-100 p-1 text-xs">
                {(['all', 'allowed', 'disallowed'] as MemberFilter[]).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setMemberFilter(f)}
                    className={`rounded-lg px-2.5 py-1 font-semibold capitalize transition ${
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

            <form
              onSubmit={handleAddMember}
              className="mt-3.5 grid grid-cols-1 gap-2.5 rounded-xl border border-slate-200 bg-slate-50/70 p-3 sm:grid-cols-[1.2fr_1fr_auto] sm:items-end"
            >
              <div className="min-w-0">
                <label
                  htmlFor="add-member-email"
                  className="mb-1 block text-xs font-medium text-slate-700"
                >
                  Email
                </label>
                <input
                  id="add-member-email"
                  type="email"
                  required
                  value={newMemberEmail}
                  onChange={(e) => setNewMemberEmail(e.target.value)}
                  placeholder="member@gmail.com"
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                />
              </div>
              <div className="min-w-0">
                <label
                  htmlFor="add-member-name"
                  className="mb-1 block text-xs font-medium text-slate-700"
                >
                  Name
                </label>
                <input
                  id="add-member-name"
                  type="text"
                  value={newMemberName}
                  onChange={(e) => setNewMemberName(e.target.value)}
                  placeholder="Optional"
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:outline-none"
                />
              </div>
              <button
                type="submit"
                disabled={addingMember}
                className="inline-flex h-[38px] items-center justify-center gap-1.5 rounded-xl bg-teal-600 px-4 text-xs font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:opacity-60"
              >
                <UserPlus className="h-4 w-4" />
                {addingMember ? 'Saving…' : 'Allow'}
              </button>
            </form>

            <div className="relative mt-3.5">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="search"
                value={memberSearch}
                onChange={(e) => setMemberSearch(e.target.value)}
                placeholder="Filter members…"
                className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-xs text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:bg-white focus:outline-none"
              />
            </div>

            <div className="mt-3 divide-y divide-slate-100">
              {filteredMembers.length === 0 ? (
                <p className="py-8 text-center font-mono text-xs text-slate-400">
                  No members found
                </p>
              ) : (
                filteredMembers.map((member) => {
                  const busy = busyEmail === member.email;
                  return (
                    <div
                      key={member.email}
                      className="flex flex-col gap-2.5 py-3.5 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-bold text-slate-900">
                            {member.name}
                          </span>
                          {member.isAdmin ? (
                            <span className="rounded-full bg-teal-50 px-2 py-0.5 text-[10px] font-bold uppercase text-teal-800 ring-1 ring-teal-200">
                              Root
                            </span>
                          ) : member.allowed ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-700 ring-1 ring-emerald-200">
                              <ShieldCheck className="h-3 w-3" />
                              Allowed
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-bold uppercase text-rose-700 ring-1 ring-rose-200">
                              <ShieldBan className="h-3 w-3" />
                              Blocked
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                          <span className="break-all font-mono text-slate-700">
                            {member.email}
                          </span>
                          <span>·</span>
                          <span>{member.numbersCount} num</span>
                        </div>
                      </div>

                      <div className="shrink-0">
                        {member.isAdmin ? (
                          <span className="font-mono text-[11px] font-semibold text-slate-400">
                            Owner
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
                            className={`rounded-xl px-3.5 py-1.5 text-xs font-semibold transition disabled:opacity-50 ${
                              member.allowed
                                ? 'border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100'
                                : 'bg-teal-600 text-white hover:bg-teal-700'
                            }`}
                          >
                            {busy
                              ? 'Saving…'
                              : member.allowed
                                ? 'Block'
                                : 'Allow'}
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
