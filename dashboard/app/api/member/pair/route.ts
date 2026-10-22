import { NextRequest, NextResponse } from 'next/server';
import { getAdminEmail, getAuthenticatedSession } from '@/lib/auth-engine';
import {
  checkQueuedPairCommand,
  getResolvedBotTarget,
  normalizePhoneNumber,
  requestLiveBotPairingCode,
} from '@/lib/bot-proxy';
import { getStoredWhatsAppUser } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await getAuthenticatedSession(req);
  if (!session) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  }

  const requestId = req.nextUrl.searchParams.get('requestId')?.trim() || '';
  if (!requestId) {
    return NextResponse.json({ error: 'Missing requestId.' }, { status: 400 });
  }

  const res = await checkQueuedPairCommand(requestId);
  if (!res.ok) {
    return NextResponse.json({ error: res.error }, { status: res.status });
  }
  if (res.pending) {
    return NextResponse.json({ ok: true, pending: true, requestId }, { status: 202 });
  }

  return NextResponse.json({
    ok: true,
    code: res.code,
    expiresInSeconds: res.expiresInSeconds || 60,
    issuedAt: Date.now(),
  });
}

export async function POST(req: NextRequest) {
  const session = await getAuthenticatedSession(req);
  if (!session) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  }

  if (!session.user.memberAllowed) {
    return NextResponse.json(
      {
        error: `Your account access has been disallowed by the administrator (${getAdminEmail()}).`,
      },
      { status: 403 },
    );
  }

  const target = await getResolvedBotTarget();
  if (!target.botEnabledForMembers && !session.user.isAdmin) {
    return NextResponse.json(
      { error: 'Bot linking is temporarily paused by the administrator.' },
      { status: 403 },
    );
  }

  const payload = await req.json().catch(() => null);
  const number = normalizePhoneNumber(payload?.number);
  const existing = await getStoredWhatsAppUser(number);

  if (
    !existing ||
    (existing.addedBy || '').toLowerCase() !== session.user.email.toLowerCase()
  ) {
    return NextResponse.json(
      { error: 'Add and allow this number on your account before requesting a code.' },
      { status: 403 },
    );
  }

  if (!existing.enabled) {
    return NextResponse.json(
      { error: 'Enable this number first before requesting a WhatsApp linking code.' },
      { status: 403 },
    );
  }

  const result = await requestLiveBotPairingCode(
    number,
    `${existing.label || session.user.name} (${session.user.email})`,
    session.user.email,
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  if (result.pending && result.requestId) {
    return NextResponse.json(
      {
        ok: true,
        pending: true,
        requestId: result.requestId,
        number,
      },
      { status: 202 },
    );
  }

  return NextResponse.json({
    ok: true,
    code: result.code,
    expiresInSeconds: result.expiresInSeconds || 60,
    number,
    issuedAt: Date.now(),
  });
}
