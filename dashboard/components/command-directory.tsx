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
        { id: 'media', label: 'Media Downloaders' },
        { id: 'vault', label: 'Past Papers & Tools' },
      ]
    : [
        { id: 'all', label: `All (${visibleCommands.length})` },
        { id: 'media', label: 'Media Downloaders' },
        { id: 'vault', label: 'Past Papers & Tools' },
        { id: 'admin', label: 'Owner Controls' },
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
      setTimeout(() => setCopiedCmd(null), 1800);
    } catch {
      // ignore
    }
  };

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="relative min-w-0 flex-1 basis-full sm:basis-60">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search commands (.song, .paper, .movie, .sticker)…"
            className="w-full rounded-xl border border-slate-300 bg-slate-50 py-2.5 pl-10 pr-4 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-600 focus:bg-white focus:outline-none"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1 rounded-xl bg-slate-100 p-1">
          {categories.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setCategory(cat.id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
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
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <p className="text-sm font-semibold text-slate-800">
            No commands match &ldquo;{query.trim()}&rdquo;
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Try searching for another command name or reset the category filter.
          </p>
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setCategory('all');
            }}
            className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
          >
            Reset search
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
          {filtered.map((cmd) => {
            const isCopied = copiedCmd === cmd.example;
            return (
              <article
                key={cmd.name}
                className="flex min-w-0 flex-col justify-between rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-slate-300"
              >
                <div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="inline-flex items-center gap-1 rounded-lg bg-teal-50 px-2.5 py-1 font-mono text-sm font-bold text-teal-800 ring-1 ring-teal-200">
                        <Terminal className="h-3.5 w-3.5 text-teal-600" />.{cmd.name}
                      </span>
                      {cmd.aliases.slice(0, 3).map((alias) => (
                        <span
                          key={alias}
                          className="rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-[11px] text-slate-600"
                        >
                          .{alias}
                        </span>
                      ))}
                    </div>

                    {cmd.ownerOnly && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-800 ring-1 ring-amber-200">
                        <Lock className="h-2.5 w-2.5" />
                        Admin
                      </span>
                    )}
                  </div>

                  <p className="mt-3 text-xs leading-relaxed text-slate-600">
                    {cmd.summary}
                  </p>

                  <div className="mt-3 break-words rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-[11px] text-slate-700">
                    {cmd.usage}
                  </div>
                </div>

                <div className="mt-3.5 flex items-center justify-between gap-2 border-t border-slate-100 pt-3">
                  <code className="truncate font-mono text-xs font-medium text-slate-700">
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
