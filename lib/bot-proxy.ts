import { getBotConnectionConfig } from './storage';

export function normalizePhoneNumber(input: unknown): string {
  return String(input ?? '').replace(/[^0-9]/g, '');
}

export function parseAndValidateBotUrl(rawUrl: string): {
  baseUrl: string | null;
  hostLabel: string | null;
  error?: string;
} {
  const raw = rawUrl.trim();
  if (!raw) return { baseUrl: null, hostLabel: null };

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
    return {
      baseUrl: `${parsed.origin}${cleanPath}`,
      hostLabel: parsed.host,
    };
  } catch {
    return {
      baseUrl: null,
      hostLabel: null,
      error:
        'Invalid Bot Server URL format (expected e.g. https://your-bot.koyeb.app or http://203.0.113.10:3000)',
    };
  }
}

export async function getResolvedBotTarget(): Promise<{
  baseUrl: string | null;
  hostLabel: string | null;
  token: string;
  botEnabledForMembers: boolean;
  rawUrl: string;
}> {
  const cfg = await getBotConnectionConfig();
  const parsed = parseAndValidateBotUrl(cfg.botApiUrl);
  return {
    baseUrl: parsed.baseUrl,
    hostLabel: parsed.hostLabel,
    token: cfg.botAdminToken,
    botEnabledForMembers: cfg.botEnabledForMembers,
    rawUrl: cfg.botApiUrl,
  };
}

export async function fetchLiveBotStatus(customTarget?: {
  baseUrl: string;
  token: string;
}): Promise<{
  reachable: boolean;
  connected: boolean;
  botNumber: string | null;
  latencyMs?: number;
  error?: string;
}> {
  const resolved = customTarget || (await getResolvedBotTarget());
  if (!resolved.baseUrl) {
    return { reachable: false, connected: false, botNumber: null };
  }
  if (!resolved.token) {
    return {
      reachable: false,
      connected: false,
      botNumber: null,
      error: 'ADMIN_DASHBOARD_TOKEN is not set yet.',
    };
  }

  const startedAt = Date.now();
  try {
    const res = await fetch(`${resolved.baseUrl}/admin/api/status`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${resolved.token}`,
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    });
    const latencyMs = Date.now() - startedAt;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        reachable: false,
        connected: false,
        botNumber: null,
        latencyMs,
        error: data?.error || `Bot server returned HTTP ${res.status}`,
      };
    }
    return {
      reachable: true,
      connected: Boolean(data.connected),
      botNumber: data.botNumber ? String(data.botNumber) : null,
      latencyMs,
    };
  } catch (err) {
    return {
      reachable: false,
      connected: false,
      botNumber: null,
      error: err instanceof Error ? err.message : 'Unable to reach bot server',
    };
  }
}

/**
 * Push a number state change to the live bot (`admin-server.js`) whenever
 * a Bot Server URL + Token is configured. Fails softly if bot is offline so
 * D1 records always remain authoritative.
 */
export async function syncNumberToLiveBot(
  number: string,
  label: string,
  enabled: boolean,
): Promise<void> {
  const { baseUrl, token } = await getResolvedBotTarget();
  if (!baseUrl || !token) return;

  try {
    await fetch(`${baseUrl}/admin/api/users`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ number, label }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });

    if (!enabled) {
      await fetch(`${baseUrl}/admin/api/users/${encodeURIComponent(number)}`, {
        method: 'PATCH',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ enabled: false }),
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      });
    }
  } catch {
    // D1 state remains saved even when bot container restarts
  }
}

export async function removeNumberFromLiveBot(number: string): Promise<void> {
  const { baseUrl, token } = await getResolvedBotTarget();
  if (!baseUrl || !token) return;

  try {
    await fetch(`${baseUrl}/admin/api/users/${encodeURIComponent(number)}`, {
      method: 'DELETE',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // ignore if bot offline
  }
}

export async function requestLiveBotPairingCode(
  number: string,
  label: string,
): Promise<{
  ok: boolean;
  status: number;
  code?: string;
  expiresInSeconds?: number;
  error?: string;
}> {
  const { baseUrl, token } = await getResolvedBotTarget();
  if (!baseUrl || !token) {
    return {
      ok: false,
      status: 400,
      error:
        'The live WhatsApp Bot Server is not linked yet. Ask the administrator (troykunsauka@gmail.com) to link the Bot Server URL in the Admin Console.',
    };
  }

  try {
    // Ensure number is registered and enabled on the running bot container first
    await fetch(`${baseUrl}/admin/api/users`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ number, label }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });

    await fetch(`${baseUrl}/admin/api/users/${encodeURIComponent(number)}`, {
      method: 'PATCH',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ enabled: true }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });

    const res = await fetch(`${baseUrl}/admin/api/pair`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ number }),
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: data?.error || `Bot server returned HTTP ${res.status}`,
      };
    }

    return {
      ok: true,
      status: 200,
      code: String(data.code),
      expiresInSeconds: Number(data.expiresInSeconds) || 60,
    };
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: `Could not reach live WhatsApp bot server (${
        err instanceof Error ? err.message : 'connection failed'
      }).`,
    };
  }
}
