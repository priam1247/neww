'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Database,
  Loader2,
  PlugZap,
  Radio,
  ShieldCheck,
  Smartphone,
  Users,
} from 'lucide-react';
import {
  ApprovedUser,
  AuthUser,
  BotStatusPayload,
  PairCodePayload,
  UserQuota,
} from '@/lib/types';
import { ActiveTab, Navbar } from './navbar';
import { ConnectionDrawer, ConnectionSettings } from './connection-drawer';
import { AccessManager } from './access-manager';
import { MediaVaultDesk } from './media-vault-desk';
import { CommandDirectory } from './command-directory';
import { SetupGuide } from './setup-guide';
import { AuthScreen } from './auth-screen';
import { AccountModal } from './account-modal';

const BOT_SETTINGS_KEY = 'zafar_bot_connection_v2';
const AUTH_TOKEN_KEY = 'zafar_session_token_v1';

interface ControlRoomAppProps {
  defaultBotApiConfigured: boolean;
  defaultAdminEmail: string;
}

export function ControlRoomApp({
  defaultBotApiConfigured,
  defaultAdminEmail,
}: ControlRoomAppProps) {
  const [authChecking, setAuthChecking] = useState(true);
  const [authToken, setAuthToken] = useState<string>('');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [quota, setQuota] = useState<UserQuota | null>(null);

  const [activeTab, setActiveTab] = useState<ActiveTab>('control');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);

  const [settings, setSettings] = useState<ConnectionSettings>({
    botApiUrl: '',
    token: '',
  });

  const [status, setStatus] = useState<BotStatusPayload>({
    ok: true,
    botServerLinked: defaultBotApiConfigured,
    storageEngine: 'persistent-db',
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

  const buildHeaders = useCallback(
    (cfg: ConnectionSettings, sessionTok: string): HeadersInit => {
      const h: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (sessionTok) {
        h['x-session-token'] = sessionTok;
        h['Authorization'] = `Bearer ${sessionTok}`;
      }
      if (cfg.botApiUrl) h['x-bot-api-url'] = cfg.botApiUrl;
      if (cfg.token) h['x-admin-token'] = cfg.token;
      return h;
    },
    [],
  );

  const fetchStatus = useCallback(
    async (cfg: ConnectionSettings, sessionTok: string, silent = false) => {
      if (!silent) setRefreshing(true);
      try {
        const res = await fetch('/api/admin/status', {
          headers: buildHeaders(cfg, sessionTok),
          cache: 'no-store',
        });
        const data = await res.json();
        if (res.status === 401 && !cfg.botApiUrl) {
          setUser(null);
          return;
        }
        if (!res.ok) {
          throw new Error(data?.error || `Request failed (${res.status})`);
        }
        setStatus(data);
        setNotice((prev) => (prev?.bad ? null : prev));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unable to fetch status';
        setNotice({ text: message, bad: true });
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [buildHeaders],
  );

  useEffect(() => {
    let savedBot: ConnectionSettings = { botApiUrl: '', token: '' };
    let savedToken = '';
    try {
      const rawBot = localStorage.getItem(BOT_SETTINGS_KEY);
      if (rawBot) {
        const parsed = JSON.parse(rawBot);
        savedBot = {
          botApiUrl: typeof parsed.botApiUrl === 'string' ? parsed.botApiUrl : '',
          token: typeof parsed.token === 'string' ? parsed.token : '',
        };
      }
      savedToken = localStorage.getItem(AUTH_TOKEN_KEY) || '';
    } catch {
      // ignore storage errors
    }

    setSettings(savedBot);
    setAuthToken(savedToken);

    (async () => {
      try {
        const headers: Record<string, string> = {};
        if (savedToken) {
          headers['x-session-token'] = savedToken;
          headers['Authorization'] = `Bearer ${savedToken}`;
        }
        const res = await fetch('/api/auth/me', {
          headers,
          cache: 'no-store',
        });
        if (res.ok) {
          const data = await res.json();
          setUser(data.user);
          setQuota(data.quota || null);
          await fetchStatus(savedBot, savedToken, true);
        } else if (savedToken) {
          try {
            localStorage.removeItem(AUTH_TOKEN_KEY);
          } catch {
            // ignore
          }
          setAuthToken('');
        }
      } catch {
        // stay on sign-in screen
      } finally {
        setAuthChecking(false);
        setLoading(false);
      }
    })();
  }, [fetchStatus]);

  useEffect(() => {
    if (!user) return;
    const timer = setInterval(() => {
      void fetchStatus(settings, authToken, true);
    }, 15_000);
    return () => clearInterval(timer);
  }, [user, settings, authToken, fetchStatus]);

  const handleAuthenticated = async (payload: { token: string; user: AuthUser }) => {
    setAuthToken(payload.token);
    setUser(payload.user);
    try {
      localStorage.setItem(AUTH_TOKEN_KEY, payload.token);
    } catch {
      // ignore
    }
    setLoading(true);
    await fetchStatus(settings, payload.token, true);
    // Fetch quota asynchronously if backed by zafar-backend
    fetch('/api/auth/me', {
      headers: {
        'x-session-token': payload.token,
        Authorization: `Bearer ${payload.token}`,
      },
      cache: 'no-store',
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.quota) setQuota(d.quota);
      })
      .catch(() => {});
  };

  const handleSignOut = async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    try {
      localStorage.removeItem(AUTH_TOKEN_KEY);
    } catch {
      // ignore
    }
    setAuthToken('');
    setUser(null);
    setQuota(null);
    setAccountOpen(false);
    setActivePair(null);
  };

  const handleUpdateProfileName = async (nextName: string) => {
    const res = await fetch('/api/auth/me', {
      method: 'PATCH',
      headers: buildHeaders(settings, authToken),
      body: JSON.stringify({ name: nextName }),
    });
    const data = await res.json();
    if (!res.ok) {
      setNotice({ text: data?.error || 'Could not update profile name', bad: true });
      return;
    }
    if (data.user) setUser(data.user);
    if (data.token) {
      setAuthToken(data.token);
      try {
        localStorage.setItem(AUTH_TOKEN_KEY, data.token);
      } catch {
        // ignore
      }
    }
    setNotice({ text: 'Updated your display name.' });
  };

  const handleSaveConnection = async (next: ConnectionSettings) => {
    setSettings(next);
    try {
      localStorage.setItem(BOT_SETTINGS_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
    await fetchStatus(next, authToken);
    setNotice({
      text: next.botApiUrl
        ? `Connected bot endpoint ${next.botApiUrl}.`
        : 'Saved connection settings.',
    });
  };

  const handleAddUser = async (number: string, label: string): Promise<boolean> => {
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: buildHeaders(settings, authToken),
        body: JSON.stringify({ number, label }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Could not add user');
      if (Array.isArray(data.users)) {
        setStatus((prev) => ({ ...prev, users: data.users as ApprovedUser[] }));
      } else {
        await fetchStatus(settings, authToken, true);
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
        headers: buildHeaders(settings, authToken),
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to update access');
      await fetchStatus(settings, authToken, true);
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
        headers: buildHeaders(settings, authToken),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to remove user');
      if (Array.isArray(data.users)) {
        setStatus((prev) => ({ ...prev, users: data.users as ApprovedUser[] }));
      } else {
        await fetchStatus(settings, authToken, true);
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
        headers: buildHeaders(settings, authToken),
        body: JSON.stringify({ number }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to request pairing code');
      setActivePair({
        ok: true,
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

  if (authChecking) {
    return (
      <div className="bg-control-grid flex min-h-screen items-center justify-center">
        <div className="flex items-center gap-3 rounded-2xl border border-line bg-obsidian-800 px-5 py-3.5 text-sm text-[#c8d3e6]">
          <Loader2 className="h-4 w-4 animate-spin text-mint" />
          Verifying session…
        </div>
      </div>
    );
  }

  if (!user) {
    return <AuthScreen onAuthenticated={handleAuthenticated} />;
  }

  const enabledCount = status.users.filter((u) => u.enabled !== false).length;

  return (
    <div className="bg-control-grid min-h-screen">
      <Navbar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        user={user}
        botServerLinked={status.botServerLinked}
        upstreamHost={status.upstreamHost}
        connected={status.connected}
        refreshing={refreshing}
        onRefresh={() => fetchStatus(settings, authToken)}
        onOpenConnection={() => setDrawerOpen(true)}
        onOpenAccount={() => setAccountOpen(true)}
        onSignOut={handleSignOut}
      />

      <main className="mx-auto max-w-[1180px] px-5 pb-16 pt-8">
        {/* Hero Header */}
        <section className="mb-7 flex flex-wrap items-start justify-between gap-5">
          <div>
            <div className="inline-flex items-center gap-2 text-xs font-extrabold uppercase tracking-[0.15em] text-mint">
              <span>Welcome back, {user.name}</span>
              {status.latencyMs !== undefined && status.botServerLinked && (
                <span className="rounded bg-mint-dim px-1.5 py-0.5 font-mono text-[10px] tracking-normal text-mint">
                  {status.latencyMs}ms
                </span>
              )}
            </div>
            <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-[#f4f7fb] sm:text-5xl">
              Keep the bot in your hands.
            </h1>
            <p className="mt-2.5 max-w-[650px] text-sm leading-relaxed text-[#8d98aa] sm:text-base">
              Manage approved WhatsApp numbers, request live linking codes, and access your verified ZaFar account tools from one secure workspace.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => setAccountOpen(true)}
              className="rounded-full border border-line bg-obsidian-800/90 px-3.5 py-2 text-xs text-[#8d98aa] transition hover:border-line-strong"
            >
              Signed in as <span className="font-medium text-[#dce4f2]">{user.email}</span>
            </button>
            {!status.botServerLinked && (
              <button
                type="button"
                onClick={() => setDrawerOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-full border border-mint/40 bg-mint-dim/70 px-3.5 py-2 text-xs font-semibold text-mint transition hover:brightness-110"
              >
                <PlugZap className="h-3.5 w-3.5" />
                Connect Bot Server
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
              <span>Bot Socket Status</span>
              <Radio
                className={`h-4 w-4 ${
                  status.connected ? 'text-mint' : 'text-[#6c788b]'
                }`}
              />
            </div>
            <div className="mt-2 flex items-baseline gap-2.5">
              <b className="text-2xl font-bold text-[#f4f7fb]">
                {loading
                  ? 'Checking…'
                  : status.botServerLinked
                    ? status.connected
                      ? 'Online'
                      : 'Disconnected'
                    : 'Not Linked'}
              </b>
              <span className="inline-flex items-center gap-1 rounded-full bg-obsidian-800 px-2.5 py-0.5 text-[10px] font-medium text-[#9fb0c5]">
                <Database className="h-2.5 w-2.5 text-mint" />
                {status.storageEngine === 'bot-live'
                  ? 'Live Bot'
                  : status.storageEngine === 'cloudflare-d1'
                    ? 'Cloudflare D1'
                    : 'Persistent DB'}
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
              <span>Approved Numbers</span>
              <Users className="h-4 w-4 text-mint" />
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <b className="font-mono text-2xl font-bold text-[#f4f7fb] tabular-nums">
                {enabledCount}
              </b>
              <span className="text-xs text-[#8d98aa]">
                enabled of {status.users.length} saved
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
            <span>ZaFar Control Room · Authenticated Workspace</span>
          </div>
          <div>
            Email Auth synced with <code className="font-mono text-[#9fb0c5]">zafar-backend</code>
          </div>
        </footer>
      </main>

      <ConnectionDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        settings={settings}
        defaultBotApiConfigured={defaultBotApiConfigured}
        botServerLinked={status.botServerLinked}
        onSave={handleSaveConnection}
      />

      <AccountModal
        open={accountOpen}
        onClose={() => setAccountOpen(false)}
        user={user}
        quota={quota}
        onUpdateName={handleUpdateProfileName}
        onSignOut={handleSignOut}
      />
    </div>
  );
}
