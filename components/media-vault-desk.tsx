'use client';

import { useState } from 'react';
import {
  ArrowUpRight,
  BookOpenCheck,
  Check,
  Copy,
  Film,
  MessageSquareText,
} from 'lucide-react';
import { METADATA_SOURCES, VAULT_STATS } from '@/lib/bot-data';

interface MediaVaultDeskProps {
  compact?: boolean;
  onExploreAll?: () => void;
}

export function MediaVaultDesk({ compact = false, onExploreAll }: MediaVaultDeskProps) {
  const [copiedQuery, setCopiedQuery] = useState<string | null>(null);

  const copyQuery = async (q: string) => {
    try {
      await navigator.clipboard.writeText(q);
      setCopiedQuery(q);
      setTimeout(() => setCopiedQuery(null), 1800);
    } catch {
      // ignore
    }
  };

  if (compact) {
    return (
      <aside className="space-y-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900">
              <MessageSquareText className="h-5 w-5 text-teal-600" />
              How to Use the Bot
            </h2>
            <span className="rounded-full bg-teal-50 px-2.5 py-0.5 text-[11px] font-semibold text-teal-700 ring-1 ring-teal-200">
              Quick Guide
            </span>
          </div>

          <ol className="mt-3 space-y-2.5 text-xs leading-relaxed text-slate-600">
            <li className="rounded-xl border border-slate-100 bg-slate-50 p-3">
              <strong className="text-slate-900">1. Allow your number:</strong> Enter your full WhatsApp number with country code (for example <code className="font-mono text-teal-700">265991234567</code>) and click <strong>Allow My Number</strong>.
            </li>
            <li className="rounded-xl border border-slate-100 bg-slate-50 p-3">
              <strong className="text-slate-900">2. Link device or message bot:</strong> Click <strong>Get Code</strong> to generate a 60-second WhatsApp linking code, or message the linked bot directly with commands like <code className="font-mono text-teal-700">.menu</code>.
            </li>
          </ol>

          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-900">
                <BookOpenCheck className="h-4 w-4 text-teal-600" />
                Past-Paper Vault
              </span>
              <span className="font-mono text-xs font-bold text-teal-700 tabular-nums">
                {VAULT_STATS.totalPapers.toLocaleString()} PDFs
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-600">
              Instant exam archive for {VAULT_STATS.institution}. Tap any command below to copy:
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {VAULT_STATS.sampleQueries.slice(0, 3).map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => copyQuery(q)}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 font-mono text-[11px] font-medium text-slate-700 transition hover:border-teal-300 hover:text-teal-700"
                >
                  {copiedQuery === q ? (
                    <Check className="h-3 w-3 text-teal-600" />
                  ) : (
                    <Copy className="h-3 w-3 text-slate-400" />
                  )}
                  {q}
                </button>
              ))}
            </div>
            {onExploreAll && (
              <button
                type="button"
                onClick={onExploreAll}
                className="mt-3 inline-block text-xs font-semibold text-teal-700 hover:underline"
              >
                Explore full archive &amp; catalogs →
              </button>
            )}
          </div>
        </div>
      </aside>
    );
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <span className="text-xs font-bold uppercase tracking-widest text-teal-700">
              Academic Archive · Instant Index
            </span>
            <h2 className="mt-1 text-xl font-bold text-slate-900">
              {VAULT_STATS.institution} Past-Paper Vault
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-slate-600">
              Search and download past exam papers directly in WhatsApp with smart typo suggestions and automatic duplicate filtering.
            </p>
          </div>
          <div className="rounded-2xl border border-teal-200 bg-teal-50 px-5 py-3 text-right">
            <div className="font-mono text-2xl font-extrabold text-teal-800 tabular-nums">
              {VAULT_STATS.totalPapers.toLocaleString()}
            </div>
            <div className="text-[11px] font-semibold text-teal-700">
              Indexed Exam Papers
            </div>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          {VAULT_STATS.sampleQueries.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => copyQuery(q)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs font-medium text-slate-700 transition hover:border-teal-300 hover:bg-teal-50 hover:text-teal-800"
            >
              {copiedQuery === q ? (
                <Check className="h-3.5 w-3.5 text-teal-600" />
              ) : (
                <Copy className="h-3.5 w-3.5 text-slate-400" />
              )}
              {q}
            </button>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900">
              <Film className="h-5 w-5 text-teal-600" />
              Multi-Source Movie &amp; Series Discovery
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Parallel metadata resolution across 6 catalogs with runtime verification and subtitle support.
            </p>
          </div>
          <a
            href="https://www.themoviedb.org/"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-xl border border-teal-200 bg-teal-50 px-3.5 py-2 text-xs font-semibold text-teal-800 hover:bg-teal-100"
          >
            Open TMDB Catalog
            <ArrowUpRight className="h-3.5 w-3.5" />
          </a>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {METADATA_SOURCES.map((src) => (
            <div
              key={src.id}
              className="rounded-xl border border-slate-200 bg-slate-50/70 p-4"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-bold text-slate-900">{src.label}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    src.keyless
                      ? 'bg-teal-50 text-teal-700 ring-1 ring-teal-200'
                      : 'bg-slate-200/80 text-slate-700'
                  }`}
                >
                  {src.keyless ? 'Public' : 'API Key'}
                </span>
              </div>
              <div className="mt-1 text-[11px] font-medium text-slate-500">{src.scope}</div>
              <p className="mt-2 text-xs leading-relaxed text-slate-600">{src.note}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
