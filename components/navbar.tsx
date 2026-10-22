'use client';

import {
  Activity,
  BookOpen,
  Command,
  KeyRound,
  RefreshCw,
  Rocket,
  ShieldCheck,
} from 'lucide-react';
import { ConnectionMode } from '@/lib/types';

export type ActiveTab = 'control' | 'commands' | 'vault' | 'setup';

interface NavbarProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  mode: ConnectionMode;
  upstreamHost?: string | null;
  connected: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onOpenConnection: () => void;
  hasToken: boolean;
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
  mode,
  upstreamHost,
  connected,
  refreshing,
  onRefresh,
  onOpenConnection,
  hasToken,
}: NavbarProps) {
  return (
    <header className="sticky top-0 z-30 border-b border-line/80 bg-obsidian-950/80 backdrop-blur-md">
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
            <p className="text-xs text-[#8d98aa]">Private WhatsApp Bot Operations</p>
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
                mode === 'live' && connected
                  ? 'bg-mint shadow-[0_0_8px_#77e0bd]'
                  : mode === 'live'
                    ? 'bg-coral'
                    : 'bg-amber-400'
              }`}
            />
            <span>
              {mode === 'live'
                ? upstreamHost || 'Live Bot'
                : 'Sandbox Mode'}
            </span>
            <KeyRound
              className={`h-3.5 w-3.5 ${hasToken ? 'text-mint' : 'text-[#8d98aa]'}`}
            />
          </button>

          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            title="Refresh bot telemetry"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-obsidian-800 text-[#8d98aa] transition hover:border-line-strong hover:text-[#f4f7fb] disabled:opacity-50"
          >
            {refreshing ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin text-mint" />
            ) : (
              <Activity className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>
    </header>
  );
}
