import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedSession } from '@/lib/auth-engine';
import { normalizePhoneNumber, syncNumberToLiveBot } from '@/lib/bot-proxy';
import { saveStoredWhatsAppUser } from '@/lib/storage';

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
  if (!payload || typeof payload !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const number = normalizePhoneNumber(payload.number);
  if (number.length < 8 || number.length > 15) {
    return NextResponse.json(
      { error: 'Enter a valid international WhatsApp number (8–15 digits).' },
      { status: 400 },
    );
  }

  const label =
    String(payload.label || 'Approved number').trim().slice(0, 80) ||
    'Approved number';
  const ownerEmail =
    String(payload.ownerEmail || session.user.email).trim().toLowerCase() ||
    session.user.email;

  const users = await saveStoredWhatsAppUser(number, label, ownerEmail);
  await syncNumberToLiveBot(number, label, true);

  return NextResponse.json({ ok: true, users }, { status: 201 });
}
