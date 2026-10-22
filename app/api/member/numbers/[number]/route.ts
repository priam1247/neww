import { NextRequest, NextResponse } from 'next/server';
import { getAdminEmail, getAuthenticatedSession } from '@/lib/auth-engine';
import {
  normalizePhoneNumber,
  removeNumberFromLiveBot,
  syncNumberToLiveBot,
} from '@/lib/bot-proxy';
import {
  deleteStoredWhatsAppUser,
  getStoredWhatsAppUser,
  listStoredWhatsAppUsers,
  updateStoredWhatsAppUser,
} from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ number: string }> },
) {
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

  const { number: rawParam } = await params;
  const cleanNumber = normalizePhoneNumber(decodeURIComponent(rawParam));
  const existing = await getStoredWhatsAppUser(cleanNumber);

  if (
    !existing ||
    (existing.addedBy || '').toLowerCase() !== session.user.email.toLowerCase()
  ) {
    return NextResponse.json({ error: 'Number not found on your account.' }, { status: 404 });
  }

  const payload = await req.json().catch(() => null);
  const updated = await updateStoredWhatsAppUser(cleanNumber, {
    enabled: typeof payload?.enabled === 'boolean' ? payload.enabled : undefined,
    label: typeof payload?.label === 'string' ? payload.label : undefined,
  });

  if (updated) {
    await syncNumberToLiveBot(
      updated.number,
      `${updated.label || 'Member'} (${session.user.email})`,
      updated.enabled,
    );
  }

  const numbers = await listStoredWhatsAppUsers(session.user.email);
  return NextResponse.json({ ok: true, numbers });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ number: string }> },
) {
  const session = await getAuthenticatedSession(req);
  if (!session) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  }

  const { number: rawParam } = await params;
  const cleanNumber = normalizePhoneNumber(decodeURIComponent(rawParam));
  const existing = await getStoredWhatsAppUser(cleanNumber);

  if (
    !existing ||
    (existing.addedBy || '').toLowerCase() !== session.user.email.toLowerCase()
  ) {
    return NextResponse.json({ error: 'Number not found on your account.' }, { status: 404 });
  }

  await deleteStoredWhatsAppUser(cleanNumber);
  await removeNumberFromLiveBot(cleanNumber);

  const numbers = await listStoredWhatsAppUsers(session.user.email);
  return NextResponse.json({ ok: true, numbers });
}
