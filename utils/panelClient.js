/**
 * ZaFar Bot — Hydrodactyl / Pterodactyl HTTPS Panel Client
 *
 * Supports `hydro_…` (XS Systems Hydrodactyl) and `ptlc_…` (Pterodactyl)
 * Account Client API keys across both Pterodactyl and Hydrodactyl route layouts.
 */

'use strict';

const PANEL_URL_DEFAULT = 'https://panel.xsystemshosting.com';

function normalizePanelBase(rawUrl) {
  const cleaned = String(rawUrl || PANEL_URL_DEFAULT)
    .trim()
    .replace(/\/server\/.*$/i, '')
    .replace(/\/servers\/.*$/i, '')
    .replace(/\/account\/.*$/i, '')
    .replace(/\/api\/.*$/i, '')
    .replace(/\/+$/, '');
  try {
    const parsed = new URL(cleaned);
    if (parsed.protocol !== 'https:') {
      return { base: null, error: 'PANEL_URL must use https://' };
    }
    return { base: `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}` };
  } catch {
    return { base: null, error: 'Invalid PANEL_URL' };
  }
}

function getPanelConfig(env = process.env) {
  const key = String(env.PANEL_API_KEY || '').trim();
  const { base, error } = normalizePanelBase(env.PANEL_URL || PANEL_URL_DEFAULT);
  const uuid = String(env.P_SERVER_UUID || '').trim();
  const configured = String(env.PANEL_SERVER_ID || '').trim();
  const ids = [...new Set([configured, uuid.split('-')[0], uuid].filter(Boolean))];
  return { key, base, baseError: error, ids };
}

function parseServerIdsFromBody(json) {
  const list = Array.isArray(json)
    ? json
    : Array.isArray(json?.data)
      ? json.data
      : Array.isArray(json?.servers)
        ? json.servers
        : [];
  const ids = [];
  for (const item of list) {
    const a = item?.attributes && typeof item.attributes === 'object' ? item.attributes : item || {};
    const id = a.identifier || a.shortId || a.server_id || a.id;
    if (id) ids.push(String(id));
    if (a.uuid) ids.push(String(a.uuid).split('-')[0]);
  }
  return [...new Set(ids.filter(Boolean))];
}

async function discoverPanelServerIds(base, key, fetchImpl = fetch) {
  const paths = ['/api/client', '/api/v1/client', '/api/v1/servers', '/api/servers'];
  for (const p of paths) {
    try {
      const res = await fetchImpl(`${base}${p}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${key}`,
          'X-API-Key': key,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(12_000),
      });
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          status: res.status,
          ids: [],
          reason: `panel refused PANEL_API_KEY (HTTP ${res.status})`,
        };
      }
      if (!res.ok) continue;
      const ct = res.headers?.get?.('content-type') || 'application/json';
      if (ct.includes('text/html')) continue;
      const json = await res.json().catch(() => null);
      if (!json) continue;
      return { ok: true, status: 200, ids: parseServerIdsFromBody(json) };
    } catch (e) {
      return { ok: false, status: 0, ids: [], reason: e.message || 'panel unreachable' };
    }
  }
  return { ok: false, status: 404, ids: [], reason: 'panel API endpoint returned 404' };
}

async function panelPowerSignal(signal = 'restart', opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const { key, base, baseError, ids: initialIds } = getPanelConfig(opts.env || process.env);
  if (!key) return { ok: false, reason: 'PANEL_API_KEY is not set' };
  if (baseError || !base) return { ok: false, reason: baseError || 'Invalid PANEL_URL' };

  const candidateIds = [...initialIds];
  if (!candidateIds.length) {
    const disc = await discoverPanelServerIds(base, key, fetchImpl);
    if (!disc.ok) return { ok: false, reason: disc.reason };
    candidateIds.push(...disc.ids);
    if (!candidateIds.length) {
      return {
        ok: false,
        reason: '0 servers found on this PANEL_API_KEY account (verify key belongs to the account owning this server)',
      };
    }
  }

  const ids = [...new Set(candidateIds.filter(Boolean))];
  const routeTemplates = [
    (id) => ({ path: `/api/client/servers/${encodeURIComponent(id)}/power`, body: { signal } }),
    (id) => ({ path: `/api/v1/client/servers/${encodeURIComponent(id)}/power`, body: { signal } }),
    (id) => ({ path: `/api/v1/servers/${encodeURIComponent(id)}/power`, body: { signal, action: signal } }),
    (id) => ({ path: `/api/servers/${encodeURIComponent(id)}/power`, body: { signal, action: signal } }),
    (id) => ({ path: `/api/server/${encodeURIComponent(id)}/power`, body: { signal, action: signal } }),
  ];

  let reason = 'no answer';
  for (const id of ids) {
    for (const makeRoute of routeTemplates) {
      const route = makeRoute(id);
      try {
        const res = await fetchImpl(`${base}${route.path}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'X-API-Key': key,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(route.body),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status === 204 || res.status === 200 || res.status === 202) {
          const ct = res.headers?.get?.('content-type') || '';
          if (res.status === 200 && ct.includes('text/html')) continue;
          return { ok: true, serverId: id };
        }
        if (res.status === 401 || res.status === 403) {
          return { ok: false, reason: `panel refused the key (HTTP ${res.status})` };
        }
        reason = `panel answered HTTP ${res.status}`;
        if (res.status === 404 || res.status === 405) continue;
        break;
      } catch (e) {
        return { ok: false, reason: e.message || 'panel unreachable' };
      }
    }
  }
  return { ok: false, reason };
}

async function panelRestart(opts) {
  return panelPowerSignal('restart', opts);
}

module.exports = {
  PANEL_URL_DEFAULT,
  normalizePanelBase,
  getPanelConfig,
  discoverPanelServerIds,
  panelPowerSignal,
  panelRestart,
};
