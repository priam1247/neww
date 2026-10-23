'use client';

import { useMemo, useState } from 'react';
import { Check, Copy, Lock, Search, Terminal } from 'lucide-react';
import { BOT_COMMANDS } from '@/lib/bot-data';

type CategoryFilter = 'all' | 'media' | 'vault' | 'admin';

interface CommandDirectoryProps {
  hideOwnerCommands?: boolean;
}

export function CommandDirectory({ hideOwnerCommands = false }: CommandDirectoryProps) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  const visibleCommands = useMemo(
    () =>
      hideOwnerCommands
        ? BOT_COMMANDS.filter((c) => !c.ownerOnly)
        : BOT_COMMANDS,
    [hideOwnerCommands],
  );

  const categories: { id: CategoryFilter; label: string }[] = hideOwnerCommands
    ? [
        { id: 'all', label: `All (${visibleCommands.length})` },
        { id: 'media', label: 'Media' },
        { id: 'vault', label: 'Vault & Tools' },
      ]
    : [
        { id: 'all', label: `All (${visibleCommands.length})` },
        { id: 'media', label: 'Media' },
        { id: 'vault', label: 'Vault' },
        { id: 'admin', label: 'Admin' },
      ];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return visibleCommands.filter((cmd) => {
      if (category !== 'all' && cmd.category !== category) return false;
      if (!q) return true;
      return (
        cmd.name.toLowerCase().includes(q) ||
        cmd.aliases.some((a) => a.toLowerCase().includes(q)) ||
        cmd.summary.toLowerCase().includes(q) ||
        cmd.usage.toLowerCase().includes(q)
      );
    });
  }, [visibleCommands, query, category]);

  const copyExample = async (example: string) => {
    try {
      await navigator.clipboard.writeText(example);
      setCopiedCmd(example);
      setTimeout(() => setCopiedCmd(null), 1600);
    } catch {
      /* ignore */
    }
  };

  return (
    <section className="space-y-3.5">
      <div className="flex flex-col gap-2.5 rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-4">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter commands…"
            className="w-full rounded-xl border border-slate-300 bg-slate-50 py-2 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:bg-white focus:outline-none"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1 rounded-xl bg-slate-100 p-1">
          {categories.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setCategory(cat.id)}
              className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${
                category === cat.id
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
          <p className="text-sm font-semibold text-slate-700">No matches</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {filtered.map((cmd) => {
            const isCopied = copiedCmd === cmd.example;
            return (
              <article
                key={cmd.name}
                className="flex min-w-0 flex-col justify-between rounded-2xl border border-slate-200 bg-white p-3.5 shadow-sm sm:p-4"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="inline-flex items-center gap-1 rounded-lg bg-teal-50 px-2 py-0.5 font-mono text-xs font-bold text-teal-800 ring-1 ring-teal-200">
                        <Terminal className="h-3 w-3 text-teal-600" />.{cmd.name}
                      </span>
                      {cmd.aliases.slice(0, 2).map((alias) => (
                        <span
                          key={alias}
                          className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[11px] text-slate-600"
                        >
                          .{alias}
                        </span>
                      ))}
                    </div>

                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-medium text-slate-500">
                        {cmd.summary}
                      </span>
                      {cmd.ownerOnly && (
                        <span className="inline-flex items-center gap-0.5 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-800 ring-1 ring-amber-200">
                          <Lock className="h-2.5 w-2.5" />
                          Admin
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="mt-2.5 break-all rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 font-mono text-[11px] text-slate-700">
                    {cmd.usage}
                  </div>
                </div>

                <div className="mt-2.5 flex min-w-0 items-center justify-between gap-2 border-t border-slate-100 pt-2.5">
                  <code className="min-w-0 truncate font-mono text-xs text-slate-600">
                    {cmd.example}
                  </code>
                  <button
                    type="button"
                    onClick={() => copyExample(cmd.example)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-700 transition hover:border-teal-300 hover:bg-teal-50 hover:text-teal-800"
                  >
                    {isCopied ? (
                      <>
                        <Check className="h-3 w-3 text-teal-600" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3" />
                        Copy
                      </>
                    )}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
