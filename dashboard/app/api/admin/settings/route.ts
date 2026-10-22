import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedSession } from '@/lib/auth-engine';
import { fetchLiveBotStatus, parseAndValidateBotUrl } from '@/lib/bot-proxy';
import { saveBotConnectionConfig, setFastPollWindow } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = await getAuthenticatedSession(req);
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

  if (typeof body.botApiUrl === 'string' && body.botApiUrl.trim()) {
    const parsed = parseAndValidateBotUrl(body.botApiUrl);
    if (parsed.error) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
  }

  const saved = await saveBotConnectionConfig({
    botApiUrl: typeof body.botApiUrl === 'string' ? body.botApiUrl : undefined,
    botAdminToken:
      typeof body.botAdminToken === 'string' && body.botAdminToken !== '••••••••'
        ? body.botAdminToken
        : undefined,
    botSyncToken:
      typeof body.botSyncToken === 'string' && body.botSyncToken !== '••••••••'
        ? body.botSyncToken
        : undefined,
    botEnabledForMembers:
      typeof body.botEnabledForMembers === 'boolean'
        ? body.botEnabledForMembers
        : undefined,
  });

  await setFastPollWindow(30_000).catch(() => {});

  const parsed = parseAndValidateBotUrl(saved.botApiUrl);
  const probe = parsed.baseUrl
    ? await fetchLiveBotStatus({
        baseUrl: parsed.baseUrl,
        token: saved.botAdminToken,
      })
    : await fetchLiveBotStatus();

  return NextResponse.json({
    ok: true,
    botApiUrl: saved.botApiUrl,
    hasBotToken: Boolean(saved.botAdminToken),
    hasBotSyncToken: Boolean(saved.botSyncToken),
    botEnabledForMembers: saved.botEnabledForMembers,
    probe,
  });
}
