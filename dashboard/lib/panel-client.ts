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
    .replace(/\/servers\/.*$/i, '')
    .replace(/\/account\/.*$/i, '')
    .replace(/\/api\/.*$/i, '')
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
    ? ' Note: Your key looks short (<= 20 chars) — copy the full secret key shown right when you click Create in Account → API Keys.'
    : '';
  return `Panel rejected PANEL_API_KEY (HTTP ${status}). Verify it is a valid API Key from Account → API Keys.${hint}`;
}

function parseServerEntries(body: unknown): PanelServerSummary[] {
  if (!body || typeof body !== 'object') return [];
  const obj = body as Record<string, unknown>;
  const rawList = Array.isArray(body)
    ? body
    : Array.isArray(obj.data)
      ? obj.data
      : Array.isArray(obj.servers)
        ? obj.servers
        : [];

  const out: PanelServerSummary[] = [];
  for (const entry of rawList) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const attrs =
      item.attributes && typeof item.attributes === 'object'
        ? (item.attributes as Record<string, unknown>)
        : item;

    const identifier = String(
      attrs.identifier || attrs.shortId || attrs.server_id || attrs.id || '',
    ).trim();
    const uuid = String(attrs.uuid || '').trim();
    const name = String(attrs.name || 'Server').trim();
    if (identifier || uuid) {
      out.push({
        id: identifier || uuid.split('-')[0],
        uuid: uuid || identifier,
        name,
      });
    }
  }
  return out;
}

function buildAuthHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'X-API-Key': apiKey,
    Accept: 'application/json',
  };
}

export async function discoverPanelServers(custom?: {
  panelUrl?: string;
  panelApiKey?: string;
}): Promise<{
  ok: boolean;
  status: number;
  servers: PanelServerSummary[];
  matchedEndpoint?: string;
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

  const discoveryPaths = [
    '/api/client',
    '/api/v1/client',
    '/api/v1/servers',
    '/api/servers',
    '/api/account/servers',
  ];

  const statuses: string[] = [];

  for (const p of discoveryPaths) {
    try {
      const res = await fetch(`${normalized.baseUrl}${p}`, {
        method: 'GET',
        headers: buildAuthHeaders(apiKey),
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

      const contentType = res.headers.get('content-type') || '';
      if (!res.ok || !contentType.includes('json')) {
        statuses.push(`${p}→${res.status}`);
        continue;
      }

      const body = await res.json().catch(() => null);
      if (!body) continue;

      const servers = parseServerEntries(body);
      return {
        ok: true,
        status: 200,
        servers,
        matchedEndpoint: p,
      };
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

  return {
    ok: false,
    status: 404,
    servers: [],
    error: `Panel API endpoints did not return JSON (${statuses.join(', ')}).`,
  };
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

  const candidateIds: string[] = [];
  if (cfg.panelServerId) {
    candidateIds.push(cfg.panelServerId);
    if (cfg.panelServerId.includes('-')) {
      candidateIds.push(cfg.panelServerId.split('-')[0]);
    }
  }

  // Also query discovery if blank OR so we have any alternate UUID/identifier on the account
  const discovered = await discoverPanelServers({
    panelUrl: normalized.baseUrl,
    panelApiKey: cfg.panelApiKey,
  });

  if (discovered.ok) {
    for (const s of discovered.servers) {
      if (s.id) candidateIds.push(s.id);
      if (s.uuid) candidateIds.push(s.uuid);
    }
    if (!cfg.panelServerId && discovered.servers[0]?.id) {
      await savePanelConnectionConfig({ panelServerId: discovered.servers[0].id });
    }
  } else if (discovered.status === 401 || discovered.status === 403) {
    return { ok: false, status: discovered.status, error: discovered.error };
  }

  const uniqueIds = Array.from(new Set(candidateIds.filter(Boolean)));
  if (uniqueIds.length === 0) {
    return {
      ok: false,
      status: 404,
      error: discovered.ok
        ? 'Your API key works, but 0 servers were found on that panel account. Make sure you created the hydro_… key while logged into the exact XS Systems account that owns your bot server!'
        : discovered.error || 'No Server ID configured or discovered.',
    };
  }

  const powerRoutes = (id: string) => [
    { path: `/api/client/servers/${encodeURIComponent(id)}/power`, body: { signal } },
    { path: `/api/v1/client/servers/${encodeURIComponent(id)}/power`, body: { signal } },
    { path: `/api/v1/servers/${encodeURIComponent(id)}/power`, body: { signal, action: signal } },
    { path: `/api/servers/${encodeURIComponent(id)}/power`, body: { signal, action: signal } },
    { path: `/api/server/${encodeURIComponent(id)}/power`, body: { signal, action: signal } },
  ];

  let lastStatus = 404;

  for (const id of uniqueIds) {
    for (const route of powerRoutes(id)) {
      try {
        const res = await fetch(`${normalized.baseUrl}${route.path}`, {
          method: 'POST',
          headers: {
            ...buildAuthHeaders(cfg.panelApiKey),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(route.body),
          cache: 'no-store',
          signal: AbortSignal.timeout(PANEL_TIMEOUT_MS),
        });

        if (res.status === 204 || res.status === 200 || res.status === 202) {
          const ct = res.headers.get('content-type') || '';
          // Guard against SPA HTML fallback returning 200 text/html for unknown routes
          if (res.status === 200 && ct.includes('text/html')) {
            continue;
          }
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
        lastStatus = res.status;
        if (res.status === 404 || res.status === 405) continue;
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
  }

  const accountMismatchHint =
    discovered.ok && discovered.servers.length === 0
      ? ' Note: /api/client returned 0 servers for this key — double-check that you created the hydro_… API key under the same XS Systems login that owns server ' +
        uniqueIds[0] +
        ' (e.g. troykunsauka@gmail.com vs troykunsauka6@gmail.com).'
      : discovered.ok &&
          discovered.servers.length > 0 &&
          !discovered.servers.some((s) => s.id === cfg.panelServerId)
        ? ` Note: This API key sees server(s): ${discovered.servers
            .map((s) => `${s.name} (${s.id})`)
            .join(', ')}.`
        : '';

  return {
    ok: false,
    status: lastStatus,
    error: `Server "${uniqueIds[0]}" was not accepted on ${normalized.baseUrl} (HTTP ${lastStatus}).${accountMismatchHint}`,
  };
}
