import { NextRequest, NextResponse } from 'next/server';
import { getAdminEmail, getAuthenticatedSession } from '@/lib/auth-engine';
import { forwardToBotServer, resolveBotBaseUrl } from '@/lib/bot-proxy';
import { isUsingCloudflareD1, listStoredWhatsAppUsers } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await getAuthenticatedSession(req);
  if (!session) {
    return NextResponse.json(
      { error: 'Please sign in with your verified email account.' },
      { status: 401 },
    );
  }

  const { baseUrl, hostLabel, error } = resolveBotBaseUrl(req);
  if (error) {
    return NextResponse.json({ error }, { status: 400 });
  }

  if (baseUrl) {
    return forwardToBotServer(req, baseUrl, hostLabel, '/status', { method: 'GET' });
  }

  const [users, d1Active] = await Promise.all([
    listStoredWhatsAppUsers(),
    isUsingCloudflareD1(),
  ]);

  return NextResponse.json({
    ok: true,
    botServerLinked: false,
    storageEngine: d1Active ? 'cloudflare-d1' : 'persistent-db',
    upstreamHost: null,
    adminEmail: getAdminEmail(),
    connected: false,
    botNumber: null,
    users,
  });
}
