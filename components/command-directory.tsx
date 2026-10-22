'use client';

import { useMemo, useState } from 'react';
import { Check, Copy, Lock, Search, Terminal } from 'lucide-react';
import { BOT_COMMANDS } from '@/lib/bot-data';

type CategoryFilter = 'all' | 'media' | 'vault' | 'admin';

const CATEGORY_LABELS: Record<CategoryFilter, string> = {
  all: 'All (21)',
  media: 'Media Downloaders',
  vault: 'Past Papers & Tools',
  admin: 'Owner Controls',
};

export function CommandDirectory() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return BOT_COMMANDS.filter((cmd) => {
      if (category !== 'all' && cmd.category !== category) return false;
      if (!q) return true;
      return (
        cmd.name.toLowerCase().includes(q) ||
        cmd.aliases.some((a) => a.toLowerCase().includes(q)) ||
        cmd.summary.toLowerCase().includes(q) ||
        cmd.usage.toLowerCase().includes(q)
      );
    });
  }, [query, category]);

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
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-obsidian-800/95 p-5">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#6e7a8c]" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search commands, aliases (.tt, .yta, .vv), or capabilities…"
            className="w-full rounded-xl border border-line bg-obsidian-900 py-2.5 pl-10 pr-4 text-sm text-[#f4f7fb] placeholder:text-[#606b7d] focus:border-mint focus:outline-none"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-line bg-obsidian-900 p-1">
          {(['all', 'media', 'vault', 'admin'] as CategoryFilter[]).map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setCategory(cat)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                category === cat
                  ? 'bg-obsidian-700 text-[#f4f7fb]'
                  : 'text-[#8d98aa] hover:text-[#f4f7fb]'
              }`}
            >
              {CATEGORY_LABELS[cat]}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
        {filtered.map((cmd) => {
          const isCopied = copiedCmd === cmd.example;
          return (
            <article
              key={cmd.name}
              className="flex flex-col justify-between rounded-2xl border border-line bg-obsidian-800/90 p-5 transition hover:border-line-strong"
            >
              <div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1 rounded-lg bg-obsidian-950 px-2.5 py-1 font-mono text-sm font-bold text-mint">
                      <Terminal className="h-3.5 w-3.5" />.{cmd.name}
                    </span>
                    {cmd.aliases.slice(0, 3).map((alias) => (
                      <span
                        key={alias}
                        className="rounded-md border border-line bg-obsidian-900 px-2 py-0.5 font-mono text-[11px] text-[#8d98aa]"
                      >
                        .{alias}
                      </span>
                    ))}
                  </div>

                  {cmd.ownerOnly && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-coral-dim/70 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#ffb4b9]">
                      <Lock className="h-2.5 w-2.5" />
                      Owner
                    </span>
                  )}
                </div>

                <p className="mt-3 text-xs leading-relaxed text-[#b2bfd3]">
                  {cmd.summary}
                </p>

                <div className="mt-3 rounded-xl border border-line-subtle bg-obsidian-950/90 px-3 py-2 font-mono text-[11px] text-[#8d98aa]">
                  {cmd.usage}
                </div>
              </div>

              <div className="mt-3.5 flex items-center justify-between gap-2 border-t border-line/70 pt-3">
                <code className="truncate font-mono text-xs text-[#d6e0f0]">
                  {cmd.example}
                </code>
                <button
                  type="button"
                  onClick={() => copyExample(cmd.example)}
                  className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-line bg-obsidian-900 px-2.5 py-1 text-[11px] font-medium text-[#d6e0f0] transition hover:border-mint/50 hover:text-mint"
                >
                  {isCopied ? (
                    <>
                      <Check className="h-3 w-3 text-mint" />
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
    </section>
  );
}
