'use client';

import { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Cpu,
  HardDrive,
  Layers,
  Terminal,
} from 'lucide-react';

interface LiveAnalyticsProps {
  reachable?: boolean;
  connected?: boolean;
  botNumber?: string | null;
  lastSeenSecondsAgo?: number | null;
  uptimeSeconds?: number | null;
  commandsTotal?: number | null;
  downloadsSuccess?: number | null;
  failedTotal?: number | null;
  ramUsedMB?: number | null;
  diskUsedMB?: number | null;
  diskBudgetMB?: number | null;
  queueLight?: number | null;
  queueHeavy?: number | null;
  showResources?: boolean;
}

function formatUptime(totalSec: number | null | undefined, reachable?: boolean): string {
  if (!reachable || totalSec == null || totalSec <= 0) return 'Offline';
  const s = Math.max(0, Math.floor(totalSec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function LiveAnalytics({
  reachable = false,
  connected = false,
  botNumber = null,
  lastSeenSecondsAgo = null,
  uptimeSeconds = null,
  commandsTotal = 0,
  downloadsSuccess = 0,
  failedTotal = 0,
  ramUsedMB = null,
  diskUsedMB = null,
  diskBudgetMB = null,
  queueLight = null,
  queueHeavy = null,
  showResources = false,
}: LiveAnalyticsProps) {
  const [tickOffset, setTickOffset] = useState(0);

  useEffect(() => {
    setTickOffset(0);
    if (!reachable || !uptimeSeconds) return;
    const id = setInterval(() => {
      setTickOffset((t) => t + 1);
    }, 1000);
    return () => clearInterval(id);
  }, [reachable, uptimeSeconds, lastSeenSecondsAgo]);

  const liveUptime =
    reachable && uptimeSeconds != null ? uptimeSeconds + tickOffset : uptimeSeconds;
  const cmds = Math.max(0, Number(commandsTotal) || 0);
  const okCount = Math.max(0, Number(downloadsSuccess) || 0);
  const failCount = Math.max(0, Number(failedTotal) || 0);
  const totalJobs = okCount + failCount;
  const successRate =
    totalJobs > 0 ? Math.round((okCount / totalJobs) * 100) : null;

  const diskPct =
    diskUsedMB != null && diskBudgetMB && diskBudgetMB > 0
      ? Math.min(100, Math.round((diskUsedMB / diskBudgetMB) * 100))
      : null;

  return (
    <section
      aria-label="Live Server Analytics"
      className="mb-5 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
    >
      {/* Server Telemetry Header Strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-900 px-3.5 py-2.5 text-white sm:px-5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            {reachable && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            )}
            <span
              className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
                connected
                  ? 'bg-emerald-400'
                  : reachable
                    ? 'bg-amber-400'
                    : 'bg-rose-500'
              }`}
            />
          </span>
          <Activity className="h-3.5 w-3.5 shrink-0 text-teal-400" />
          <span className="truncate font-mono text-[11px] font-bold uppercase tracking-wider">
            Live Analytics
          </span>
          <span
            className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
              connected
                ? 'bg-emerald-500/20 text-emerald-300'
                : reachable
                  ? 'bg-amber-500/20 text-amber-300'
                  : 'bg-rose-500/20 text-rose-300'
            }`}
          >
            {connected ? 'ONLINE' : reachable ? 'STANDBY' : 'OFFLINE'}
          </span>
        </div>

        <div className="flex min-w-0 items-center gap-2.5 font-mono text-[11px] text-slate-300 tabular-nums">
          {botNumber && <span className="truncate">+{botNumber}</span>}
          {lastSeenSecondsAgo != null && (
            <span className="text-slate-400">
              sync {Math.max(0, lastSeenSecondsAgo)}s
            </span>
          )}
        </div>
      </div>

      {/* 4 Core Live Counters: Commands, Successful Downloads, Failed, Uptime */}
      <div className="grid grid-cols-2 divide-x divide-y divide-slate-100 sm:grid-cols-4 sm:divide-y-0">
        <div className="min-w-0 p-3.5 sm:p-4">
          <div className="flex items-center justify-between gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            <span className="truncate">Commands</span>
            <Terminal className="h-3.5 w-3.5 shrink-0 text-slate-400" />
          </div>
          <div className="mt-1 font-mono text-xl font-extrabold text-slate-900 tabular-nums sm:text-2xl">
            {cmds.toLocaleString()}
          </div>
        </div>

        <div className="min-w-0 p-3.5 sm:p-4">
          <div className="flex items-center justify-between gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            <span className="truncate">Successful Downloads</span>
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
          </div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="font-mono text-xl font-extrabold text-emerald-700 tabular-nums sm:text-2xl">
              {okCount.toLocaleString()}
            </span>
            {successRate !== null && (
              <span className="font-mono text-[11px] font-semibold text-emerald-600 tabular-nums">
                {successRate}%
              </span>
            )}
          </div>
        </div>

        <div className="min-w-0 p-3.5 sm:p-4">
          <div className="flex items-center justify-between gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            <span className="truncate">Failed</span>
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-500" />
          </div>
          <div className="mt-1 font-mono text-xl font-extrabold text-rose-600 tabular-nums sm:text-2xl">
            {failCount.toLocaleString()}
          </div>
        </div>

        <div className="min-w-0 p-3.5 sm:p-4">
          <div className="flex items-center justify-between gap-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            <span className="truncate">Uptime</span>
            <Clock className="h-3.5 w-3.5 shrink-0 text-teal-600" />
          </div>
          <div className="mt-1 truncate font-mono text-lg font-extrabold text-slate-900 tabular-nums sm:text-2xl">
            {formatUptime(liveUptime, reachable)}
          </div>
        </div>
      </div>

      {/* Live Server Resource Strip (RAM, Disk, Queues) */}
      {showResources && (
        <div className="grid grid-cols-1 gap-2 border-t border-slate-100 bg-slate-50/80 px-3.5 py-2.5 text-xs sm:grid-cols-3 sm:gap-4 sm:px-5">
          <div className="flex min-w-0 items-center justify-between gap-2 font-mono text-[11px] text-slate-600 tabular-nums">
            <span className="inline-flex items-center gap-1.5 font-sans font-semibold text-slate-500">
              <Cpu className="h-3.5 w-3.5 text-teal-600" />
              RAM
            </span>
            <span className="font-bold text-slate-800">
              {ramUsedMB != null ? `${ramUsedMB} MB` : '—'}
            </span>
          </div>

          <div className="flex min-w-0 items-center justify-between gap-2 font-mono text-[11px] text-slate-600 tabular-nums">
            <span className="inline-flex shrink-0 items-center gap-1.5 font-sans font-semibold text-slate-500">
              <HardDrive className="h-3.5 w-3.5 text-teal-600" />
              Disk
            </span>
            <div className="flex min-w-0 items-center gap-2">
              {diskPct !== null && (
                <div className="hidden h-1.5 w-14 overflow-hidden rounded-full bg-slate-200 xs:block sm:block">
                  <div
                    className={`h-full ${diskPct > 85 ? 'bg-rose-500' : 'bg-teal-600'}`}
                    style={{ width: `${diskPct}%` }}
                  />
                </div>
              )}
              <span className="truncate font-bold text-slate-800">
                {diskUsedMB != null && diskBudgetMB != null
                  ? `${diskUsedMB} / ${diskBudgetMB} MB`
                  : '—'}
              </span>
            </div>
          </div>

          <div className="flex min-w-0 items-center justify-between gap-2 font-mono text-[11px] text-slate-600 tabular-nums">
            <span className="inline-flex items-center gap-1.5 font-sans font-semibold text-slate-500">
              <Layers className="h-3.5 w-3.5 text-teal-600" />
              Queues
            </span>
            <span className="font-bold text-slate-800">
              L:{queueLight ?? 0} · H:{queueHeavy ?? 0}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
