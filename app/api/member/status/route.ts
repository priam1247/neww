import { NextRequest, NextResponse } from 'next/server';
import { getAdminEmail, getAuthenticatedSession } from '@/lib/auth-engine';
import { fetchLiveBotStatus, getResolvedBotTarget } from '@/lib/bot-proxy';
import { listStoredWhatsAppUsers } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = await getAuthenticatedSession(req);
  if (!session) {
    return NextResponse.json(
      { error: 'Please sign in with your email first.' },
      { status: 401 },
    );
  }

  const [target, numbers] = await Promise.all([
    getResolvedBotTarget(),
    listStoredWhatsAppUsers(session.user.email),
  ]);

  const live = target.baseUrl
    ? await fetchLiveBotStatus({ baseUrl: target.baseUrl, token: target.token })
    : { reachable: false, connected: false, botNumber: null };

  return NextResponse.json({
    ok: true,
    adminEmail: getAdminEmail(),
    memberAllowed: session.user.memberAllowed,
    botEnabledForMembers: target.botEnabledForMembers,
    botServerLinked: Boolean(target.baseUrl && target.token),
    botConnected: live.connected,
    botNumber: live.botNumber,
    numbers,
  });
}
