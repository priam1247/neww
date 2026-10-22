import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedSession } from '@/lib/auth-engine';
import { JwtConfigError } from '@/lib/jwt';
import {
  discoverPanelServers,
  normalizePanelBaseUrl,
  sendPanelPowerSignal,
} from '@/lib/panel-client';
import {
  enqueueBotCommand,
  getBotHeartbeat,
  getPanelConnectionConfig,
  savePanelConnectionConfig,
} from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
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
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  }
  if (!session.user.isAdmin) {
    return NextResponse.json(
      { error: 'Administrator privileges required.' },
      { status: 403 },
    );
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const action = String(body.action || 'save_and_discover');

  if (action === 'save_and_discover') {
    if (typeof body.panelUrl === 'string' && body.panelUrl.trim()) {
      const check = normalizePanelBaseUrl(body.panelUrl);
      if (check.error) {
        return NextResponse.json({ error: check.error }, { status: 400 });
      }
    }

    const saved = await savePanelConnectionConfig({
      panelUrl:
        typeof body.panelUrl === 'string' ? body.panelUrl : undefined,
      panelServerId:
        typeof body.panelServerId === 'string' ? body.panelServerId : undefined,
      panelApiKey:
        typeof body.panelApiKey === 'string' && body.panelApiKey !== '••••••••'
          ? body.panelApiKey
          : undefined,
    });

    if (!saved.panelApiKey) {
      return NextResponse.json({
        ok: true,
        panelUrl: saved.panelUrl,
        panelServerId: saved.panelServerId,
        hasPanelApiKey: false,
        servers: [],
      });
    }

    const discovery = await discoverPanelServers({
      panelUrl: saved.panelUrl,
      panelApiKey: saved.panelApiKey,
    });

    let effectiveServerId = saved.panelServerId;
    if (discovery.ok && !effectiveServerId && discovery.servers.length > 0) {
      effectiveServerId = discovery.servers[0].id;
      await savePanelConnectionConfig({ panelServerId: effectiveServerId });
    }

    return NextResponse.json({
      ok: true,
      panelUrl: saved.panelUrl,
      panelServerId: effectiveServerId,
      hasPanelApiKey: Boolean(saved.panelApiKey),
      discoveryOk: discovery.ok,
      discoveryError: discovery.error || null,
      servers: discovery.servers,
    });
  }

  if (action === 'power') {
    const rawSignal = String(body.signal || 'restart').toLowerCase();
    if (!['restart', 'start', 'stop', 'kill'].includes(rawSignal)) {
      return NextResponse.json(
        { error: 'Unsupported power signal.' },
        { status: 400 },
      );
    }
    const signal = rawSignal as 'restart' | 'start' | 'stop' | 'kill';

    const cfg = await getPanelConnectionConfig();
    if (cfg.panelApiKey) {
      const res = await sendPanelPowerSignal(signal);
      if (!res.ok) {
        return NextResponse.json(
          { error: res.error || 'Panel power request failed.' },
          { status: res.status },
        );
      }
      return NextResponse.json({
        ok: true,
        via: 'panel-api',
        serverId: res.serverId,
        message: res.message,
      });
    }

    // Fallback: if panel API key isn't configured on dashboard, queue restart to live bot heartbeat
    if (signal === 'restart') {
      const hb = await getBotHeartbeat();
      if (hb && Date.now() - hb.lastSeenAt <= 45_000) {
        await enqueueBotCommand({
          type: 'restart',
          payload: {},
          requestedBy: session.user.email,
          ttlMs: 45_000,
        });
        return NextResponse.json({
          ok: true,
          via: 'bot-queue',
          message:
            'Queued restart command for the live bot (picks up within a few seconds). Save PANEL_API_KEY in Panel Control to also restart when the bot is offline.',
        });
      }
    }

    return NextResponse.json(
      {
        error:
          'Save your Hydrodactyl / Pterodactyl PANEL_API_KEY below first so the portal can restart or start the server directly.',
      },
      { status: 400 },
    );
  }

  return NextResponse.json({ error: 'Unknown panel action.' }, { status: 400 });
}
