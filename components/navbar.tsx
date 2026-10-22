'use client';

import {
  Activity,
  BookOpen,
  Command,
  LogOut,
  PlugZap,
  RefreshCw,
  Rocket,
  ShieldCheck,
} from 'lucide-react';
import { AuthUser } from '@/lib/types';

export type ActiveTab = 'control' | 'commands' | 'vault' | 'setup';

interface NavbarProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  user: AuthUser;
  botServerLinked: boolean;
  upstreamHost?: string | null;
  connected: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onOpenConnection: () => void;
  onOpenAccount: () => void;
  onSignOut: () => void;
}

const TABS: { id: ActiveTab; label: string; icon: typeof ShieldCheck }[] = [
  { id: 'control', label: 'Control Room', icon: ShieldCheck },
  { id: 'commands', label: 'Commands (21)', icon: Command },
  { id: 'vault', label: 'Vault & Media', icon: BookOpen },
  { id: 'setup', label: 'Vercel Setup', icon: Rocket },
];

export function Navbar({
  activeTab,
  onSelectTab,
  user,
  botServerLinked,
  upstreamHost,
  connected,
  refreshing,
  onRefresh,
  onOpenConnection,
  onOpenAccount,
  onSignOut,
}: NavbarProps) {
  return (
    <header className="sticky top-0 z-30 border-b border-line/80 bg-obsidian-950/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1180px] flex-wrap items-center justify-between gap-3 px-5 py-3.5">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-line-strong bg-obsidian-800 font-mono text-sm font-bold text-mint shadow-inner">
            ZF
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold tracking-tight text-[#f4f7fb]">
                ZaFar Control Room
              </span>
              <span className="rounded-full border border-line bg-obsidian-800 px-2 py-0.5 font-mono text-[10px] font-medium text-[#8d98aa]">
                v2.2
              </span>
            </div>
            <p className="text-xs text-[#8d98aa]">Verified Operations Portal</p>
          </div>
        </div>

        <nav
          aria-label="Primary navigation"
          className="order-3 flex w-full items-center gap-1 overflow-x-auto rounded-xl border border-line bg-obsidian-850 p-1 md:order-2 md:w-auto"
        >
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => onSelectTab(tab.id)}
                className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  active
                    ? 'bg-obsidian-700 text-[#f4f7fb] shadow-sm'
                    : 'text-[#8d98aa] hover:text-[#f4f7fb]'
                }`}
              >
                <Icon className={`h-3.5 w-3.5 ${active ? 'text-mint' : ''}`} />
                {tab.label}
              </button>
            );
          })}
        </nav>

        <div className="order-2 flex items-center gap-2 md:order-3">
          <button
            type="button"
            onClick={onOpenConnection}
            className="flex items-center gap-2 rounded-full border border-line bg-obsidian-800 px-3 py-1.5 text-xs font-medium text-[#d8e0ee] transition hover:border-line-strong hover:bg-obsidian-750"
          >
            <span
              className={`h-2 w-2 rounded-full ${
                botServerLinked && connected
                  ? 'bg-mint shadow-[0_0_8px_#77e0bd]'
                  : botServerLinked
                    ? 'bg-coral'
                    : 'bg-[#637085]'
              }`}
            />
            <span className="hidden sm:inline">
              {botServerLinked ? upstreamHost || 'Bot Server' : 'Link Bot URL'}
            </span>
            <PlugZap className="h-3.5 w-3.5 text-mint" />
          </button>

          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            title="Refresh live status"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-obsidian-800 text-[#8d98aa] transition hover:border-line-strong hover:text-[#f4f7fb] disabled:opacity-50"
          >
            {refreshing ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin text-mint" />
            ) : (
              <Activity className="h-3.5 w-3.5" />
            )}
          </button>

          <button
            type="button"
            onClick={onOpenAccount}
            title={user.email}
            className="flex items-center gap-2 rounded-full border border-line bg-obsidian-800 py-1 pl-1.5 pr-3 text-xs font-medium text-[#f4f7fb] transition hover:border-mint/50"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-mint-dim font-mono text-[10px] font-bold uppercase text-mint">
              {(user.name || user.email).slice(0, 2)}
            </span>
            <span className="max-w-[110px] truncate">{user.name}</span>
          </button>

          <button
            type="button"
            onClick={onSignOut}
            title="Sign out"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-obsidian-800 text-[#8d98aa] transition hover:border-coral/40 hover:text-coral"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </header>
  );
}
