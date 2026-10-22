import { NextRequest, NextResponse } from 'next/server';
import {
  getAdminEmail,
  getAuthenticatedSession,
  isAdminEmail,
} from '@/lib/auth-engine';
import { fetchLiveBotStatus, getResolvedBotTarget } from '@/lib/bot-proxy';
import {
  isUsingCloudflareD1,
  listAllMembers,
  listStoredWhatsAppUsers,
} from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await getAuthenticatedSession(req);
  if (!session) {
    return NextResponse.json(
      { error: 'Please sign in with your administrator email.' },
      { status: 401 },
    );
  }
  if (!session.user.isAdmin) {
    return NextResponse.json(
      { error: 'Administrator privileges required.' },
      { status: 403 },
    );
  }

  const [target, d1Active, users, members] = await Promise.all([
    getResolvedBotTarget(),
    isUsingCloudflareD1(),
    listStoredWhatsAppUsers(),
    listAllMembers(isAdminEmail),
  ]);

  const liveStatus = target.baseUrl
    ? await fetchLiveBotStatus({ baseUrl: target.baseUrl, token: target.token })
    : { reachable: false, connected: false, botNumber: null };

  return NextResponse.json({
    ok: true,
    adminEmail: getAdminEmail(),
    botServerLinked: Boolean(target.baseUrl && target.token),
    botApiUrl: target.rawUrl,
    hasBotToken: Boolean(target.token),
    botEnabledForMembers: target.botEnabledForMembers,
    storageEngine: liveStatus.reachable
      ? 'bot-live'
      : d1Active
        ? 'cloudflare-d1'
        : 'persistent-db',
    upstreamHost: target.hostLabel,
    connected: liveStatus.connected,
    botNumber: liveStatus.botNumber,
    latencyMs: liveStatus.latencyMs,
    users,
    members,
  });
}
