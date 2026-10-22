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
    <div className="mb-4 overflow-hidden rounded-2xl border border-mint/40 bg-gradient-to-br from-[#132923] via-obsidian-800 to-obsidian-850 p-4 shadow-lg">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-mint">
            <Smartphone className="h-3.5 w-3.5" />
            WhatsApp Linking Code · +{activePair.number}
          </div>
          <p className="text-xs text-[#9fb0c5]">
            Open WhatsApp → <strong>Linked Devices</strong> →{' '}
            <strong>Link with phone number instead</strong> and enter this code.
          </p>
        </div>

        <button
          type="button"
          onClick={onDismiss}
          aria-label="Close pairing code banner"
          className="rounded-lg p-1 text-[#8d98aa] hover:bg-obsidian-700 hover:text-[#f4f7fb]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <code className="rounded-xl border border-mint/30 bg-obsidian-950 px-4 py-2.5 font-mono text-2xl font-bold tracking-[0.2em] text-[#f4f7fb] tabular-nums">
            {activePair.code}
          </code>
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1.5 rounded-xl bg-mint px-3.5 py-2.5 text-xs font-bold text-[#071510] transition hover:brightness-110"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? 'Copied' : 'Copy Code'}
          </button>
        </div>

        <div className="font-mono text-xs tabular-nums text-[#8d98aa]">
          {remaining > 0 ? (
            <span>
              Expires in <strong className="text-mint">{remaining}s</strong>
            </span>
          ) : (
            <span className="text-coral">Expired — request a fresh code</span>
          )}
        </div>
      </div>

      <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-obsidian-950">
        <div
          className={`h-full transition-all duration-500 ${
            remaining > 12 ? 'bg-mint' : 'bg-coral'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
