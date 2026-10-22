import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedSession } from '@/lib/auth-engine';
import {
  forwardToBotServer,
  normalizePhoneNumber,
  resolveBotBaseUrl,
} from '@/lib/bot-proxy';

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

  const { baseUrl, hostLabel, error } = resolveBotBaseUrl(req);
  if (error) {
    return NextResponse.json({ error }, { status: 400 });
  }

  if (!baseUrl) {
    return NextResponse.json(
      {
        error:
          'Connect your live WhatsApp Bot Server URL first (Bot Connection button in the top bar) to generate a real WhatsApp linking code.',
      },
      { status: 400 },
    );
  }

  const number = normalizePhoneNumber(payload.number);
  const proxied = await forwardToBotServer(req, baseUrl, hostLabel, '/pair', {
    method: 'POST',
    body: { number },
  });
  if (!proxied.ok) return proxied;

  const body = await proxied.json();
  return NextResponse.json({
    ...body,
    number,
    issuedAt: Date.now(),
  });
}
