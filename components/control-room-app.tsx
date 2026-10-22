'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  PlugZap,
  Radio,
  ShieldCheck,
  Smartphone,
  Users,
} from 'lucide-react';
import {
  ApprovedUser,
  BotStatusPayload,
  ConnectionMode,
  PairCodePayload,
} from '@/lib/types';
import { ActiveTab, Navbar } from './navbar';
import { ConnectionDrawer, ConnectionSettings } from './connection-drawer';
import { AccessManager } from './access-manager';
import { MediaVaultDesk } from './media-vault-desk';
import { CommandDirectory } from './command-directory';
import { SetupGuide } from './setup-guide';

const STORAGE_KEY = 'zafar_control_room_settings_v1';

interface ControlRoomAppProps {
  defaultBotApiConfigured: boolean;
  defaultAdminEmail: string;
}

export function ControlRoomApp({
  defaultBotApiConfigured,
  defaultAdminEmail,
}: ControlRoomAppProps) {
  const [activeTab, setActiveTab] = useState<ActiveTab>('control');
  const [drawerOpen, setDrawerOpen] = useState(false);

  const [settings, setSettings] = useState<ConnectionSettings>({
    botApiUrl: '',
    token: '',
    useSandbox: !defaultBotApiConfigured,
  });
  const [hydrated, setHydrated] = useState(false);

  const [status, setStatus] = useState<BotStatusPayload>({
    ok: true,
    mode: defaultBotApiConfigured ? 'live' : 'sandbox',
    upstreamConfigured: defaultBotApiConfigured,
    upstreamHost: null,
    adminEmail: defaultAdminEmail,
    connected: false,
    botNumber: null,
    users: [],
  });

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyNumber, setBusyNumber] = useState<string | null>(null);
  const [activePair, setActivePair] = useState<PairCodePayload | null>(null);
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);

  const buildHeaders = useCallback((cfg: ConnectionSettings): HeadersInit => {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (cfg.useSandbox) {
      h['x-force-sandbox'] = '1';
    } else {
      if (cfg.botApiUrl) h['x-bot-api-url'] = cfg.botApiUrl;
      if (cfg.token) h['Authorization'] = `Bearer ${cfg.token}`;
    }
    return h;
  }, []);

  const fetchStatus = useCallback(
    async (cfg: ConnectionSettings, silent = false) => {
      if (!silent) setRefreshing(true);
      try {
        const res = await fetch('/api/admin/status', {
          headers: buildHeaders(cfg),
          cache: 'no-store',
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data?.error || `Request failed (${res.status})`);
        }
        setStatus(data);
        setNotice((prev) => (prev?.bad ? null : prev));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unable to reach bot API';
        setNotice({ text: message, bad: true });
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [buildHeaders],
  );

  useEffect(() => {
    let initial: ConnectionSettings = {
      botApiUrl: '',
      token: '',
      useSandbox: !defaultBotApiConfigured,
    };
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        initial = {
          botApiUrl: typeof parsed.botApiUrl === 'string' ? parsed.botApiUrl : '',
          token: typeof parsed.token === 'string' ? parsed.token : '',
          useSandbox:
            typeof parsed.useSandbox === 'boolean'
              ? parsed.useSandbox
              : !defaultBotApiConfigured && !parsed.botApiUrl,
        };
      }
    } catch {
      // ignore storage errors
    }
    setSettings(initial);
    setHydrated(true);
    void fetchStatus(initial);
  }, [defaultBotApiConfigured, fetchStatus]);

  useEffect(() => {
    if (!hydrated) return;
    const timer = setInterval(() => {
      void fetchStatus(settings, true);
    }, 15_000);
    return () => clearInterval(timer);
  }, [hydrated, settings, fetchStatus]);

  const handleSaveConnection = async (next: ConnectionSettings) => {
    setSettings(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
    await fetchStatus(next);
    setNotice({
      text: next.useSandbox
        ? 'Switched to interactive Sandbox Preview mode.'
        : 'Connection settings saved and synced.',
    });
  };

  const handleAddUser = async (number: string, label: string): Promise<boolean> => {
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: buildHeaders(settings),
        body: JSON.stringify({ number, label }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Could not add user');
      if (Array.isArray(data.users)) {
        setStatus((prev) => ({ ...prev, users: data.users as ApprovedUser[] }));
      } else {
        await fetchStatus(settings, true);
      }
      setNotice({ text: `Approved WhatsApp number +${number.replace(/\D/g, '')}.` });
      return true;
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Failed to approve user',
        bad: true,
      });
      return false;
    }
  };

  const handleToggleUser = async (number: string, enabled: boolean) => {
    setBusyNumber(number);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(number)}`, {
        method: 'PATCH',
        headers: buildHeaders(settings),
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to update access');
      await fetchStatus(settings, true);
      setNotice({
        text: enabled
          ? `Re-enabled access for +${number}.`
          : `Revoked access for +${number}.`,
      });
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Failed to update user',
        bad: true,
      });
    } finally {
      setBusyNumber(null);
    }
  };

  const handleRemoveUser = async (number: string) => {
    setBusyNumber(number);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(number)}`, {
        method: 'DELETE',
        headers: buildHeaders(settings),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to remove user');
      if (Array.isArray(data.users)) {
        setStatus((prev) => ({ ...prev, users: data.users as ApprovedUser[] }));
      } else {
        await fetchStatus(settings, true);
      }
      if (activePair?.number === number) setActivePair(null);
      setNotice({ text: `Removed +${number} from approved list.` });
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Failed to remove user',
        bad: true,
      });
    } finally {
      setBusyNumber(null);
    }
  };

  const handlePairUser = async (number: string) => {
    setBusyNumber(number);
    try {
      const res = await fetch('/api/admin/pair', {
        method: 'POST',
        headers: buildHeaders(settings),
        body: JSON.stringify({ number }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to request pairing code');
      setActivePair({
        ok: true,
        mode: (data.mode as ConnectionMode) || status.mode,
        code: data.code,
        expiresInSeconds: Number(data.expiresInSeconds) || 60,
        number,
        issuedAt: Date.now(),
      });
      setNotice({
        text: `Issued linking code for +${number} (valid for ${data.expiresInSeconds || 60}s).`,
      });
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Failed to issue pairing code',
        bad: true,
      });
    } finally {
      setBusyNumber(null);
    }
  };

  const enabledCount = status.users.filter((u) => u.enabled !== false).length;

  return (
    <div className="bg-control-grid min-h-screen">
      <Navbar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        mode={status.mode}
        upstreamHost={status.upstreamHost}
        connected={status.connected}
        refreshing={refreshing}
        onRefresh={() => fetchStatus(settings)}
        onOpenConnection={() => setDrawerOpen(true)}
        hasToken={Boolean(settings.token)}
      />

      <main className="mx-auto max-w-[1180px] px-5 pb-16 pt-8">
        {/* Hero Header */}
        <section className="mb-7 flex flex-wrap items-start justify-between gap-5">
          <div>
            <div className="inline-flex items-center gap-2 text-xs font-extrabold uppercase tracking-[0.15em] text-mint">
              <span>ZaFar / Private Control Room</span>
              {status.latencyMs !== undefined && status.mode === 'live' && (
                <span className="rounded bg-mint-dim px-1.5 py-0.5 font-mono text-[10px] tracking-normal text-mint">
                  {status.latencyMs}ms
                </span>
              )}
            </div>
            <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-[#f4f7fb] sm:text-5xl">
              Keep the bot in your hands.
            </h1>
            <p className="mt-2.5 max-w-[650px] text-sm leading-relaxed text-[#8d98aa] sm:text-base">
              Approve WhatsApp numbers, issue short-lived linking codes, and monitor live socket operations without exposing session credentials.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <div className="rounded-full border border-line bg-obsidian-800/90 px-3.5 py-2 text-xs text-[#8d98aa]">
              Admin: <span className="font-medium text-[#dce4f2]">{status.adminEmail}</span>
            </div>
            {status.mode === 'sandbox' && (
              <button
                type="button"
                onClick={() => setDrawerOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-full border border-mint/40 bg-mint-dim/70 px-3.5 py-2 text-xs font-semibold text-mint transition hover:brightness-110"
              >
                <PlugZap className="h-3.5 w-3.5" />
                Connect Live Bot API
              </button>
            )}
          </div>
        </section>

        {/* Notice Toast Bar */}
        {notice && (
          <div
            role="status"
            className={`mb-5 flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-xs font-medium ${
              notice.bad
                ? 'border-coral/40 bg-coral-dim/50 text-[#ffc2c7]'
                : 'border-mint/35 bg-mint-dim/50 text-mint'
            }`}
          >
            <div className="flex items-center gap-2">
              {notice.bad ? (
                <AlertCircle className="h-4 w-4 shrink-0 text-coral" />
              ) : (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-mint" />
              )}
              <span>{notice.text}</span>
            </div>
            <button
              type="button"
              onClick={() => setNotice(null)}
              className="text-[11px] underline opacity-80 hover:opacity-100"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Live Telemetry Cards */}
        <section
          aria-label="Bot telemetry summary"
          className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3"
        >
          <div className="rounded-2xl border border-line bg-[#0c1017] p-4 sm:p-5">
            <div className="flex items-center justify-between text-xs text-[#8d98aa]">
              <span>Socket Connection</span>
              <Radio
                className={`h-4 w-4 ${
                  status.connected ? 'text-mint' : 'text-coral'
                }`}
              />
            </div>
            <div className="mt-2 flex items-baseline gap-2.5">
              <b className="text-2xl font-bold text-[#f4f7fb]">
                {loading ? 'Syncing…' : status.connected ? 'Online' : 'Offline'}
              </b>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                  status.mode === 'live'
                    ? 'bg-mint-dim text-mint'
                    : 'bg-amber-500/15 text-amber-300'
                }`}
              >
                {status.mode === 'live' ? 'Live' : 'Sandbox'}
              </span>
            </div>
          </div>

          <div className="rounded-2xl border border-line bg-[#0c1017] p-4 sm:p-5">
            <div className="flex items-center justify-between text-xs text-[#8d98aa]">
              <span>Linked Bot Number</span>
              <Smartphone className="h-4 w-4 text-mint" />
            </div>
            <b className="mt-2 block font-mono text-2xl font-bold text-[#f4f7fb] tabular-nums">
              {status.botNumber ? `+${status.botNumber}` : '—'}
            </b>
          </div>

          <div className="rounded-2xl border border-line bg-[#0c1017] p-4 sm:p-5">
            <div className="flex items-center justify-between text-xs text-[#8d98aa]">
              <span>Approved Users</span>
              <Users className="h-4 w-4 text-mint" />
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <b className="font-mono text-2xl font-bold text-[#f4f7fb] tabular-nums">
                {enabledCount}
              </b>
              <span className="text-xs text-[#8d98aa]">
                enabled of {status.users.length} total
              </span>
            </div>
          </div>
        </section>

        {/* Active Workspace View */}
        {activeTab === 'control' && (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.2fr_0.8fr]">
            <AccessManager
              users={status.users}
              busyNumber={busyNumber}
              activePair={activePair}
              onDismissPair={() => setActivePair(null)}
              onAddUser={handleAddUser}
              onToggleUser={handleToggleUser}
              onRemoveUser={handleRemoveUser}
              onPairUser={handlePairUser}
            />
            <MediaVaultDesk
              compact
              onExploreAll={() => setActiveTab('vault')}
            />
          </div>
        )}

        {activeTab === 'commands' && <CommandDirectory />}
        {activeTab === 'vault' && <MediaVaultDesk />}
        {activeTab === 'setup' && <SetupGuide />}

        <footer className="mt-12 flex flex-wrap items-center justify-between gap-3 border-t border-line/70 pt-6 text-xs text-[#6f7b8e]">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-mint" />
            <span>ZaFar Control Room · Standalone Next.js Frontend Branch</span>
          </div>
          <div>
            Bot engine branches remain untouched on <code className="font-mono text-[#9fb0c5]">main</code>
          </div>
        </footer>
      </main>

      <ConnectionDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        settings={settings}
        defaultBotApiConfigured={defaultBotApiConfigured}
        currentMode={status.mode}
        onSave={handleSaveConnection}
      />
    </div>
  );
}
