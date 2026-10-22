import { getBotConnectionConfig } from './storage';

const STATUS_TIMEOUT_MS = 3_000;
const SYNC_TIMEOUT_MS = 2_500;
const PAIR_TIMEOUT_MS = 10_000;

export function normalizePhoneNumber(input: unknown): string {
  return String(input ?? '').replace(/[^0-9]/g, '');
}

export function parseAndValidateBotUrl(rawUrl: string): {
  baseUrl: string | null;
  hostLabel: string | null;
  isInsecureHttp?: boolean;
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
    const isLocalhost =
      parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    return {
      baseUrl: `${parsed.origin}${cleanPath}`,
      hostLabel: parsed.host,
      isInsecureHttp: parsed.protocol === 'http:' && !isLocalhost,
    };
  } catch {
    return {
      baseUrl: null,
      hostLabel: null,
      error:
        'Invalid Bot Server URL format (expected e.g. https://bot-tunnel.trycloudflare.com or http://203.0.113.10:3000)',
    };
  }
}

export async function getResolvedBotTarget(): Promise<{
  baseUrl: string | null;
  hostLabel: string | null;
  isInsecureHttp: boolean;
  token: string;
  botEnabledForMembers: boolean;
  rawUrl: string;
}> {
  const cfg = await getBotConnectionConfig();
  const parsed = parseAndValidateBotUrl(cfg.botApiUrl);
  return {
    baseUrl: parsed.baseUrl,
    hostLabel: parsed.hostLabel,
    isInsecureHttp: Boolean(parsed.isInsecureHttp),
    token: cfg.botAdminToken,
    botEnabledForMembers: cfg.botEnabledForMembers,
    rawUrl: cfg.botApiUrl,
  };
}

function humanizeBotFetchError(err: unknown): string {
  const raw = err instanceof Error ? err.message : 'Unable to reach bot server';
  if (/aborted|timeout/i.test(raw)) {
    return 'Bot server offline or unreachable (timed out after 3s).';
  }
  if (/ECONNREFUSED|fetch failed/i.test(raw)) {
    return 'Bot server offline or port closed.';
  }
  return raw;
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
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - startedAt;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errorMsg =
        res.status === 401
          ? 'ADMIN_DASHBOARD_TOKEN mismatch (bot rejected token with HTTP 401).'
          : data?.error || `Bot server returned HTTP ${res.status}`;
      return {
        reachable: false,
        connected: false,
        botNumber: null,
        latencyMs,
        error: errorMsg,
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
      error: humanizeBotFetchError(err),
    };
  }
}

/**
 * Push a number state change to the live bot (`utils/adminApi.js`) whenever
 * a Bot Server URL + Token is configured. Fails fast if the bot is offline so
 * D1 records always remain authoritative without blocking the portal UI.
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
      body: JSON.stringify({ number, label, enabled }),
      cache: 'no-store',
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    });
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
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
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
        'The live WhatsApp Bot Server is not linked yet. Ask the administrator to link the Bot Server URL in the Admin Console.',
    };
  }

  try {
    await fetch(`${baseUrl}/admin/api/users`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ number, label, enabled: true }),
      cache: 'no-store',
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
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
      signal: AbortSignal.timeout(PAIR_TIMEOUT_MS),
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
      error: humanizeBotFetchError(err),
    };
  }
}
