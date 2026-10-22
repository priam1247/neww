import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { NextRequest } from 'next/server';
import {
  isMailDeliveryConfigured,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from './email-service';
import {
  extractSessionToken,
  JwtConfigError,
  signSessionJwt,
  verifySessionJwt,
} from './jwt';
import {
  findAccountByEmailOrUsername,
  isMemberEmailAllowed,
  setMemberPermission,
  upsertAccount,
} from './storage';
import { AuthUser, UserQuota } from './types';

export const PRIMARY_ADMIN_EMAIL = 'troykunsauka@gmail.com';
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const LEGACY_MIGRATION_TIMEOUT_MS = 6_000;

export class AuthServiceError extends Error {
  status: number;
  needsVerification?: boolean;

  constructor(status: number, message: string, needsVerification = false) {
    super(message);
    this.status = status;
    this.needsVerification = needsVerification;
  }
}

export function getAdminEmail(): string {
  const configured = (process.env.ADMIN_EMAIL || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return configured[0] || PRIMARY_ADMIN_EMAIL;
}

export function isAdminEmail(email: string): boolean {
  const clean = email.trim().toLowerCase();
  if (!clean) return false;
  if (clean === PRIMARY_ADMIN_EMAIL) return true;

  const configured = (process.env.ADMIN_EMAIL || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return configured.includes(clean);
}

function getOptionalLegacyAuthUrl(): string | null {
  const raw = process.env.ZAFAR_AUTH_API_URL?.trim() || '';
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

function isEmailVerificationRequired(): boolean {
  return !/^(0|false|no|off)$/i.test(
    String(process.env.EMAIL_VERIFICATION_REQUIRED || 'true'),
  );
}

function generateSixDigitCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function safeCompareCode(expected: string | null, actual: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(expected.trim());
  const b = Buffer.from(actual.trim());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function makeUsername(email: string, existingUsername?: string): string {
  if (existingUsername) return existingUsername;
  const base =
    email
      .split('@')[0]
      .replace(/[^a-z0-9_]/gi, '')
      .toLowerCase() || 'user';
  return `${base}_${Date.now().toString(36)}`;
}

async function buildAuthUser(input: {
  id: number | string;
  name: string;
  email: string;
  username: string;
  isVerified: boolean;
  createdAt?: string;
}): Promise<AuthUser> {
  const admin = isAdminEmail(input.email);
  const memberAllowed = admin ? true : await isMemberEmailAllowed(input.email);
  return {
    id: input.id,
    name: input.name || input.username || 'Member',
    email: input.email,
    username: input.username,
    isVerified: input.isVerified,
    isAdmin: admin,
    memberAllowed,
    createdAt: input.createdAt,
  };
}

/**
 * Optional one-way migration from a legacy external auth API (ZAFAR_AUTH_API_URL)
 * when an existing user signs in for the first time before having a D1 record.
 * Once verified, their account is persisted locally in D1 so future logins and
 * session checks never touch the external server.
 */
async function tryMigrateLegacyAccount(
  identifier: string,
  password: string,
): Promise<{ sessionToken: string; user: AuthUser } | null> {
  const baseUrl = getOptionalLegacyAuthUrl();
  if (!baseUrl) return null;

  try {
    const loginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ email: identifier, password }).toString(),
      cache: 'no-store',
      signal: AbortSignal.timeout(LEGACY_MIGRATION_TIMEOUT_MS),
    });
    if (!loginRes.ok) return null;

    const tokenPayload = (await loginRes.json().catch(() => null)) as {
      access_token?: string;
    } | null;
    if (!tokenPayload?.access_token) return null;

    const meRes = await fetch(`${baseUrl}/auth/me`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${tokenPayload.access_token}`,
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(LEGACY_MIGRATION_TIMEOUT_MS),
    });
    if (!meRes.ok) return null;

    const profile = (await meRes.json().catch(() => null)) as {
      name?: string | null;
      email?: string | null;
      username?: string;
      is_verified?: boolean;
      created_at?: string;
    } | null;
    if (!profile) return null;

    const resolvedEmail = (profile.email || identifier).trim().toLowerCase();
    const resolvedName = (profile.name || profile.username || 'Member').trim();
    const passwordHash = await bcrypt.hash(password, 10);

    const saved = await upsertAccount({
      email: resolvedEmail,
      username: makeUsername(resolvedEmail, profile.username),
      name: resolvedName,
      passwordHash,
      isVerified: profile.is_verified !== false,
      verificationCode: null,
      codeExpiresAt: null,
      verificationAttempts: 0,
      resetCode: null,
      resetExpiresAt: null,
      resetAttempts: 0,
      createdAt: profile.created_at || new Date().toISOString(),
    });

    const currentlyAllowed = await isMemberEmailAllowed(resolvedEmail);
    await setMemberPermission(resolvedEmail, currentlyAllowed, resolvedName);

    const user = await buildAuthUser(saved);
    const sessionToken = signSessionJwt({
      sub: user.email,
      email: user.email,
      name: user.name,
      uid: user.id,
    });
    return { sessionToken, user };
  } catch {
    return null;
  }
}

async function ensureBootstrapAdminAccount(
  identifier: string,
  password: string,
): Promise<void> {
  const initialPass = process.env.ADMIN_INITIAL_PASSWORD?.trim() || '';
  if (!initialPass || initialPass.length < 6) return;
  if (!isAdminEmail(identifier) || password !== initialPass) return;

  const existing = await findAccountByEmailOrUsername(identifier);
  if (existing) return;

  const passwordHash = await bcrypt.hash(initialPass, 10);
  await upsertAccount({
    email: identifier,
    username: makeUsername(identifier, 'admin'),
    name: 'Administrator',
    passwordHash,
    isVerified: true,
    verificationCode: null,
    codeExpiresAt: null,
    verificationAttempts: 0,
    resetCode: null,
    resetExpiresAt: null,
    resetAttempts: 0,
    createdAt: new Date().toISOString(),
  });
}

export async function registerUserAccount(params: {
  name: string;
  email: string;
  password: string;
}): Promise<{ email: string; message: string; devPreviewCode?: string }> {
  const name = params.name.trim();
  const email = params.email.trim().toLowerCase();
  const password = params.password;

  if (!name || name.length > 100) {
    throw new AuthServiceError(400, 'Enter your name (1–100 characters).');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AuthServiceError(400, 'Enter a valid email address.');
  }
  if (!password || password.length < 6) {
    throw new AuthServiceError(400, 'Password must be at least 6 characters.');
  }

  const existing = await findAccountByEmailOrUsername(email);
  if (existing && existing.isVerified) {
    throw new AuthServiceError(400, 'An account with this email already exists.');
  }

  const requireVerify = isEmailVerificationRequired();
  if (
    requireVerify &&
    process.env.NODE_ENV === 'production' &&
    !isMailDeliveryConfigured()
  ) {
    throw new AuthServiceError(
      503,
      'Email delivery is not configured yet. Ask the administrator to set RESEND_API_KEY or SMTP_USER + SMTP_PASS.',
    );
  }

  const code = requireVerify ? generateSixDigitCode() : null;
  const passwordHash = await bcrypt.hash(password, 10);

  await upsertAccount({
    email,
    username: makeUsername(email, existing?.username),
    name,
    passwordHash,
    isVerified: !requireVerify,
    verificationCode: code,
    codeExpiresAt: code ? new Date(Date.now() + CODE_TTL_MS).toISOString() : null,
    verificationAttempts: 0,
    resetCode: null,
    resetExpiresAt: null,
    resetAttempts: 0,
    createdAt: existing?.createdAt || new Date().toISOString(),
  });

  if (!requireVerify) {
    return {
      email,
      message: 'Account created! You can now sign in.',
    };
  }

  try {
    const mailResult = await sendVerificationEmail(email, name, code!);
    return {
      email,
      message: `We sent a 6-digit verification code to ${email}.`,
      devPreviewCode: mailResult.devPreviewCode,
    };
  } catch (err) {
    throw new AuthServiceError(
      503,
      err instanceof Error ? err.message : 'Unable to send verification email.',
    );
  }
}

export async function verifyUserEmailCode(params: {
  email: string;
  code: string;
  password?: string;
}): Promise<{
  verified: true;
  message: string;
  sessionToken?: string;
  user?: AuthUser;
}> {
  const email = params.email.trim().toLowerCase();
  const code = params.code.replace(/\s+/g, '');

  if (!/^\d{6}$/.test(code)) {
    throw new AuthServiceError(
      400,
      'Enter the 6-digit verification code from your email.',
    );
  }

  const account = await findAccountByEmailOrUsername(email);
  if (!account) {
    throw new AuthServiceError(404, 'Account not found.');
  }

  if (!account.isVerified) {
    if (account.verificationAttempts >= MAX_CODE_ATTEMPTS) {
      throw new AuthServiceError(
        429,
        'Too many incorrect attempts — click Resend Code for a fresh 6-digit code.',
      );
    }
    if (!safeCompareCode(account.verificationCode, code)) {
      await upsertAccount({
        ...account,
        verificationAttempts: account.verificationAttempts + 1,
      });
      throw new AuthServiceError(400, 'Incorrect verification code.');
    }
    if (
      account.codeExpiresAt &&
      new Date(account.codeExpiresAt).getTime() < Date.now()
    ) {
      throw new AuthServiceError(
        400,
        'Verification code expired — request a new one.',
      );
    }

    const verified = await upsertAccount({
      ...account,
      isVerified: true,
      verificationCode: null,
      codeExpiresAt: null,
      verificationAttempts: 0,
    });

    const user = await buildAuthUser(verified);
    const sessionToken = signSessionJwt({
      sub: user.email,
      email: user.email,
      name: user.name,
      uid: user.id,
    });

    return {
      verified: true,
      message: 'Email verified! Signing you in…',
      sessionToken,
      user,
    };
  }

  const user = await buildAuthUser(account);
  const sessionToken = signSessionJwt({
    sub: user.email,
    email: user.email,
    name: user.name,
    uid: user.id,
  });
  return {
    verified: true,
    message: 'Account verified.',
    sessionToken,
    user,
  };
}

export async function resendVerificationEmailCode(
  rawEmail: string,
): Promise<{ message: string; devPreviewCode?: string }> {
  const email = rawEmail.trim().toLowerCase();
  const account = await findAccountByEmailOrUsername(email);
  if (!account || account.isVerified) {
    throw new AuthServiceError(
      400,
      'Account not found or already verified. Try signing in instead.',
    );
  }

  const code = generateSixDigitCode();
  await upsertAccount({
    ...account,
    verificationCode: code,
    codeExpiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    verificationAttempts: 0,
  });

  try {
    const mailResult = await sendVerificationEmail(email, account.name, code);
    return {
      message: `Sent a new 6-digit verification code to ${email}.`,
      devPreviewCode: mailResult.devPreviewCode,
    };
  } catch (err) {
    throw new AuthServiceError(
      503,
      err instanceof Error ? err.message : 'Unable to send verification email.',
    );
  }
}

export async function signInWithEmailPassword(params: {
  email: string;
  password: string;
}): Promise<{ sessionToken: string; user: AuthUser }> {
  const identifier = params.email.trim().toLowerCase();
  const password = params.password;

  if (!identifier || !password) {
    throw new AuthServiceError(
      400,
      'Enter both your email address and password.',
    );
  }

  await ensureBootstrapAdminAccount(identifier, password);

  const account = await findAccountByEmailOrUsername(identifier);
  if (account) {
    const ok = await bcrypt.compare(password, account.passwordHash);
    if (!ok) {
      throw new AuthServiceError(401, 'Incorrect email or password.');
    }
    if (!account.isVerified) {
      throw new AuthServiceError(
        403,
        'Your email is not verified yet. Enter the 6-digit code sent to your inbox.',
        true,
      );
    }

    const user = await buildAuthUser(account);
    const sessionToken = signSessionJwt({
      sub: user.email,
      email: user.email,
      name: user.name,
      uid: user.id,
    });
    return { sessionToken, user };
  }

  // Optional one-time migration from legacy auth server if ZAFAR_AUTH_API_URL is set
  const migrated = await tryMigrateLegacyAccount(identifier, password);
  if (migrated) return migrated;

  throw new AuthServiceError(401, 'Incorrect email or password.');
}

export async function requestPasswordResetCode(
  rawEmail: string,
): Promise<{ message: string; devPreviewCode?: string }> {
  const email = rawEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AuthServiceError(400, 'Enter a valid email address.');
  }

  if (process.env.NODE_ENV === 'production' && !isMailDeliveryConfigured()) {
    throw new AuthServiceError(
      503,
      'Email delivery is not configured yet. Ask the administrator to set RESEND_API_KEY or SMTP_USER + SMTP_PASS.',
    );
  }

  const account = await findAccountByEmailOrUsername(email);
  let devPreviewCode: string | undefined;
  if (account && account.isVerified) {
    const code = generateSixDigitCode();
    await upsertAccount({
      ...account,
      resetCode: code,
      resetExpiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString(),
      resetAttempts: 0,
    });
    const mailResult = await sendPasswordResetEmail(email, code);
    devPreviewCode = mailResult.devPreviewCode;
  }

  return {
    message:
      'If that email has a verified account, a 6-digit reset code has been sent.',
    devPreviewCode,
  };
}

export async function completePasswordReset(params: {
  email: string;
  code: string;
  newPassword: string;
}): Promise<{ message: string }> {
  const email = params.email.trim().toLowerCase();
  const code = params.code.replace(/\s+/g, '');
  const newPassword = params.newPassword;

  if (!/^\d{6}$/.test(code)) {
    throw new AuthServiceError(400, 'Enter the 6-digit password reset code.');
  }
  if (!newPassword || newPassword.length < 6) {
    throw new AuthServiceError(
      400,
      'New password must be at least 6 characters.',
    );
  }

  const account = await findAccountByEmailOrUsername(email);
  if (!account || !account.resetCode) {
    throw new AuthServiceError(400, 'Incorrect or expired reset code.');
  }
  if (account.resetAttempts >= MAX_CODE_ATTEMPTS) {
    throw new AuthServiceError(
      429,
      'Too many incorrect attempts — request a fresh reset code.',
    );
  }
  if (!safeCompareCode(account.resetCode, code)) {
    await upsertAccount({
      ...account,
      resetAttempts: account.resetAttempts + 1,
    });
    throw new AuthServiceError(400, 'Incorrect or expired reset code.');
  }
  if (
    account.resetExpiresAt &&
    new Date(account.resetExpiresAt).getTime() < Date.now()
  ) {
    throw new AuthServiceError(400, 'Reset code expired — request a new one.');
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await upsertAccount({
    ...account,
    passwordHash,
    resetCode: null,
    resetExpiresAt: null,
    resetAttempts: 0,
  });
  return {
    message: 'Password updated — you can now sign in with your new password.',
  };
}

export async function getAuthenticatedSession(req: NextRequest): Promise<{
  user: AuthUser;
  quota: UserQuota | null;
} | null> {
  const rawToken = extractSessionToken(req);
  if (!rawToken) return null;

  let claims;
  try {
    claims = verifySessionJwt(rawToken);
  } catch (err) {
    if (err instanceof JwtConfigError) throw err;
    return null;
  }
  if (!claims) return null;

  const account = await findAccountByEmailOrUsername(claims.email || claims.sub);
  if (!account || !account.isVerified) return null;

  return {
    user: await buildAuthUser(account),
    quota: null,
  };
}

export async function updateUserDisplayName(
  req: NextRequest,
  nextName: string,
): Promise<{ user: AuthUser; sessionToken: string }> {
  const session = await getAuthenticatedSession(req);
  if (!session) {
    throw new AuthServiceError(401, 'Please sign in first.');
  }
  const cleanName = nextName.trim();
  if (!cleanName || cleanName.length > 100) {
    throw new AuthServiceError(
      400,
      'Name must be between 1 and 100 characters.',
    );
  }

  const account = await findAccountByEmailOrUsername(session.user.email);
  if (!account) {
    throw new AuthServiceError(404, 'Account not found.');
  }
  const saved = await upsertAccount({
    ...account,
    name: cleanName,
  });
  const user = await buildAuthUser(saved);
  const sessionToken = signSessionJwt({
    sub: user.email,
    email: user.email,
    name: user.name,
    uid: user.id,
  });
  return { user, sessionToken };
}
