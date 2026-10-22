import { NextRequest, NextResponse } from 'next/server';
import { getAdminEmail } from './auth-engine';

export function normalizePhoneNumber(input: unknown): string {
  return String(input ?? '').replace(/[^0-9]/g, '');
}

/**
 * Safely parse and normalize an upstream Bot API URL (either from Admin UI
 * header `x-bot-api-url` or server `process.env.BOT_API_URL`).
 */
export function resolveBotBaseUrl(req: NextRequest): {
  baseUrl: string | null;
  hostLabel: string | null;
  error?: string;
} {
  const headerOverride = req.headers.get('x-bot-api-url')?.trim() || '';
  const envUrl = process.env.BOT_API_URL?.trim() || '';
  const raw = headerOverride || envUrl;

  if (!raw) {
    return { baseUrl: null, hostLabel: null };
  }

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        baseUrl: null,
        hostLabel: null,
        error: 'Bot Server URL must start with http:// or https://',
      };
    }
    const cleanPath = parsed.pathname
      .replace(/\/admin\/api\/?$/i, '')
      .replace(/\/admin\/?$/i, '')
      .replace(/\/+$/, '');
    const normalized = `${parsed.origin}${cleanPath}`;
    return { baseUrl: normalized, hostLabel: parsed.host };
  } catch {
    return {
      baseUrl: null,
      hostLabel: null,
      error: 'Invalid Bot Server URL format (expected e.g. http://203.0.113.10:3000)',
    };
  }
}

/**
 * Forward an authenticated operator request from Next.js server runtime to
 * `${baseUrl}/admin/api${subpath}` on ZaFar Bot's `admin-server.js`.
 */
export async function forwardToBotServer(
  req: NextRequest,
  baseUrl: string,
  hostLabel: string | null,
  subpath: string,
  options: { method: string; body?: unknown },
): Promise<NextResponse> {
  const clientBotToken = req.headers.get('x-admin-token')?.trim() || '';
  const serverBotToken = process.env.ADMIN_DASHBOARD_TOKEN?.trim() || '';
  const bearer = clientBotToken || serverBotToken;

  if (!bearer) {
    return NextResponse.json(
      {
        error: `Set your Bot Server Token (ADMIN_DASHBOARD_TOKEN for ${getAdminEmail()}) in Bot Connection settings.`,
      },
      { status: 401 },
    );
  }

  const startedAt = Date.now();
  try {
    const upstreamRes = await fetch(`${baseUrl}/admin/api${subpath}`, {
      method: options.method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });

    const latencyMs = Date.now() - startedAt;
    const data = await upstreamRes.json().catch(() => ({}));

    if (!upstreamRes.ok) {
      return NextResponse.json(
        {
          error:
            data?.error ||
            `Bot server responded with HTTP ${upstreamRes.status}. Verify your ADMIN_DASHBOARD_TOKEN and Bot URL.`,
        },
        { status: upstreamRes.status },
      );
    }

    return NextResponse.json(
      {
        ...data,
        botServerLinked: true,
        storageEngine: 'bot-live',
        upstreamHost: hostLabel,
        latencyMs,
      },
      { status: upstreamRes.status },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Connection failed';
    return NextResponse.json(
      {
        error: `Could not reach live bot server at ${hostLabel || baseUrl} (${message}).`,
      },
      { status: 502 },
    );
  }
}
