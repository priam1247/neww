import { NextRequest, NextResponse } from 'next/server';
import { verifyBotSyncRequest } from '@/lib/bot-sync-auth';
import {
  checkRateLimit,
  getClientIp,
  recordRateLimitHit,
} from '@/lib/rate-limit';
import { computeWhitelistSnapshot } from '@/lib/storage';

export const dynamic = 'force-dynamic';

/**
 * Versioned whitelist pull endpoint (`ETag` / `If-None-Match` supported)
 * authenticated via `BOT_SYNC_TOKEN` or `ADMIN_DASHBOARD_TOKEN`.
 */
export async function GET(req: NextRequest) {
  const ipKey = `botwl:ip:${getClientIp(req)}`;
  const rate = checkRateLimit(ipKey, 60, 60_000);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded' },
      {
        status: 429,
        headers: { 'Retry-After': String(rate.retryAfterSeconds) },
      },
    );
  }
  recordRateLimitHit(ipKey, 60_000);

  const auth = await verifyBotSyncRequest(req, '');
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const snapshot = await computeWhitelistSnapshot();
  const etag = `"${snapshot.version}"`;
  const ifNoneMatch = req.headers.get('if-none-match')?.trim();

  if (ifNoneMatch && (ifNoneMatch === etag || ifNoneMatch === snapshot.version)) {
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: etag },
    });
  }

  return NextResponse.json(
    {
      ok: true,
      version: snapshot.version,
      botEnabledForMembers: snapshot.botEnabledForMembers,
      numbers: snapshot.numbers,
      users: snapshot.users,
    },
    {
      headers: { ETag: etag },
    },
  );
}
