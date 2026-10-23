'use client';

import { useEffect, useState } from 'react';
import { Check, Copy, Smartphone, X } from 'lucide-react';
import { PairCodePayload } from '@/lib/types';

interface PairingCodeBannerProps {
  activePair: PairCodePayload | null;
  onDismiss: () => void;
}

export function PairingCodeBanner({ activePair, onDismiss }: PairingCodeBannerProps) {
  const [remaining, setRemaining] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!activePair) return;
    const updateRemaining = () => {
      const elapsed = Math.floor((Date.now() - activePair.issuedAt) / 1000);
      setRemaining(Math.max(0, activePair.expiresInSeconds - elapsed));
    };
    updateRemaining();
    const id = setInterval(updateRemaining, 500);
    return () => clearInterval(id);
  }, [activePair]);

  if (!activePair) return null;

  const pct = Math.min(
    100,
    Math.max(0, (remaining / Math.max(1, activePair.expiresInSeconds)) * 100),
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(activePair.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="mb-4 max-w-full overflow-hidden rounded-2xl border border-teal-200 bg-teal-50/70 p-3.5 shadow-sm sm:p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 font-mono text-xs font-bold uppercase tracking-wider text-teal-800">
          <Smartphone className="h-3.5 w-3.5 shrink-0 text-teal-600" />
          <span className="truncate">+{activePair.number}</span>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <span className="font-mono text-xs font-semibold tabular-nums text-slate-600">
            {remaining > 0 ? `${remaining}s` : 'Expired'}
          </span>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Close"
            className="rounded-lg p-1 text-slate-400 hover:bg-white hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <code className="min-w-0 max-w-full break-all rounded-xl border border-teal-200 bg-white px-3 py-2 font-mono text-lg font-extrabold tracking-[0.14em] text-slate-900 shadow-sm tabular-nums sm:px-4 sm:text-xl sm:tracking-[0.2em]">
          {activePair.code}
        </code>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-teal-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-teal-700"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
        <div
          className={`h-full transition-all duration-500 ${
            remaining > 12 ? 'bg-teal-600' : 'bg-rose-500'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
