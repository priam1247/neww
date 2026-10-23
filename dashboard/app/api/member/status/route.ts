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

  const [target, numbers, live] = await Promise.all([
    getResolvedBotTarget(),
    listStoredWhatsAppUsers(session.user.email),
    fetchLiveBotStatus(),
  ]);

  const botLinked =
    live.connectionMode === 'heartbeat' ||
    Boolean(target.baseUrl && target.token);

  return NextResponse.json({
    ok: true,
    adminEmail: getAdminEmail(),
    memberAllowed: session.user.memberAllowed,
    botEnabledForMembers: target.botEnabledForMembers,
    botServerLinked: botLinked,
    botReachable: live.reachable,
    botError: live.error || null,
    lastSeenSecondsAgo: live.lastSeenSecondsAgo ?? null,
    botConnected: live.connected,
    botNumber: live.botNumber,
    uptimeSeconds: live.uptimeSeconds ?? null,
    commandsTotal: live.commandsTotal ?? 0,
    downloadsSuccess: live.downloadsSuccess ?? 0,
    failedTotal: live.failedTotal ?? 0,
    ramUsedMB: live.ramUsedMB ?? null,
    diskUsedMB: live.diskUsedMB ?? null,
    diskBudgetMB: live.diskBudgetMB ?? null,
    queueLight: live.queueLight ?? null,
    queueHeavy: live.queueHeavy ?? null,
    numbers,
  });
}
