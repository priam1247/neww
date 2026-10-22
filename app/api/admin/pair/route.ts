import { NextRequest, NextResponse } from 'next/server';
import {
  forwardToBotServer,
  resolveBotBaseUrl,
  verifyServerTokenIfConfigured,
} from '@/lib/bot-proxy';
import {
  generateDemoPairingCode,
  getSandboxState,
  normalizePhoneNumber,
} from '@/lib/sandbox-store';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const payload = await req.json().catch(() => null);
  if (!payload || typeof payload !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const { baseUrl, hostLabel, error } = resolveBotBaseUrl(req);
  if (error) {
    return NextResponse.json({ error }, { status: 400 });
  }

  const number = normalizePhoneNumber(payload.number);

  if (baseUrl) {
    const authErr = verifyServerTokenIfConfigured(req);
    if (authErr) return authErr;
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

  const state = getSandboxState();
  const approved = state.users.some((u) => u.number === number && u.enabled);
  if (!approved) {
    return NextResponse.json(
      { error: 'Approve and enable this number before requesting a linking code.' },
      { status: 403 },
    );
  }

  return NextResponse.json({
    ok: true,
    mode: 'sandbox',
    code: generateDemoPairingCode(),
    expiresInSeconds: 60,
    number,
    issuedAt: Date.now(),
  });
}
