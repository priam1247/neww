import { NextRequest, NextResponse } from 'next/server';
import {
  forwardToBotServer,
  getAdminEmail,
  resolveBotBaseUrl,
  verifyServerTokenIfConfigured,
} from '@/lib/bot-proxy';
import { getSandboxState } from '@/lib/sandbox-store';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { baseUrl, hostLabel, error } = resolveBotBaseUrl(req);
  if (error) {
    return NextResponse.json({ error }, { status: 400 });
  }

  if (baseUrl) {
    const authErr = verifyServerTokenIfConfigured(req);
    if (authErr) return authErr;
    return forwardToBotServer(req, baseUrl, hostLabel, '/status', { method: 'GET' });
  }

  const state = getSandboxState();
  return NextResponse.json({
    ok: true,
    mode: 'sandbox',
    upstreamConfigured: false,
    upstreamHost: null,
    adminEmail: getAdminEmail(),
    connected: state.botConnected,
    botNumber: state.botNumber,
    users: state.users,
  });
}
