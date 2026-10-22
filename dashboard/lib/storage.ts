import fs from 'node:fs';
import path from 'node:path';
import { ApprovedUser, BotConnectionConfig, MemberRecord } from './types';

export interface StoredPortalAccount {
  id: number;
  email: string;
  username: string;
  name: string;
  passwordHash: string;
  isVerified: boolean;
  verificationCode: string | null;
  codeExpiresAt: string | null;
  verificationAttempts: number;
  resetCode: string | null;
  resetExpiresAt: string | null;
  resetAttempts: number;
  createdAt: string;
}

interface StoredMemberPermission {
  email: string;
  name: string;
  allowed: boolean;
  updatedAt: string;
}

interface DiskStoreSchema {
  nextUserId: number;
  accounts: StoredPortalAccount[];
  whatsappUsers: ApprovedUser[];
  memberPermissions: StoredMemberPermission[];
  settings: Record<string, string>;
}

const DATA_DIR = path.join(process.cwd(), '.data');
const DATA_FILE = path.join(DATA_DIR, 'zafar-db.json');

declare global {
  // eslint-disable-next-line no-var
  var __zafarD1SchemaV2Ready: boolean | undefined;
  // eslint-disable-next-line no-var
  var __zafarD1UnreachableInDev: boolean | undefined;
}

function getD1Config() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || '';
  const databaseId = process.env.D1_DATABASE_ID?.trim() || '';
  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim() || '';
  if (!accountId || !databaseId || !apiToken) return null;
  return { accountId, databaseId, apiToken };
}

async function queryD1<T = Record<string, unknown>>(
  sql: string,
  params: (string | number | null)[] = [],
): Promise<T[] | null> {
  const cfg = getD1Config();
  if (!cfg || globalThis.__zafarD1UnreachableInDev) return null;

  const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/d1/database/${cfg.databaseId}/query`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, params }),
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    });
    const body = await res.json();
    if (!res.ok || !body?.success) {
      throw new Error(
        body?.errors?.[0]?.message || `Cloudflare D1 error (${res.status})`,
      );
    }
    return (body.result?.[0]?.results as T[]) || [];
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      globalThis.__zafarD1UnreachableInDev = true;
      return null;
    }
    throw err;
  }
}

async function ensureD1Tables(): Promise<boolean> {
  const cfg = getD1Config();
  if (!cfg || globalThis.__zafarD1UnreachableInDev) return false;
  if (globalThis.__zafarD1SchemaV2Ready) return true;

  const r1 = await queryD1(`
    CREATE TABLE IF NOT EXISTS portal_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      username TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      is_verified INTEGER NOT NULL DEFAULT 0,
      verification_code TEXT,
      code_expires_at TEXT,
      verification_attempts INTEGER NOT NULL DEFAULT 0,
      reset_code TEXT,
      reset_expires_at TEXT,
      reset_attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);
  if (r1 === null) return false;

  await queryD1(`
    CREATE TABLE IF NOT EXISTS portal_whatsapp_access (
      number TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      added_by TEXT,
      added_at TEXT NOT NULL
    )
  `);

  await queryD1(`
    CREATE TABLE IF NOT EXISTS portal_member_permissions (
      email TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      allowed INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    )
  `);

  await queryD1(`
    CREATE TABLE IF NOT EXISTS portal_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  globalThis.__zafarD1SchemaV2Ready = true;
  return true;
}

function readDiskStore(): DiskStoreSchema {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      return {
        nextUserId: Number(parsed.nextUserId) || 1,
        accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
        whatsappUsers: Array.isArray(parsed.whatsappUsers) ? parsed.whatsappUsers : [],
        memberPermissions: Array.isArray(parsed.memberPermissions)
          ? parsed.memberPermissions
          : [],
        settings:
          parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {},
      };
    }
  } catch {
    // fresh store
  }
  return {
    nextUserId: 1,
    accounts: [],
    whatsappUsers: [],
    memberPermissions: [],
    settings: {},
  };
}

function writeDiskStore(data: DiskStoreSchema): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    // ignore ephemeral read-only fs if D1 is active
  }
}

function mapD1Account(row: Record<string, unknown>): StoredPortalAccount {
  return {
    id: Number(row.id),
    email: String(row.email || ''),
    username: String(row.username || ''),
    name: String(row.name || ''),
    passwordHash: String(row.password_hash || ''),
    isVerified: Boolean(Number(row.is_verified)),
    verificationCode: row.verification_code ? String(row.verification_code) : null,
    codeExpiresAt: row.code_expires_at ? String(row.code_expires_at) : null,
    verificationAttempts: Number(row.verification_attempts || 0),
    resetCode: row.reset_code ? String(row.reset_code) : null,
    resetExpiresAt: row.reset_expires_at ? String(row.reset_expires_at) : null,
    resetAttempts: Number(row.reset_attempts || 0),
    createdAt: String(row.created_at || new Date().toISOString()),
  };
}

export async function isUsingCloudflareD1(): Promise<boolean> {
  return ensureD1Tables();
}

export async function findAccountByEmailOrUsername(
  identifier: string,
): Promise<StoredPortalAccount | null> {
  const key = identifier.trim().toLowerCase();

  if (await ensureD1Tables()) {
    const rows = await queryD1(
      `SELECT * FROM portal_accounts WHERE email = ? OR username = ? LIMIT 1`,
      [key, key],
    );
    if (rows && rows.length > 0) {
      return mapD1Account(rows[0]);
    }

    try {
      const legacy = await queryD1(
        `SELECT id, email, username, name, hashed_password, is_verified, created_at
         FROM users WHERE email = ? OR username = ? LIMIT 1`,
        [key, key],
      );
      if (legacy && legacy.length > 0) {
        const u = legacy[0];
        return {
          id: Number(u.id),
          email: String(u.email || ''),
          username: String(u.username || key),
          name: String(u.name || u.username || 'Member'),
          passwordHash: String(u.hashed_password || ''),
          isVerified: Boolean(Number(u.is_verified ?? 1)),
          verificationCode: null,
          codeExpiresAt: null,
          verificationAttempts: 0,
          resetCode: null,
          resetExpiresAt: null,
          resetAttempts: 0,
          createdAt: String(u.created_at || new Date().toISOString()),
        };
      }
    } catch {
      // `users` table optional
    }
    return null;
  }

  const store = readDiskStore();
  return store.accounts.find((a) => a.email === key || a.username === key) || null;
}

export async function upsertAccount(
  account: Omit<StoredPortalAccount, 'id'> & { id?: number },
): Promise<StoredPortalAccount> {
  const normalizedEmail = account.email.trim().toLowerCase();

  if (await ensureD1Tables()) {
    const existing = await queryD1(
      `SELECT id FROM portal_accounts WHERE email = ? LIMIT 1`,
      [normalizedEmail],
    );
    if (existing && existing.length > 0) {
      await queryD1(
        `UPDATE portal_accounts
         SET name = ?, password_hash = ?, is_verified = ?, verification_code = ?,
             code_expires_at = ?, verification_attempts = ?, reset_code = ?,
             reset_expires_at = ?, reset_attempts = ?
         WHERE email = ?`,
        [
          account.name,
          account.passwordHash,
          account.isVerified ? 1 : 0,
          account.verificationCode,
          account.codeExpiresAt,
          account.verificationAttempts,
          account.resetCode,
          account.resetExpiresAt,
          account.resetAttempts,
          normalizedEmail,
        ],
      );
    } else {
      await queryD1(
        `INSERT INTO portal_accounts
         (email, username, name, password_hash, is_verified, verification_code,
          code_expires_at, verification_attempts, reset_code, reset_expires_at,
          reset_attempts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          normalizedEmail,
          account.username,
          account.name,
          account.passwordHash,
          account.isVerified ? 1 : 0,
          account.verificationCode,
          account.codeExpiresAt,
          account.verificationAttempts,
          account.resetCode,
          account.resetExpiresAt,
          account.resetAttempts,
          account.createdAt,
        ],
      );
    }
    const saved = await findAccountByEmailOrUsername(normalizedEmail);
    if (saved) return saved;
  }

  const store = readDiskStore();
  const idx = store.accounts.findIndex((a) => a.email === normalizedEmail);
  if (idx >= 0) {
    const updated: StoredPortalAccount = {
      ...store.accounts[idx],
      ...account,
      id: store.accounts[idx].id,
      email: normalizedEmail,
    };
    store.accounts[idx] = updated;
    writeDiskStore(store);
    return updated;
  }

  const created: StoredPortalAccount = {
    ...account,
    id: store.nextUserId++,
    email: normalizedEmail,
  };
  store.accounts.push(created);
  writeDiskStore(store);
  return created;
}

// ============================================================================
// Member Allow / Disallow Controls
// ============================================================================

export async function isMemberEmailAllowed(email: string): Promise<boolean> {
  const clean = email.trim().toLowerCase();
  if (!clean) return false;

  if (await ensureD1Tables()) {
    const rows = await queryD1(
      `SELECT allowed FROM portal_member_permissions WHERE email = ? LIMIT 1`,
      [clean],
    );
    if (rows && rows.length > 0) {
      return Boolean(Number(rows[0].allowed));
    }
    return true;
  }

  const store = readDiskStore();
  const perm = store.memberPermissions.find((p) => p.email === clean);
  return perm ? perm.allowed : true;
}

export async function setMemberPermission(
  email: string,
  allowed: boolean,
  name = '',
): Promise<void> {
  const clean = email.trim().toLowerCase();
  const now = new Date().toISOString();

  if (await ensureD1Tables()) {
    await queryD1(
      `INSERT INTO portal_member_permissions (email, name, allowed, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         allowed = excluded.allowed,
         name = CASE WHEN excluded.name != '' THEN excluded.name ELSE portal_member_permissions.name END,
         updated_at = excluded.updated_at`,
      [clean, name.trim(), allowed ? 1 : 0, now],
    );

    // Sync all WhatsApp numbers belonging to this member automatically
    await queryD1(
      `UPDATE portal_whatsapp_access SET enabled = ? WHERE lower(added_by) = ?`,
      [allowed ? 1 : 0, clean],
    );
    return;
  }

  const store = readDiskStore();
  const existing = store.memberPermissions.find((p) => p.email === clean);
  if (existing) {
    existing.allowed = allowed;
    if (name.trim()) existing.name = name.trim();
    existing.updatedAt = now;
  } else {
    store.memberPermissions.unshift({
      email: clean,
      name: name.trim(),
      allowed,
      updatedAt: now,
    });
  }
  for (const num of store.whatsappUsers) {
    if ((num.addedBy || '').toLowerCase() === clean) {
      num.enabled = allowed;
    }
  }
  writeDiskStore(store);
}

export async function removeMemberPermissionRecord(email: string): Promise<void> {
  const clean = email.trim().toLowerCase();
  await setMemberPermission(clean, false);
}

export async function listAllMembers(
  checkAdmin: (email: string) => boolean,
): Promise<MemberRecord[]> {
  const whatsappAll = await listStoredWhatsAppUsers();
  const countByEmail = new Map<string, number>();
  for (const item of whatsappAll) {
    const owner = (item.addedBy || '').toLowerCase();
    if (owner) countByEmail.set(owner, (countByEmail.get(owner) || 0) + 1);
  }

  const merged = new Map<string, MemberRecord>();

  if (await ensureD1Tables()) {
    const permRows =
      (await queryD1(
        `SELECT email, name, allowed, updated_at FROM portal_member_permissions`,
      )) || [];
    const permMap = new Map<string, { allowed: boolean; name: string; updatedAt: string }>();
    for (const r of permRows) {
      const em = String(r.email || '').toLowerCase();
      if (em) {
        permMap.set(em, {
          allowed: Boolean(Number(r.allowed)),
          name: String(r.name || ''),
          updatedAt: String(r.updated_at || new Date().toISOString()),
        });
      }
    }

    const portalRows =
      (await queryD1(
        `SELECT email, name, is_verified, created_at FROM portal_accounts ORDER BY created_at DESC`,
      )) || [];
    for (const r of portalRows) {
      const em = String(r.email || '').toLowerCase();
      if (!em) continue;
      const perm = permMap.get(em);
      merged.set(em, {
        email: em,
        name: String(r.name || perm?.name || em.split('@')[0]),
        isVerified: Boolean(Number(r.is_verified)),
        isAdmin: checkAdmin(em),
        allowed: checkAdmin(em) ? true : perm ? perm.allowed : true,
        numbersCount: countByEmail.get(em) || 0,
        createdAt: String(r.created_at || new Date().toISOString()),
      });
    }

    try {
      const backendRows =
        (await queryD1(
          `SELECT email, name, username, is_verified, created_at FROM users WHERE email IS NOT NULL ORDER BY created_at DESC`,
        )) || [];
      for (const r of backendRows) {
        const em = String(r.email || '').toLowerCase();
        if (!em || merged.has(em)) continue;
        const perm = permMap.get(em);
        merged.set(em, {
          email: em,
          name: String(r.name || r.username || perm?.name || em.split('@')[0]),
          isVerified: Boolean(Number(r.is_verified ?? 1)),
          isAdmin: checkAdmin(em),
          allowed: checkAdmin(em) ? true : perm ? perm.allowed : true,
          numbersCount: countByEmail.get(em) || 0,
          createdAt: String(r.created_at || new Date().toISOString()),
        });
      }
    } catch {
      // ignore if `users` table does not exist
    }

    for (const [em, perm] of permMap.entries()) {
      if (!merged.has(em)) {
        merged.set(em, {
          email: em,
          name: perm.name || em.split('@')[0],
          isVerified: false,
          isAdmin: checkAdmin(em),
          allowed: checkAdmin(em) ? true : perm.allowed,
          numbersCount: countByEmail.get(em) || 0,
          createdAt: perm.updatedAt,
        });
      }
    }

    return Array.from(merged.values());
  }

  const store = readDiskStore();
  const permMap = new Map(
    store.memberPermissions.map((p) => [p.email.toLowerCase(), p]),
  );
  for (const acc of store.accounts) {
    const em = acc.email.toLowerCase();
    const perm = permMap.get(em);
    merged.set(em, {
      email: em,
      name: acc.name || perm?.name || em.split('@')[0],
      isVerified: acc.isVerified,
      isAdmin: checkAdmin(em),
      allowed: checkAdmin(em) ? true : perm ? perm.allowed : true,
      numbersCount: countByEmail.get(em) || 0,
      createdAt: acc.createdAt,
    });
  }
  for (const perm of store.memberPermissions) {
    const em = perm.email.toLowerCase();
    if (!merged.has(em)) {
      merged.set(em, {
        email: em,
        name: perm.name || em.split('@')[0],
        isVerified: false,
        isAdmin: checkAdmin(em),
        allowed: checkAdmin(em) ? true : perm.allowed,
        numbersCount: countByEmail.get(em) || 0,
        createdAt: perm.updatedAt,
      });
    }
  }
  return Array.from(merged.values());
}

// ============================================================================
// Server-Side Bot Connection & Global Switch Settings
// ============================================================================

export async function getBotConnectionConfig(): Promise<BotConnectionConfig> {
  const envUrl = process.env.BOT_API_URL?.trim() || '';
  const envToken = process.env.ADMIN_DASHBOARD_TOKEN?.trim() || '';

  if (await ensureD1Tables()) {
    const rows =
      (await queryD1(`SELECT key, value, updated_at FROM portal_settings`)) || [];
    const map = new Map<string, string>();
    let updatedAt: string | undefined;
    for (const r of rows) {
      map.set(String(r.key), String(r.value));
      if (r.updated_at) updatedAt = String(r.updated_at);
    }
    return {
      botApiUrl: (map.get('bot_api_url') ?? envUrl).trim(),
      botAdminToken: (map.get('bot_admin_token') ?? envToken).trim(),
      botEnabledForMembers: map.get('bot_enabled_for_members') !== '0',
      updatedAt,
    };
  }

  const store = readDiskStore();
  return {
    botApiUrl: (store.settings.bot_api_url ?? envUrl).trim(),
    botAdminToken: (store.settings.bot_admin_token ?? envToken).trim(),
    botEnabledForMembers: store.settings.bot_enabled_for_members !== '0',
    updatedAt: store.settings.updated_at,
  };
}

export async function saveBotConnectionConfig(patch: {
  botApiUrl?: string;
  botAdminToken?: string;
  botEnabledForMembers?: boolean;
}): Promise<BotConnectionConfig> {
  const current = await getBotConnectionConfig();
  const nextUrl =
    typeof patch.botApiUrl === 'string' ? patch.botApiUrl.trim() : current.botApiUrl;
  const nextToken =
    typeof patch.botAdminToken === 'string'
      ? patch.botAdminToken.trim()
      : current.botAdminToken;
  const nextEnabled =
    typeof patch.botEnabledForMembers === 'boolean'
      ? patch.botEnabledForMembers
      : current.botEnabledForMembers;
  const now = new Date().toISOString();

  if (await ensureD1Tables()) {
    const entries: [string, string][] = [
      ['bot_api_url', nextUrl],
      ['bot_admin_token', nextToken],
      ['bot_enabled_for_members', nextEnabled ? '1' : '0'],
    ];
    for (const [k, v] of entries) {
      await queryD1(
        `INSERT INTO portal_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [k, v, now],
      );
    }
    return {
      botApiUrl: nextUrl,
      botAdminToken: nextToken,
      botEnabledForMembers: nextEnabled,
      updatedAt: now,
    };
  }

  const store = readDiskStore();
  store.settings.bot_api_url = nextUrl;
  store.settings.bot_admin_token = nextToken;
  store.settings.bot_enabled_for_members = nextEnabled ? '1' : '0';
  store.settings.updated_at = now;
  writeDiskStore(store);

  return {
    botApiUrl: nextUrl,
    botAdminToken: nextToken,
    botEnabledForMembers: nextEnabled,
    updatedAt: now,
  };
}

// ============================================================================
// Stored WhatsApp Numbers CRUD (Scoped & Global)
// ============================================================================

export async function listStoredWhatsAppUsers(ownerEmail?: string): Promise<ApprovedUser[]> {
  const filterOwner = ownerEmail?.trim().toLowerCase();

  if (await ensureD1Tables()) {
    const rows = filterOwner
      ? await queryD1(
          `SELECT number, label, enabled, added_by, added_at
           FROM portal_whatsapp_access
           WHERE lower(added_by) = ?
           ORDER BY added_at DESC`,
          [filterOwner],
        )
      : await queryD1(
          `SELECT number, label, enabled, added_by, added_at
           FROM portal_whatsapp_access
           ORDER BY added_at DESC`,
        );
    if (rows) {
      return rows.map((r) => ({
        number: String(r.number),
        label: String(r.label || 'Approved number'),
        enabled: Boolean(Number(r.enabled)),
        addedBy: r.added_by ? String(r.added_by) : undefined,
        addedAt: String(r.added_at),
      }));
    }
  }

  const all = readDiskStore().whatsappUsers;
  if (!filterOwner) return all;
  return all.filter((u) => (u.addedBy || '').toLowerCase() === filterOwner);
}

export async function getStoredWhatsAppUser(
  number: string,
): Promise<ApprovedUser | null> {
  if (await ensureD1Tables()) {
    const rows = await queryD1(
      `SELECT number, label, enabled, added_by, added_at
       FROM portal_whatsapp_access WHERE number = ? LIMIT 1`,
      [number],
    );
    if (!rows || rows.length === 0) return null;
    const r = rows[0];
    return {
      number: String(r.number),
      label: String(r.label || 'Approved number'),
      enabled: Boolean(Number(r.enabled)),
      addedBy: r.added_by ? String(r.added_by) : undefined,
      addedAt: String(r.added_at),
    };
  }
  return readDiskStore().whatsappUsers.find((u) => u.number === number) || null;
}

export async function saveStoredWhatsAppUser(
  number: string,
  label: string,
  addedBy: string,
): Promise<ApprovedUser[]> {
  const now = new Date().toISOString();
  const cleanOwner = addedBy.trim().toLowerCase();

  if (await ensureD1Tables()) {
    await queryD1(
      `INSERT INTO portal_whatsapp_access (number, label, enabled, added_by, added_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(number) DO UPDATE SET
         enabled = 1,
         label = excluded.label,
         added_by = excluded.added_by`,
      [number, label, cleanOwner, now],
    );
    return listStoredWhatsAppUsers();
  }

  const store = readDiskStore();
  const existing = store.whatsappUsers.find((u) => u.number === number);
  if (existing) {
    existing.enabled = true;
    existing.label = label;
    existing.addedBy = cleanOwner;
  } else {
    store.whatsappUsers.unshift({
      number,
      label,
      enabled: true,
      addedBy: cleanOwner,
      addedAt: now,
    });
  }
  writeDiskStore(store);
  return store.whatsappUsers;
}

export async function updateStoredWhatsAppUser(
  number: string,
  patch: { enabled?: boolean; label?: string },
): Promise<ApprovedUser | null> {
  if (await ensureD1Tables()) {
    const current = await getStoredWhatsAppUser(number);
    if (!current) return null;
    const nextEnabled =
      typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled;
    const nextLabel =
      typeof patch.label === 'string' && patch.label.trim()
        ? patch.label.trim().slice(0, 80)
        : current.label || 'Approved number';

    await queryD1(
      `UPDATE portal_whatsapp_access SET enabled = ?, label = ? WHERE number = ?`,
      [nextEnabled ? 1 : 0, nextLabel, number],
    );
    return {
      ...current,
      enabled: nextEnabled,
      label: nextLabel,
    };
  }

  const store = readDiskStore();
  const target = store.whatsappUsers.find((u) => u.number === number);
  if (!target) return null;
  if (typeof patch.enabled === 'boolean') target.enabled = patch.enabled;
  if (typeof patch.label === 'string' && patch.label.trim()) {
    target.label = patch.label.trim().slice(0, 80);
  }
  writeDiskStore(store);
  return target;
}

export async function deleteStoredWhatsAppUser(
  number: string,
): Promise<ApprovedUser[]> {
  if (await ensureD1Tables()) {
    await queryD1(`DELETE FROM portal_whatsapp_access WHERE number = ?`, [number]);
    return listStoredWhatsAppUsers();
  }

  const store = readDiskStore();
  store.whatsappUsers = store.whatsappUsers.filter((u) => u.number !== number);
  writeDiskStore(store);
  return store.whatsappUsers;
}
