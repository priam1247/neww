import { PanelServerSummary } from './types';
import { getPanelConnectionConfig, savePanelConnectionConfig } from './storage';

const DEFAULT_PANEL_URL = 'https://panel.xsystemshosting.com';
const PANEL_TIMEOUT_MS = 12_000;

export function normalizePanelBaseUrl(rawUrl: string): {
  baseUrl: string;
  error?: string;
} {
  const clean = (rawUrl || DEFAULT_PANEL_URL)
    .trim()
    .replace(/\/server\/.*$/i, '')
    .replace(/\/account\/.*$/i, '')
    .replace(/\/+$/, '');

  try {
    const parsed = new URL(clean);
    const isLocalhost =
      parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
    if (parsed.protocol !== 'https:' && !isLocalhost) {
      return {
        baseUrl: DEFAULT_PANEL_URL,
        error: 'Panel URL must use https:// so PANEL_API_KEY is never sent in cleartext.',
      };
    }
    return { baseUrl: `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '') };
  } catch {
    return {
      baseUrl: DEFAULT_PANEL_URL,
      error: 'Invalid Panel URL (expected e.g. https://panel.xsystemshosting.com).',
    };
  }
}

function explainPanelKeyRejection(status: number, apiKey: string): string {
  const looksTruncated = apiKey.length > 0 && apiKey.length <= 20;
  const hint = looksTruncated
    ? ' Note: Your key looks short (<= 20 chars) — on Hydrodactyl/Pterodactyl, copy the full secret key shown once right when you click Create in API Keys, not just the short Key Identifier.'
    : '';
  return `Panel rejected PANEL_API_KEY (HTTP ${status}). Verify it is a valid Client API Key from Account → API Keys.${hint}`;
}

export async function discoverPanelServers(custom?: {
  panelUrl?: string;
  panelApiKey?: string;
}): Promise<{
  ok: boolean;
  status: number;
  servers: PanelServerSummary[];
  error?: string;
}> {
  const saved = await getPanelConnectionConfig();
  const apiKey = (custom?.panelApiKey ?? saved.panelApiKey).trim();
  const normalized = normalizePanelBaseUrl(custom?.panelUrl ?? saved.panelUrl);

  if (normalized.error) {
    return { ok: false, status: 400, servers: [], error: normalized.error };
  }
  if (!apiKey) {
    return {
      ok: false,
      status: 400,
      servers: [],
      error: 'PANEL_API_KEY is not set yet.',
    };
  }

  try {
    const res = await fetch(`${normalized.baseUrl}/api/client`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(PANEL_TIMEOUT_MS),
    });

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        status: res.status,
        servers: [],
        error: explainPanelKeyRejection(res.status, apiKey),
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        servers: [],
        error: `Panel answered HTTP ${res.status} on /api/client.`,
      };
    }

    const body = (await res.json().catch(() => null)) as {
      data?: Array<{
        attributes?: { identifier?: string; uuid?: string; name?: string };
      }>;
    } | null;

    const list = Array.isArray(body?.data) ? body!.data : [];
    const servers: PanelServerSummary[] = list
      .map((item) => ({
        id: String(item?.attributes?.identifier || ''),
        uuid: String(item?.attributes?.uuid || ''),
        name: String(item?.attributes?.name || 'Server'),
      }))
      .filter((s) => Boolean(s.id || s.uuid));

    return { ok: true, status: 200, servers };
  } catch (err) {
    return {
      ok: false,
      status: 502,
      servers: [],
      error: `Could not reach panel (${
        err instanceof Error ? err.message : 'network error'
      }).`,
    };
  }
}

export async function sendPanelPowerSignal(
  signal: 'restart' | 'start' | 'stop' | 'kill',
): Promise<{
  ok: boolean;
  status: number;
  serverId?: string;
  message?: string;
  error?: string;
}> {
  const cfg = await getPanelConnectionConfig();
  const normalized = normalizePanelBaseUrl(cfg.panelUrl);
  if (normalized.error) {
    return { ok: false, status: 400, error: normalized.error };
  }
  if (!cfg.panelApiKey) {
    return {
      ok: false,
      status: 400,
      error: 'Save your Hydrodactyl / Pterodactyl PANEL_API_KEY first.',
    };
  }

  let candidateIds = [
    cfg.panelServerId,
    cfg.panelServerId.includes('-') ? cfg.panelServerId.split('-')[0] : '',
  ].filter(Boolean);

  // Auto-discover server ID from /api/client when PANEL_SERVER_ID was left blank!
  if (candidateIds.length === 0) {
    const discovered = await discoverPanelServers({
      panelUrl: normalized.baseUrl,
      panelApiKey: cfg.panelApiKey,
    });
    if (!discovered.ok) {
      return { ok: false, status: discovered.status, error: discovered.error };
    }
    if (discovered.servers.length === 0) {
      return {
        ok: false,
        status: 404,
        error: 'No servers were found on this panel account/subuser.',
      };
    }
    const chosen = discovered.servers[0];
    candidateIds = [chosen.id, chosen.uuid].filter(Boolean);
    if (chosen.id) {
      await savePanelConnectionConfig({ panelServerId: chosen.id });
    }
  }

  const uniqueIds = Array.from(new Set(candidateIds));
  let lastError = 'Panel did not accept power signal.';

  for (const id of uniqueIds) {
    try {
      const res = await fetch(
        `${normalized.baseUrl}/api/client/servers/${encodeURIComponent(id)}/power`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cfg.panelApiKey}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ signal }),
          cache: 'no-store',
          signal: AbortSignal.timeout(PANEL_TIMEOUT_MS),
        },
      );

      if (res.status === 204 || res.status === 200) {
        return {
          ok: true,
          status: 200,
          serverId: id,
          message: `Sent "${signal}" signal to server ${id} on ${normalized.baseUrl}.`,
        };
      }
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          status: res.status,
          error: explainPanelKeyRejection(res.status, cfg.panelApiKey),
        };
      }
      if (res.status === 404) {
        lastError = `Server "${id}" not found on ${normalized.baseUrl} (HTTP 404).`;
        continue;
      }
      lastError = `Panel answered HTTP ${res.status} for server "${id}".`;
      break;
    } catch (err) {
      return {
        ok: false,
        status: 502,
        error: `Could not reach panel (${
          err instanceof Error ? err.message : 'network error'
        }).`,
      };
    }
  }

  return { ok: false, status: 404, error: lastError };
}
