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
    let discoveryError = discovery.error || null;

    if (discovery.ok) {
      if (discovery.servers.length === 0) {
        discoveryError =
          'API key authenticated, but 0 servers were returned on this panel account. Make sure you created the hydro_… key under the exact XS Systems account that owns server ' +
          (saved.panelServerId || '32197077') +
          '.';
      } else if (
        !effectiveServerId ||
        !discovery.servers.some(
          (s) => s.id === effectiveServerId || s.uuid === effectiveServerId,
        )
      ) {
        // Auto-correct Server ID to match the actual server returned by the API key
        effectiveServerId = discovery.servers[0].id;
        await savePanelConnectionConfig({ panelServerId: effectiveServerId });
      }
    }

    return NextResponse.json({
      ok: true,
      panelUrl: saved.panelUrl,
      panelServerId: effectiveServerId,
      hasPanelApiKey: Boolean(saved.panelApiKey),
      discoveryOk: discovery.ok && discovery.servers.length > 0,
      discoveryError,
      matchedEndpoint: discovery.matchedEndpoint || null,
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
    let panelError: string | undefined;

    if (cfg.panelApiKey) {
      const res = await sendPanelPowerSignal(signal);
      if (res.ok) {
        return NextResponse.json({
          ok: true,
          via: 'panel-api',
          serverId: res.serverId,
          message: res.message,
        });
      }
      panelError = res.error;
    }

    // Automatic fallback when signal === 'restart' and the bot is online via outbound sync!
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
          message: panelError
            ? `Queued live restart directly to your online bot (picks up in ~2s). Panel API note: ${panelError}`
            : 'Queued restart command for the live bot (picks up in ~2s).',
        });
      }
    }

    return NextResponse.json(
      {
        error:
          panelError ||
          'Save your Hydrodactyl / Pterodactyl PANEL_API_KEY below first so the portal can restart or start the server directly.',
      },
      { status: panelError ? 404 : 400 },
    );
  }

  return NextResponse.json({ error: 'Unknown panel action.' }, { status: 400 });
}
