import fs from 'node:fs';
import path from 'node:path';
import { ApprovedUser } from './types';

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

interface DiskStoreSchema {
  nextUserId: number;
  accounts: StoredPortalAccount[];
  whatsappUsers: ApprovedUser[];
}

const DATA_DIR = path.join(process.cwd(), '.data');
const DATA_FILE = path.join(DATA_DIR, 'zafar-db.json');

declare global {
  // eslint-disable-next-line no-var
  var __zafarD1SchemaReady: boolean | undefined;
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
  if (globalThis.__zafarD1SchemaReady) return true;

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

  globalThis.__zafarD1SchemaReady = true;
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
      };
    }
  } catch {
    // start fresh store
  }
  return { nextUserId: 1, accounts: [], whatsappUsers: [] };
}

function writeDiskStore(data: DiskStoreSchema): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    // ignore read-only ephemeral edge filesystem if D1 is primary
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

    // Seamless check against existing zafar-backend `users` table in shared Cloudflare D1
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
          name: String(u.name || u.username || 'User'),
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
      // `users` table may not exist yet on fresh DB
    }
    return null;
  }

  const store = readDiskStore();
  return (
    store.accounts.find((a) => a.email === key || a.username === key) || null
  );
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

export async function listStoredWhatsAppUsers(): Promise<ApprovedUser[]> {
  if (await ensureD1Tables()) {
    const rows = await queryD1(
      `SELECT number, label, enabled, added_by, added_at
       FROM portal_whatsapp_access
       ORDER BY added_at DESC`,
    );
    if (rows) {
      return rows.map((r) => ({
        number: String(r.number),
        label: String(r.label || 'Approved operator'),
        enabled: Boolean(Number(r.enabled)),
        addedBy: r.added_by ? String(r.added_by) : undefined,
        addedAt: String(r.added_at),
      }));
    }
  }

  return readDiskStore().whatsappUsers;
}

export async function saveStoredWhatsAppUser(
  number: string,
  label: string,
  addedBy: string,
): Promise<ApprovedUser[]> {
  const now = new Date().toISOString();

  if (await ensureD1Tables()) {
    await queryD1(
      `INSERT INTO portal_whatsapp_access (number, label, enabled, added_by, added_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(number) DO UPDATE SET enabled = 1, label = excluded.label`,
      [number, label, addedBy, now],
    );
    return listStoredWhatsAppUsers();
  }

  const store = readDiskStore();
  const existing = store.whatsappUsers.find((u) => u.number === number);
  if (existing) {
    existing.enabled = true;
    existing.label = label;
  } else {
    store.whatsappUsers.unshift({
      number,
      label,
      enabled: true,
      addedBy,
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
    const rows = await queryD1(
      `SELECT number, label, enabled, added_by, added_at
       FROM portal_whatsapp_access WHERE number = ? LIMIT 1`,
      [number],
    );
    if (!rows || rows.length === 0) return null;
    const current = rows[0];
    const nextEnabled =
      typeof patch.enabled === 'boolean'
        ? patch.enabled
        : Boolean(Number(current.enabled));
    const nextLabel =
      typeof patch.label === 'string' && patch.label.trim()
        ? patch.label.trim().slice(0, 80)
        : String(current.label || 'Approved operator');

    await queryD1(
      `UPDATE portal_whatsapp_access SET enabled = ?, label = ? WHERE number = ?`,
      [nextEnabled ? 1 : 0, nextLabel, number],
    );
    return {
      number,
      label: nextLabel,
      enabled: nextEnabled,
      addedBy: current.added_by ? String(current.added_by) : undefined,
      addedAt: String(current.added_at),
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
