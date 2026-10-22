import { NextRequest, NextResponse } from 'next/server';
import { getAdminEmail, getAuthenticatedSession } from '@/lib/auth-engine';
import { fetchLiveBotStatus, getResolvedBotTarget } from '@/lib/bot-proxy';
import { JwtConfigError } from '@/lib/jwt';
import { listStoredWhatsAppUsers } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  let session;
  try {
    session = await getAuthenticatedSession(req);
  } catch (err) {
    if (err instanceof JwtConfigError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }

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
    botReachable: live.reachable,
    botError: live.error || null,
    botConnected: live.connected,
    botNumber: live.botNumber,
    numbers,
  });
}
