import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import { getBotConnectionConfig } from './storage';

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000; // ±5 minutes
const MAX_NONCE_CACHE = 4096;

declare global {
  // eslint-disable-next-line no-var
  var __zafarBotReplayNonces: Map<string, number> | undefined;
}

function getNonceMap(): Map<string, number> {
  if (!globalThis.__zafarBotReplayNonces) {
    globalThis.__zafarBotReplayNonces = new Map();
  }
  return globalThis.__zafarBotReplayNonces;
}

function timingSafeStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function consumeNonce(nonce: string, now = Date.now()): boolean {
  const map = getNonceMap();
  for (const [k, exp] of map.entries()) {
    if (exp <= now) map.delete(k);
  }
  if (map.has(nonce)) return false;
  if (map.size >= MAX_NONCE_CACHE) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(nonce, now + MAX_CLOCK_SKEW_MS);
  return true;
}

export async function verifyBotSyncRequest(
  req: NextRequest,
  rawBody = '',
): Promise<{ ok: boolean; status: number; error?: string }> {
  const cfg = await getBotConnectionConfig();
  const validSecrets = [
    cfg.botSyncToken,
    cfg.botAdminToken,
    process.env.BOT_SYNC_TOKEN || '',
    process.env.ADMIN_DASHBOARD_TOKEN || '',
  ]
    .map((s) => s.trim())
    .filter(Boolean);

  if (validSecrets.length === 0) {
    return {
      ok: false,
      status: 503,
      error: 'ADMIN_DASHBOARD_TOKEN / BOT_SYNC_TOKEN is not configured on the portal yet.',
    };
  }

  const providedBearer =
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim() ||
    req.headers.get('x-bot-token')?.trim() ||
    req.headers.get('x-admin-token')?.trim() ||
    '';

  const matchedSecret = validSecrets.find(
    (sec) => providedBearer && timingSafeStr(providedBearer, sec),
  );
  if (!matchedSecret) {
    return { ok: false, status: 401, error: 'Unauthorized bot token.' };
  }

  const tsHeader = req.headers.get('x-bot-timestamp')?.trim();
  const nonceHeader = req.headers.get('x-bot-nonce')?.trim();
  const sigHeader = req.headers.get('x-bot-signature')?.trim();

  // Signed requests enforce timestamp freshness + one-time nonce + HMAC-SHA256
  if (tsHeader || nonceHeader || sigHeader) {
    const ts = Number(tsHeader);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_CLOCK_SKEW_MS) {
      return {
        ok: false,
        status: 401,
        error: 'Bot request timestamp outside allowed 5-minute window.',
      };
    }
    if (!nonceHeader || nonceHeader.length < 8 || !consumeNonce(nonceHeader)) {
      return {
        ok: false,
        status: 409,
        error: 'Duplicate or invalid bot request nonce (replay blocked).',
      };
    }
    const expectedSig =
      'sha256=' +
      crypto
        .createHmac('sha256', matchedSecret)
        .update(`${tsHeader}.${nonceHeader}.${rawBody}`)
        .digest('hex');
    if (!sigHeader || !timingSafeStr(sigHeader, expectedSig)) {
      return { ok: false, status: 401, error: 'Invalid bot HMAC signature.' };
    }
  }

  return { ok: true, status: 200 };
}
