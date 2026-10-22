import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedSession, isAdminEmail } from '@/lib/auth-engine';
import { syncNumberToLiveBot } from '@/lib/bot-proxy';
import {
  listAllMembers,
  listStoredWhatsAppUsers,
  setMemberPermission,
} from '@/lib/storage';

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

  const body = await req.json().catch(() => null);
  const email = String(body?.email || '').trim().toLowerCase();
  const name = String(body?.name || '').trim().slice(0, 80);
  const allowed = body?.allowed !== false;

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json(
      { error: 'Enter a valid member email address.' },
      { status: 400 },
    );
  }

  await setMemberPermission(email, isAdminEmail(email) ? true : allowed, name);
  const members = await listAllMembers(isAdminEmail);
  return NextResponse.json({ ok: true, members }, { status: 201 });
}

export async function PATCH(req: NextRequest) {
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

  const body = await req.json().catch(() => null);
  const email = String(body?.email || '').trim().toLowerCase();
  const allowed = Boolean(body?.allowed);

  if (!email) {
    return NextResponse.json({ error: 'Member email required.' }, { status: 400 });
  }
  if (isAdminEmail(email) && !allowed) {
    return NextResponse.json(
      { error: 'The primary administrator account cannot be disallowed.' },
      { status: 400 },
    );
  }

  await setMemberPermission(email, allowed, String(body?.name || ''));

  // Cascade member's allow/disallow status across their linked WhatsApp numbers on the live bot
  const memberNumbers = await listStoredWhatsAppUsers(email);
  await Promise.all(
    memberNumbers.map((item) =>
      syncNumberToLiveBot(item.number, item.label || email, allowed),
    ),
  );

  const [members, users] = await Promise.all([
    listAllMembers(isAdminEmail),
    listStoredWhatsAppUsers(),
  ]);

  return NextResponse.json({ ok: true, members, users });
}
