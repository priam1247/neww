import { NextRequest, NextResponse } from 'next/server';
import {
  forwardToBotServer,
  resolveBotBaseUrl,
  verifyServerTokenIfConfigured,
} from '@/lib/bot-proxy';
import { getSandboxState, normalizePhoneNumber } from '@/lib/sandbox-store';

export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ number: string }> },
) {
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
    const authErr = verifyServerTokenIfConfigured(req);
    if (authErr) return authErr;
    return forwardToBotServer(
      req,
      baseUrl,
      hostLabel,
      `/users/${encodeURIComponent(cleanNumber)}`,
      { method: 'PATCH', body: payload },
    );
  }

  const state = getSandboxState();
  const user = state.users.find((item) => item.number === cleanNumber);
  if (!user) {
    return NextResponse.json({ error: 'User not found.' }, { status: 404 });
  }

  if (typeof payload.enabled === 'boolean') {
    user.enabled = payload.enabled;
  }
  if (typeof payload.label === 'string' && payload.label.trim()) {
    user.label = payload.label.trim().slice(0, 80);
  }

  return NextResponse.json({ ok: true, mode: 'sandbox', user });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ number: string }> },
) {
  const { number: rawParam } = await params;
  const { baseUrl, hostLabel, error } = resolveBotBaseUrl(req);
  if (error) {
    return NextResponse.json({ error }, { status: 400 });
  }

  const cleanNumber = normalizePhoneNumber(decodeURIComponent(rawParam));

  if (baseUrl) {
    const authErr = verifyServerTokenIfConfigured(req);
    if (authErr) return authErr;
    return forwardToBotServer(
      req,
      baseUrl,
      hostLabel,
      `/users/${encodeURIComponent(cleanNumber)}`,
      { method: 'DELETE' },
    );
  }

  const state = getSandboxState();
  state.users = state.users.filter((item) => item.number !== cleanNumber);
  return NextResponse.json({ ok: true, mode: 'sandbox', users: state.users });
}
