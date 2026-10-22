import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedSession } from '@/lib/auth-engine';
import {
  forwardToBotServer,
  normalizePhoneNumber,
  resolveBotBaseUrl,
} from '@/lib/bot-proxy';
import { deleteStoredWhatsAppUser, updateStoredWhatsAppUser } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ number: string }> },
) {
  const session = await getAuthenticatedSession(req);
  if (!session) {
    return NextResponse.json(
      { error: 'Please sign in with your verified email account.' },
      { status: 401 },
    );
  }

  const { number: rawParam } = await params;
  const payload = await req.json().catch(() => null);
  if (!payload || typeof payload !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { baseUrl, hostLabel, error } = resolveBotBaseUrl(req);
  if (error) {
    return NextResponse.json({ error }, { status: 400 });
  }

  const cleanNumber = normalizePhoneNumber(decodeURIComponent(rawParam));

  if (baseUrl) {
    return forwardToBotServer(
      req,
      baseUrl,
      hostLabel,
      `/users/${encodeURIComponent(cleanNumber)}`,
      { method: 'PATCH', body: payload },
    );
  }

  const user = await updateStoredWhatsAppUser(cleanNumber, {
    enabled: typeof payload.enabled === 'boolean' ? payload.enabled : undefined,
    label: typeof payload.label === 'string' ? payload.label : undefined,
  });

  if (!user) {
    return NextResponse.json({ error: 'Approved number not found.' }, { status: 404 });
  }

  return NextResponse.json({ ok: true, user });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ number: string }> },
) {
  const session = await getAuthenticatedSession(req);
  if (!session) {
    return NextResponse.json(
      { error: 'Please sign in with your verified email account.' },
      { status: 401 },
    );
  }

  const { number: rawParam } = await params;
  const { baseUrl, hostLabel, error } = resolveBotBaseUrl(req);
  if (error) {
    return NextResponse.json({ error }, { status: 400 });
  }

  const cleanNumber = normalizePhoneNumber(decodeURIComponent(rawParam));

  if (baseUrl) {
    return forwardToBotServer(
      req,
      baseUrl,
      hostLabel,
      `/users/${encodeURIComponent(cleanNumber)}`,
      { method: 'DELETE' },
    );
  }

  const users = await deleteStoredWhatsAppUser(cleanNumber);
  return NextResponse.json({ ok: true, users });
}
