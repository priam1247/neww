import { NextRequest, NextResponse } from 'next/server';
import {
  forwardToBotServer,
  resolveBotBaseUrl,
  verifyServerTokenIfConfigured,
} from '@/lib/bot-proxy';
import { getSandboxState, normalizePhoneNumber } from '@/lib/sandbox-store';

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

  if (baseUrl) {
    const authErr = verifyServerTokenIfConfigured(req);
    if (authErr) return authErr;
    return forwardToBotServer(req, baseUrl, hostLabel, '/users', {
      method: 'POST',
      body: payload,
    });
  }

  const number = normalizePhoneNumber(payload.number);
  if (number.length < 8 || number.length > 15) {
    return NextResponse.json(
      { error: 'Enter a valid international number (8–15 digits).' },
      { status: 400 },
    );
  }

  const label = String(payload.label || 'Approved user').trim().slice(0, 80) || 'Approved user';
  const state = getSandboxState();

  const existing = state.users.find((u) => u.number === number);
  if (existing) {
    existing.enabled = true;
    if (payload.label) existing.label = label;
  } else {
    state.users.unshift({
      number,
      label,
      enabled: true,
      addedAt: new Date().toISOString(),
    });
  }

  return NextResponse.json(
    { ok: true, mode: 'sandbox', users: state.users },
    { status: 201 },
  );
}
