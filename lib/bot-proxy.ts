import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

const DEFAULT_ADMIN_EMAIL =
  process.env.NEXT_PUBLIC_ADMIN_EMAIL || 'troykunsauka6@gmail.com';

export function getAdminEmail(): string {
  return DEFAULT_ADMIN_EMAIL;
}

/**
 * Safely parse and normalize an upstream Bot API URL (either from UI override
 * header `x-bot-api-url` or from server `process.env.BOT_API_URL`).
 */
export function resolveBotBaseUrl(req: NextRequest): {
  baseUrl: string | null;
  hostLabel: string | null;
  error?: string;
} {
  const forcedSandbox = req.headers.get('x-force-sandbox') === '1';
  if (forcedSandbox) {
    return { baseUrl: null, hostLabel: null };
  }

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
    // Strip trailing `/admin` or trailing slashes so `/admin/api/...` joins cleanly
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

export function extractBearerToken(req: NextRequest): string {
  const auth = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();
  const custom = req.headers.get('x-admin-token')?.trim();
  return auth || custom || '';
}

function safeTokenMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Verify dashboard token when server-side `ADMIN_DASHBOARD_TOKEN` is set.
 * Returns null when authorized, or a 401 NextResponse when rejected.
 */
export function verifyServerTokenIfConfigured(req: NextRequest): NextResponse | null {
  const expected = process.env.ADMIN_DASHBOARD_TOKEN?.trim();
  if (!expected) return null;

  const provided = extractBearerToken(req);
  if (!provided || !safeTokenMatch(provided, expected)) {
    return NextResponse.json(
      { error: `Valid admin dashboard token required for ${DEFAULT_ADMIN_EMAIL}.` },
      { status: 401 },
    );
  }
  return null;
}

/**
 * Forward a request from Vercel's server runtime to `${baseUrl}/admin/api${subpath}`
 * on ZaFar Bot's `admin-server.js`. Avoids browser Mixed Content & CORS issues completely.
 */
export async function forwardToBotServer(
  req: NextRequest,
  baseUrl: string,
  hostLabel: string | null,
  subpath: string,
  options: { method: string; body?: unknown },
): Promise<NextResponse> {
  const clientToken = extractBearerToken(req);
  const serverToken = process.env.ADMIN_DASHBOARD_TOKEN?.trim() || '';
  const bearer = clientToken || serverToken;

  if (!bearer) {
    return NextResponse.json(
      {
        error:
          'Enter your Admin Dashboard Token (matching ADMIN_DASHBOARD_TOKEN on the bot server).',
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
            `Bot server responded with HTTP ${upstreamRes.status}. Check your token and bot URL.`,
        },
        { status: upstreamRes.status },
      );
    }

    return NextResponse.json(
      {
        ...data,
        mode: 'live',
        upstreamConfigured: true,
        upstreamHost: hostLabel,
        latencyMs,
      },
      { status: upstreamRes.status },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Connection failed';
    return NextResponse.json(
      {
        error: `Could not reach bot server at ${hostLabel || baseUrl} (${message}). Ensure admin-server.js is running and its port is reachable, or switch to Sandbox Preview.`,
      },
      { status: 502 },
    );
  }
}
