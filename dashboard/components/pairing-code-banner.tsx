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
      // clipboard unavailable
    }
  };

  return (
    <div className="mb-5 overflow-hidden rounded-2xl border border-teal-200 bg-gradient-to-br from-teal-50/90 via-white to-slate-50 p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-teal-700">
            <Smartphone className="h-3.5 w-3.5" />
            WhatsApp Linking Code · +{activePair.number}
          </div>
          <p className="text-xs text-slate-600">
            Open WhatsApp → <strong>Linked Devices</strong> →{' '}
            <strong>Link with phone number instead</strong> and enter this code.
          </p>
        </div>

        <button
          type="button"
          onClick={onDismiss}
          aria-label="Close pairing code banner"
          className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-3.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5 sm:gap-3">
          <code className="rounded-xl border border-teal-200 bg-white px-3.5 py-2 font-mono text-xl font-bold tracking-[0.16em] text-slate-900 shadow-sm tabular-nums sm:px-4 sm:py-2.5 sm:text-2xl sm:tracking-[0.2em]">
            {activePair.code}
          </code>
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1.5 rounded-xl bg-teal-600 px-3.5 py-2.5 text-xs font-semibold text-white shadow-sm transition hover:bg-teal-700"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? 'Copied' : 'Copy Code'}
          </button>
        </div>

        <div className="font-mono text-xs tabular-nums text-slate-600">
          {remaining > 0 ? (
            <span>
              Expires in <strong className="text-teal-700">{remaining}s</strong>
            </span>
          ) : (
            <span className="font-semibold text-rose-600">
              Expired — request a fresh code
            </span>
          )}
        </div>
      </div>

      <div className="mt-3.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
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
