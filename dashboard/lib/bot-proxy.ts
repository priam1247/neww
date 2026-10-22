import {
  enqueueBotCommand,
  getBotCommandById,
  getBotConnectionConfig,
  getBotHeartbeat,
  setFastPollWindow,
} from './storage';

const STATUS_TIMEOUT_MS = 3_000;
const SYNC_TIMEOUT_MS = 2_500;
const PAIR_TIMEOUT_MS = 10_000;
export const HEARTBEAT_FRESH_SECONDS = 45;

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
        'Invalid Bot Server URL format (expected e.g. https://bot-tunnel.trycloudflare.com or leave blank to use outbound Bot Heartbeat Sync)',
    };
  }
}

export async function getResolvedBotTarget(): Promise<{
  baseUrl: string | null;
  hostLabel: string | null;
  isInsecureHttp: boolean;
  token: string;
  syncToken: string;
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
    syncToken: cfg.botSyncToken,
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
  connectionMode: 'heartbeat' | 'direct' | 'unconfigured';
  lastSeenAt?: number | null;
  lastSeenSecondsAgo?: number | null;
  version?: string | null;
  diskUsedMB?: number | null;
  diskBudgetMB?: number | null;
  queueLight?: number | null;
  queueHeavy?: number | null;
  latencyMs?: number;
  error?: string;
}> {
  // When not probing a specific custom URL, check bot-initiated HTTPS heartbeat first!
  if (!customTarget) {
    const hb = await getBotHeartbeat();
    if (hb) {
      const ageSec = Math.max(0, Math.floor((Date.now() - hb.lastSeenAt) / 1000));
      if (ageSec <= HEARTBEAT_FRESH_SECONDS) {
        return {
          reachable: true,
          connected: Boolean(hb.connected),
          botNumber: hb.botNumber || null,
          connectionMode: 'heartbeat',
          lastSeenAt: hb.lastSeenAt,
          lastSeenSecondsAgo: ageSec,
          version: hb.version || null,
          diskUsedMB: hb.diskUsedMB ?? null,
          diskBudgetMB: hb.diskBudgetMB ?? null,
          queueLight: hb.queueLight ?? null,
          queueHeavy: hb.queueHeavy ?? null,
        };
      }
    }

    const resolved = await getResolvedBotTarget();
    if (!resolved.baseUrl) {
      if (hb) {
        const ageSec = Math.max(0, Math.floor((Date.now() - hb.lastSeenAt) / 1000));
        return {
          reachable: false,
          connected: false,
          botNumber: hb.botNumber || null,
          connectionMode: 'heartbeat',
          lastSeenAt: hb.lastSeenAt,
          lastSeenSecondsAgo: ageSec,
          version: hb.version || null,
          diskUsedMB: hb.diskUsedMB ?? null,
          diskBudgetMB: hb.diskBudgetMB ?? null,
          error: `Bot has not checked in for ${ageSec}s (currently offline).`,
        };
      }
      return {
        reachable: false,
        connected: false,
        botNumber: null,
        connectionMode: 'unconfigured',
      };
    }

    return probeDirectBotStatus(resolved);
  }

  return probeDirectBotStatus(customTarget);
}

async function probeDirectBotStatus(target: {
  baseUrl: string | null;
  token: string;
}): Promise<{
  reachable: boolean;
  connected: boolean;
  botNumber: string | null;
  connectionMode: 'direct';
  latencyMs?: number;
  error?: string;
}> {
  if (!target.baseUrl) {
    return {
      reachable: false,
      connected: false,
      botNumber: null,
      connectionMode: 'direct',
    };
  }
  if (!target.token) {
    return {
      reachable: false,
      connected: false,
      botNumber: null,
      connectionMode: 'direct',
      error: 'ADMIN_DASHBOARD_TOKEN is not set yet.',
    };
  }

  const startedAt = Date.now();
  try {
    const res = await fetch(`${target.baseUrl}/admin/api/status`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${target.token}`,
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
        connectionMode: 'direct',
        latencyMs,
        error: errorMsg,
      };
    }
    return {
      reachable: true,
      connected: Boolean(data.connected),
      botNumber: data.botNumber ? String(data.botNumber) : null,
      connectionMode: 'direct',
      latencyMs,
    };
  } catch (err) {
    return {
      reachable: false,
      connected: false,
      botNumber: null,
      connectionMode: 'direct',
      error: humanizeBotFetchError(err),
    };
  }
}

/**
 * Signal fast-poll so outbound bot sync picks up whitelist updates within seconds,
 * and also push directly if an inbound Bot Server URL is configured.
 */
export async function syncNumberToLiveBot(
  number: string,
  label: string,
  enabled: boolean,
): Promise<void> {
  await setFastPollWindow(30_000).catch(() => {});
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
    // D1 state + outbound sync cover offline/NAT bots
  }
}

export async function removeNumberFromLiveBot(number: string): Promise<void> {
  await setFastPollWindow(30_000).catch(() => {});
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

export async function checkQueuedPairCommand(requestId: string): Promise<{
  ok: boolean;
  status: number;
  pending?: boolean;
  code?: string;
  expiresInSeconds?: number;
  error?: string;
}> {
  const cmd = await getBotCommandById(requestId);
  if (!cmd || cmd.type !== 'pair') {
    return { ok: false, status: 404, error: 'Pairing request not found.' };
  }
  if (cmd.status === 'completed' && cmd.result?.code) {
    return {
      ok: true,
      status: 200,
      code: String(cmd.result.code),
      expiresInSeconds: Number(cmd.result.expiresInSeconds) || 60,
    };
  }
  if (cmd.status === 'failed') {
    return {
      ok: false,
      status: 409,
      error: cmd.error || 'Bot could not issue a pairing code.',
    };
  }
  if (Date.now() > cmd.expiresAt) {
    return {
      ok: false,
      status: 504,
      error: 'Bot did not pick up the pairing request before it expired.',
    };
  }
  return { ok: true, status: 202, pending: true };
}

export async function requestLiveBotPairingCode(
  number: string,
  label: string,
  requestedBy?: string,
): Promise<{
  ok: boolean;
  status: number;
  pending?: boolean;
  requestId?: string;
  code?: string;
  expiresInSeconds?: number;
  error?: string;
}> {
  const [{ baseUrl, token }, hb] = await Promise.all([
    getResolvedBotTarget(),
    getBotHeartbeat(),
  ]);

  const hbFresh =
    Boolean(hb) && Date.now() - (hb?.lastSeenAt || 0) <= HEARTBEAT_FRESH_SECONDS * 1000;

  // Prefer outbound command queue whenever bot has a fresh heartbeat and no direct URL is set
  // (or fall back to outbound queue if direct URL fails).
  if (baseUrl && token) {
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
      if (res.ok && data?.code) {
        return {
          ok: true,
          status: 200,
          code: String(data.code),
          expiresInSeconds: Number(data.expiresInSeconds) || 60,
        };
      }
      if (!hbFresh) {
        return {
          ok: false,
          status: res.status,
          error: data?.error || `Bot server returned HTTP ${res.status}`,
        };
      }
    } catch (err) {
      if (!hbFresh) {
        return {
          ok: false,
          status: 502,
          error: humanizeBotFetchError(err),
        };
      }
    }
  }

  if (hbFresh) {
    if (hb?.connected && hb?.botNumber) {
      return {
        ok: false,
        status: 409,
        error: `This bot is already linked to +${hb.botNumber}. Log it out in WhatsApp → Linked devices before linking another number.`,
      };
    }

    const queued = await enqueueBotCommand({
      type: 'pair',
      payload: { number, label },
      requestedBy,
      ttlMs: 45_000,
    });

    // Brief 2.5s check in case the bot is already fast-polling; otherwise return
    // 202 + requestId so the browser polls cleanly without holding a Vercel function.
    const deadline = Date.now() + 2_500;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      const check = await checkQueuedPairCommand(queued.id);
      if (!check.pending) return check;
    }

    return {
      ok: true,
      status: 202,
      pending: true,
      requestId: queued.id,
    };
  }

  return {
    ok: false,
    status: 400,
    error:
      'The WhatsApp bot is offline or not linked yet. Set DASHBOARD_URL + BOT_SYNC_TOKEN on the bot (no open port required) and start it.',
  };
}
