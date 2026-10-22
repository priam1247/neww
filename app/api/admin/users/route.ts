import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedSession } from '@/lib/auth-engine';
import {
  forwardToBotServer,
  normalizePhoneNumber,
  resolveBotBaseUrl,
} from '@/lib/bot-proxy';
import { saveStoredWhatsAppUser } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = await getAuthenticatedSession(req);
  if (!session) {
    return NextResponse.json(
      { error: 'Please sign in with your verified email account.' },
      { status: 401 },
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
    String(payload.label || session.user.name || 'Approved operator')
      .trim()
      .slice(0, 80) || 'Approved operator';

  const { baseUrl, hostLabel, error } = resolveBotBaseUrl(req);
  if (error) {
    return NextResponse.json({ error }, { status: 400 });
  }

  if (baseUrl) {
    return forwardToBotServer(req, baseUrl, hostLabel, '/users', {
      method: 'POST',
      body: { number, label },
    });
  }

  const users = await saveStoredWhatsAppUser(number, label, session.user.email);
  return NextResponse.json({ ok: true, users }, { status: 201 });
}
