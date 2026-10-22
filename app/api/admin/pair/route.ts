import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedSession } from '@/lib/auth-engine';
import {
  normalizePhoneNumber,
  requestLiveBotPairingCode,
} from '@/lib/bot-proxy';
import { getStoredWhatsAppUser } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = await getAuthenticatedSession(req);
  if (!session) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  }
  if (!session.user.isAdmin) {
    return NextResponse.json(
      { error: 'Administrator privileges required.' },
      { status: 403 },
    );
  }

  const payload = await req.json().catch(() => null);
  const number = normalizePhoneNumber(payload?.number);
  const stored = await getStoredWhatsAppUser(number);

  const result = await requestLiveBotPairingCode(
    number,
    stored?.label || 'Admin Linked Number',
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({
    ok: true,
    code: result.code,
    expiresInSeconds: result.expiresInSeconds || 60,
    number,
    issuedAt: Date.now(),
  });
}
