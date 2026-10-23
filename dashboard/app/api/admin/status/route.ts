import { NextRequest, NextResponse } from 'next/server';
import {
  getAdminEmail,
  getAuthenticatedSession,
  isAdminEmail,
} from '@/lib/auth-engine';
import { fetchLiveBotStatus, getResolvedBotTarget } from '@/lib/bot-proxy';
import { JwtConfigError } from '@/lib/jwt';
import {
  getPanelConnectionConfig,
  isUsingCloudflareD1,
  listAllMembers,
  listStoredWhatsAppUsers,
} from '@/lib/storage';

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

  const [target, panelCfg, d1Active, users, members, liveStatus] =
    await Promise.all([
      getResolvedBotTarget(),
      getPanelConnectionConfig(),
      isUsingCloudflareD1(),
      listStoredWhatsAppUsers(),
      listAllMembers(isAdminEmail),
      fetchLiveBotStatus(),
    ]);

  const botLinked =
    liveStatus.connectionMode === 'heartbeat' ||
    Boolean(target.baseUrl && target.token);

  return NextResponse.json({
    ok: true,
    adminEmail: getAdminEmail(),
    botServerLinked: botLinked,
    connectionMode: liveStatus.connectionMode,
    botApiUrl: target.rawUrl,
    hasBotToken: Boolean(target.token),
    hasBotSyncToken: Boolean(target.syncToken),
    isInsecureHttp: target.isInsecureHttp,
    botEnabledForMembers: target.botEnabledForMembers,
    storageEngine: liveStatus.reachable
      ? 'bot-live'
      : d1Active
        ? 'cloudflare-d1'
        : 'persistent-db',
    upstreamHost: target.hostLabel,
    botReachable: liveStatus.reachable,
    botError: liveStatus.error || null,
    connected: liveStatus.connected,
    botNumber: liveStatus.botNumber,
    lastSeenAt: liveStatus.lastSeenAt ?? null,
    lastSeenSecondsAgo: liveStatus.lastSeenSecondsAgo ?? null,
    botVersion: liveStatus.version ?? null,
    uptimeSeconds: liveStatus.uptimeSeconds ?? null,
    commandsTotal: liveStatus.commandsTotal ?? 0,
    downloadsSuccess: liveStatus.downloadsSuccess ?? 0,
    failedTotal: liveStatus.failedTotal ?? 0,
    ramUsedMB: liveStatus.ramUsedMB ?? null,
    diskUsedMB: liveStatus.diskUsedMB ?? null,
    diskBudgetMB: liveStatus.diskBudgetMB ?? null,
    queueLight: liveStatus.queueLight ?? null,
    queueHeavy: liveStatus.queueHeavy ?? null,
    panelConfigured: Boolean(panelCfg.panelApiKey),
    panelUrl: panelCfg.panelUrl,
    panelServerId: panelCfg.panelServerId,
    hasPanelApiKey: Boolean(panelCfg.panelApiKey),
    latencyMs: liveStatus.latencyMs,
    users,
    members,
  });
}
