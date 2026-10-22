import { NextRequest, NextResponse } from 'next/server';
import { getAdminEmail } from '@/lib/auth-engine';
import { verifyBotSyncRequest } from '@/lib/bot-sync-auth';
import {
  checkRateLimit,
  getClientIp,
  recordRateLimitHit,
} from '@/lib/rate-limit';
import {
  claimPendingBotCommands,
  completeBotCommand,
  computeWhitelistSnapshot,
  getNextBotPollMs,
  getStoredWhatsAppUser,
  saveBotHeartbeat,
  saveStoredWhatsAppUser,
} from '@/lib/storage';

export const dynamic = 'force-dynamic';

const SYNC_WINDOW_MS = 60 * 1000;
const MAX_SYNC_PER_MINUTE = 120;

export async function POST(req: NextRequest) {
  const ipKey = `botsync:ip:${getClientIp(req)}`;
  const rate = checkRateLimit(ipKey, MAX_SYNC_PER_MINUTE, SYNC_WINDOW_MS);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded' },
      {
        status: 429,
        headers: { 'Retry-After': String(rate.retryAfterSeconds) },
      },
    );
  }
  recordRateLimitHit(ipKey, SYNC_WINDOW_MS);

  const rawBody = await req.text().catch(() => '');
  const auth = await verifyBotSyncRequest(req, rawBody);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let body: Record<string, unknown> = {};
  if (rawBody) {
    try {
      const parsed = JSON.parse(rawBody);
      if (parsed && typeof parsed === 'object') body = parsed;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
  }

  // 1. Import any unsynced WhatsApp `.allow` numbers from the bot into D1
  let importedAnyLocal = false;
  if (Array.isArray(body.localUsers)) {
    const adminOwner = getAdminEmail();
    for (const raw of body.localUsers.slice(0, 200)) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const num = String(item.number || '').replace(/[^0-9]/g, '');
      if (num.length < 7 || num.length > 15) continue;
      const existing = await getStoredWhatsAppUser(num);
      if (!existing) {
        const label = String(item.label || 'Added via WhatsApp .allow').slice(0, 60);
        await saveStoredWhatsAppUser(num, label, adminOwner);
        importedAnyLocal = true;
      }
    }
  }

  // 2. Record completed command results reported by the bot
  if (Array.isArray(body.completedResults)) {
    for (const item of body.completedResults) {
      if (item && typeof item === 'object' && typeof item.id === 'string') {
        await completeBotCommand({
          id: item.id,
          ok: Boolean(item.ok),
          result:
            item.result && typeof item.result === 'object'
              ? (item.result as Record<string, unknown>)
              : undefined,
          error: typeof item.error === 'string' ? item.error : undefined,
        });
      }
    }
  }

  // 3. Store fresh bot heartbeat
  await saveBotHeartbeat({
    lastSeenAt: Date.now(),
    connected: Boolean(body.connected),
    botNumber: body.botNumber ? String(body.botNumber) : null,
    botName: typeof body.botName === 'string' ? body.botName : undefined,
    version: typeof body.version === 'string' ? body.version : undefined,
    uptimeSeconds:
      typeof body.uptimeSeconds === 'number' ? body.uptimeSeconds : undefined,
    diskUsedMB:
      typeof body.diskUsedMB === 'number' ? body.diskUsedMB : undefined,
    diskBudgetMB:
      typeof body.diskBudgetMB === 'number' ? body.diskBudgetMB : undefined,
    queueLight:
      typeof body.queueLight === 'number' ? body.queueLight : undefined,
    queueHeavy:
      typeof body.queueHeavy === 'number' ? body.queueHeavy : undefined,
  });

  // 4. Compute versioned whitelist delta + claim queued commands + poll interval
  const [snapshot, commands, nextPollMs] = await Promise.all([
    computeWhitelistSnapshot(),
    claimPendingBotCommands(),
    getNextBotPollMs(),
  ]);

  const clientVersion =
    typeof body.whitelistVersion === 'string' ? body.whitelistVersion.trim() : '';
  const whitelistChanged = importedAnyLocal || clientVersion !== snapshot.version;

  return NextResponse.json({
    ok: true,
    serverTime: Date.now(),
    nextPollMs: commands.length > 0 ? 2_000 : nextPollMs,
    whitelistVersion: snapshot.version,
    whitelistChanged,
    ...(whitelistChanged
      ? {
          botEnabledForMembers: snapshot.botEnabledForMembers,
          users: snapshot.users,
          numbers: snapshot.numbers,
        }
      : {}),
    commands: commands.map((c) => ({
      id: c.id,
      type: c.type,
      payload: c.payload,
      expiresAt: c.expiresAt,
    })),
  });
}
