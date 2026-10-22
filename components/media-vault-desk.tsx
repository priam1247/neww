'use client';

import { useState } from 'react';
import {
  ArrowUpRight,
  BookOpenCheck,
  Check,
  Copy,
  Film,
  Sparkles,
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
        <div className="rounded-2xl border border-line bg-obsidian-800/95 p-5 shadow-[0_18px_60px_rgba(0,0,0,0.3)] sm:p-6">
          <div className="flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-[#f4f7fb]">
              <Film className="h-5 w-5 text-mint" />
              Free Movie Desk
            </h2>
            <span className="rounded-full bg-mint-dim px-2.5 py-0.5 text-[11px] font-semibold text-mint">
              6 Public Catalogs
            </span>
          </div>
          <p className="mt-1 text-xs text-[#8d98aa]">
            Keep discovery resilient with public metadata, official trailers, runtime verification, and legal catalog links.
          </p>

          <div className="mt-4 rounded-xl border border-line bg-gradient-to-br from-[#18251f] to-[#151a25] p-4">
            <h3 className="text-sm font-semibold text-[#f4f7fb]">Safe Provider Lane</h3>
            <p className="mt-1 text-xs leading-relaxed text-[#9fb0c5]">
              Uses TMDB, Cinemeta, IMDb, TVMaze, Jikan, and AniList for metadata and availability. Never bypass paywalls, DRM, or protected streams.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <a
                href="https://www.themoviedb.org/"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs font-semibold text-mint hover:underline"
              >
                Open TMDB
                <ArrowUpRight className="h-3.5 w-3.5" />
              </a>
              {onExploreAll && (
                <button
                  type="button"
                  onClick={onExploreAll}
                  className="text-xs font-medium text-[#cbd5e5] hover:text-[#f4f7fb]"
                >
                  Inspect all catalogs →
                </button>
              )}
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-line bg-obsidian-900/75 p-4">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-[#f4f7fb]">
                <BookOpenCheck className="h-4 w-4 text-mint" />
                Past-Paper Vault
              </span>
              <span className="font-mono text-xs font-bold text-mint tabular-nums">
                {VAULT_STATS.totalPapers.toLocaleString()} PDFs
              </span>
            </div>
            <p className="mt-1 text-xs text-[#8d98aa]">
              Instant snapshot index for {VAULT_STATS.institution} with Levenshtein course-code suggestions and a {VAULT_STATS.duplicateGuardDays}-day duplicate guard.
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {VAULT_STATS.sampleQueries.slice(0, 3).map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => copyQuery(q)}
                  className="inline-flex items-center gap-1 rounded-lg border border-line bg-obsidian-800 px-2.5 py-1 font-mono text-[11px] text-[#d6e0f0] transition hover:border-mint/50 hover:text-mint"
                >
                  {copiedQuery === q ? (
                    <Check className="h-3 w-3 text-mint" />
                  ) : (
                    <Copy className="h-3 w-3 text-[#8d98aa]" />
                  )}
                  {q}
                </button>
              ))}
            </div>
          </div>

          <p className="mt-4 flex items-start gap-2 text-xs text-[#8d98aa]">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-mint" />
            <span>
              Roadmap ready: role-based operators, audit logs, per-number rate limits, and automated token rotation.
            </span>
          </p>
        </div>
      </aside>
    );
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-line bg-obsidian-800/95 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <span className="text-xs font-bold uppercase tracking-widest text-mint">
              Academic Archive · Drime Cloud + Snapshot
            </span>
            <h2 className="mt-1 text-xl font-bold text-[#f4f7fb]">
              {VAULT_STATS.institution} Past-Paper Vault
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-[#8d98aa]">
              Zero-cold-start offline snapshot index paired with live delta synchronization, deterministic typo suggestions, and parallel streaming to WhatsApp.
            </p>
          </div>
          <div className="rounded-2xl border border-mint/30 bg-mint-dim/40 px-5 py-3 text-right">
            <div className="font-mono text-2xl font-extrabold text-mint tabular-nums">
              {VAULT_STATS.totalPapers.toLocaleString()}
            </div>
            <div className="text-[11px] font-medium text-[#b8c6db]">Indexed Exam Papers</div>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          {VAULT_STATS.sampleQueries.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => copyQuery(q)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-obsidian-900 px-3 py-2 font-mono text-xs text-[#e2e9f5] transition hover:border-mint/50 hover:text-mint"
            >
              {copiedQuery === q ? (
                <Check className="h-3.5 w-3.5 text-mint" />
              ) : (
                <Copy className="h-3.5 w-3.5 text-[#8d98aa]" />
              )}
              {q}
            </button>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-line bg-obsidian-800/95 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-[#f4f7fb]">
              Multi-Source Metadata & Discovery Stack
            </h2>
            <p className="mt-0.5 text-xs text-[#8d98aa]">
              Parallel title resolution across 6 catalogs with automatic cross-ID enrichment and trailer/fake runtime guards.
            </p>
          </div>
          <a
            href="https://www.themoviedb.org/"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-xl border border-mint/40 bg-mint-dim/60 px-3.5 py-2 text-xs font-semibold text-mint hover:brightness-110"
          >
            Open TMDB Catalog
            <ArrowUpRight className="h-3.5 w-3.5" />
          </a>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {METADATA_SOURCES.map((src) => (
            <div
              key={src.id}
              className="rounded-xl border border-line bg-obsidian-900/90 p-4"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-sm text-[#f4f7fb]">{src.label}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    src.keyless
                      ? 'bg-mint-dim text-mint'
                      : 'bg-obsidian-700 text-[#c7d2e4]'
                  }`}
                >
                  {src.keyless ? 'Keyless' : 'API Key'}
                </span>
              </div>
              <div className="mt-1 text-[11px] font-medium text-[#8d98aa]">{src.scope}</div>
              <p className="mt-2 text-xs leading-relaxed text-[#aebbc9]">{src.note}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
