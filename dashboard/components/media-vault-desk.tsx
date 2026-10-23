'use client';

import { useState } from 'react';
import { BookOpenCheck, Check, Copy, Database, Film } from 'lucide-react';
import { METADATA_SOURCES, VAULT_STATS } from '@/lib/bot-data';

export function MediaVaultDesk() {
  const [copiedQuery, setCopiedQuery] = useState<string | null>(null);

  const copyQuery = async (q: string) => {
    try {
      await navigator.clipboard.writeText(q);
      setCopiedQuery(q);
      setTimeout(() => setCopiedQuery(null), 1600);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="space-y-4">
      {/* Paper Vault Index */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-teal-50 text-teal-700 ring-1 ring-teal-200">
              <BookOpenCheck className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-sm font-bold text-slate-900 sm:text-base">
                {VAULT_STATS.institution} Paper Vault
              </h2>
              <div className="flex items-center gap-1.5 text-xs text-slate-500">
                <Database className="h-3 w-3 text-teal-600" />
                <span className="truncate">{VAULT_STATS.storageBackend}</span>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-teal-200 bg-teal-50 px-3.5 py-2 text-right">
            <div className="font-mono text-lg font-extrabold text-teal-800 tabular-nums sm:text-xl">
              {VAULT_STATS.totalPapers.toLocaleString()}
            </div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-teal-700">
              PDFs Indexed
            </div>
          </div>
        </div>

        <div className="mt-3.5 flex flex-wrap gap-1.5">
          {VAULT_STATS.sampleQueries.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => copyQuery(q)}
              className="inline-flex min-w-0 items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-1.5 font-mono text-xs font-medium text-slate-700 transition hover:border-teal-300 hover:bg-teal-50 hover:text-teal-800"
            >
              {copiedQuery === q ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-teal-600" />
              ) : (
                <Copy className="h-3.5 w-3.5 shrink-0 text-slate-400" />
              )}
              <span className="truncate">{q}</span>
            </button>
          ))}
        </div>
      </section>

      {/* Active Providers */}
      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-bold text-slate-900 sm:text-base">
            <Film className="h-4 w-4 text-teal-600" />
            Active Providers ({METADATA_SOURCES.length})
          </h2>
          <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase text-emerald-700 ring-1 ring-emerald-200">
            Online
          </span>
        </div>

        <div className="mt-3.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {METADATA_SOURCES.map((src) => (
            <div
              key={src.id}
              className="flex min-w-0 items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
                <span className="truncate font-mono text-xs font-bold text-slate-900">
                  {src.label}
                </span>
              </div>
              <span className="shrink-0 font-mono text-[10px] font-semibold uppercase text-slate-500">
                {src.scope}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
