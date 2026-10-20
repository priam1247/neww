// src/bot/session-heal.js — pure decision helpers for WhatsApp session health.
// Zero imports so tests can exercise the logic hermetically.
//
// Background: when Baileys cannot decrypt an incoming message (Bad MAC and
// friends), it does not deliver a normal message — it emits a "ciphertext
// stub" upsert (messageStubType = CIPHERTEXT, no .message, the error in
// .messageStubParameters). Two very different situations produce that stub:
//
//   • "stale"  — messages queued by WhatsApp BEFORE this link existed. Those
//     were encrypted for the previous session's keys and can never decrypt.
//     Harmless noise every Baileys bot sees after re-pairing; skip them.
//   • "fresh"  — messages arriving AFTER the link came up failing to decrypt.
//     Sustained fresh failures with zero successful decodes mean the stored
//     session keys are corrupted (half-deployed container, reused creds,
//     crashed pairing). Only then is wiping ./session and re-pairing correct.

/** Baileys WAMessageStubType.CIPHERTEXT */
export const STUB_CIPHERTEXT = 2;

/** Timestamp skew tolerance when deciding "did this message arrive after the
 *  link came up?" — clocks drift, and WhatsApp timestamps lag slightly. */
const SKEW_MS = 30_000;

/** Classify an undecryptable message: 'stale' (harmless replay) | 'fresh'.
 *  Unknown age (missing/garbled timestamp) is treated as fresh — the safe
 *  direction for a corruption detector. */
export function classifyDecryptFail(msg, connectTs) {
  const ts = Number(msg?.messageTimestamp || 0) * 1000;
  if (!ts) return 'fresh';
  return ts < connectTs - SKEW_MS ? 'stale' : 'fresh';
}

/** Should the bot wipe the session and re-pair? Deliberately conservative:
 *  - needs a sustained burst (>= threshold) of FRESH decrypt failures
 *  - needs ZERO messages decoded since the link came up
 *  - respects the per-process repair cap (maxAttempts)
 *  Returns { wipe, exhausted } so callers can print manual instructions when
 *  auto-repair is spent. */
export function healDecision({ freshFails, decoded, attempts, threshold = 10, maxAttempts = 2 }) {
  const dead = freshFails >= threshold && decoded === 0;
  return {
    wipe: dead && attempts < maxAttempts,
    exhausted: dead && attempts >= maxAttempts,
  };
}
