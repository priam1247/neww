import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getBotConnectionConfig, listStoredWhatsAppUsers } from '@/lib/storage';

export const dynamic = 'force-dynamic';

/**
 * Pull sync endpoint allowing ZaFar Bot instances behind NAT / firewalls to
 * fetch active approved numbers using `Authorization: Bearer <ADMIN_DASHBOARD_TOKEN>`.
 */
export async function GET(req: NextRequest) {
  const cfg = await getBotConnectionConfig();
  const expected = cfg.botAdminToken;
  const provided =
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim() ||
    req.headers.get('x-admin-token')?.trim() ||
    '';

  if (!expected || !provided) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const all = await listStoredWhatsAppUsers();
  const activeUsers = cfg.botEnabledForMembers
    ? all.filter((u) => u.enabled)
    : [];

  return NextResponse.json({
    ok: true,
    botEnabledForMembers: cfg.botEnabledForMembers,
    numbers: activeUsers.map((u) => u.number),
    users: all,
  });
}
