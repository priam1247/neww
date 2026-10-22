import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedSession } from '@/lib/auth-engine';
import {
  normalizePhoneNumber,
  removeNumberFromLiveBot,
  syncNumberToLiveBot,
} from '@/lib/bot-proxy';
import { deleteStoredWhatsAppUser, updateStoredWhatsAppUser } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ number: string }> },
) {
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

  const { number: rawParam } = await params;
  const payload = await req.json().catch(() => null);
  const cleanNumber = normalizePhoneNumber(decodeURIComponent(rawParam));

  const user = await updateStoredWhatsAppUser(cleanNumber, {
    enabled: typeof payload?.enabled === 'boolean' ? payload.enabled : undefined,
    label: typeof payload?.label === 'string' ? payload.label : undefined,
  });

  if (!user) {
    return NextResponse.json({ error: 'Approved number not found.' }, { status: 404 });
  }

  await syncNumberToLiveBot(user.number, user.label || 'Approved number', user.enabled);
  return NextResponse.json({ ok: true, user });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ number: string }> },
) {
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

  const { number: rawParam } = await params;
  const cleanNumber = normalizePhoneNumber(decodeURIComponent(rawParam));

  const users = await deleteStoredWhatsAppUser(cleanNumber);
  await removeNumberFromLiveBot(cleanNumber);
  return NextResponse.json({ ok: true, users });
}
