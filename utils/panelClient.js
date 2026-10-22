/**
 * ZaFar Bot — Hydrodactyl / Pterodactyl HTTPS Panel Client
 *
 * Supports `hydro_…` (XS Systems Hydrodactyl) and `ptlc_…` (Pterodactyl)
 * Account Client API keys. If `PANEL_SERVER_ID` and `P_SERVER_UUID` are not
 * set, automatically discovers the server identifier via `GET /api/client`.
 */

'use strict';

const PANEL_URL_DEFAULT = 'https://panel.xsystemshosting.com';

function normalizePanelBase(rawUrl) {
  const cleaned = String(rawUrl || PANEL_URL_DEFAULT)
    .trim()
    .replace(/\/server\/.*$/i, '')
    .replace(/\/api\/client.*$/i, '')
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

async function discoverPanelServerIds(base, key, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${base}/api/client`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        ids: [],
        reason:
          res.status === 401 || res.status === 403
            ? `panel refused PANEL_API_KEY (HTTP ${res.status})`
            : `panel answered HTTP ${res.status}`,
      };
    }
    const json = await res.json().catch(() => ({}));
    const list = Array.isArray(json?.data) ? json.data : [];
    const ids = [];
    for (const item of list) {
      const a = item?.attributes || {};
      if (a.identifier) ids.push(String(a.identifier));
      if (a.uuid) ids.push(String(a.uuid).split('-')[0]);
    }
    return { ok: true, status: 200, ids: [...new Set(ids.filter(Boolean))] };
  } catch (e) {
    return { ok: false, status: 0, ids: [], reason: e.message || 'panel unreachable' };
  }
}

async function panelPowerSignal(signal = 'restart', opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const { key, base, baseError, ids: initialIds } = getPanelConfig(opts.env || process.env);
  if (!key) return { ok: false, reason: 'PANEL_API_KEY is not set' };
  if (baseError || !base) return { ok: false, reason: baseError || 'Invalid PANEL_URL' };

  let ids = [...initialIds];
  if (!ids.length) {
    const disc = await discoverPanelServerIds(base, key, fetchImpl);
    if (!disc.ok) return { ok: false, reason: disc.reason };
    ids = disc.ids;
    if (!ids.length) {
      return { ok: false, reason: 'No servers visible to this PANEL_API_KEY (set PANEL_SERVER_ID)' };
    }
  }

  let reason = 'no answer';
  for (const id of ids) {
    try {
      const res = await fetchImpl(
        `${base}/api/client/servers/${encodeURIComponent(id)}/power`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ signal }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (res.status === 204 || res.status === 200) {
        return { ok: true, serverId: id };
      }
      reason =
        res.status === 401 || res.status === 403
          ? `panel refused the key (HTTP ${res.status})`
          : `panel answered HTTP ${res.status}`;
      if (res.status === 404) continue;
      break;
    } catch (e) {
      reason = e.message || 'panel unreachable';
      break;
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
