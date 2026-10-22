import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { NextRequest } from 'next/server';
import {
  isDirectSmtpConfigured,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from './email-service';
import { extractSessionToken, signSessionJwt, verifySessionJwt } from './jwt';
import {
  findAccountByEmailOrUsername,
  isMemberEmailAllowed,
  setMemberPermission,
  upsertAccount,
} from './storage';
import { AuthUser, UserQuota } from './types';

export const PRIMARY_ADMIN_EMAIL = 'troykunsauka@gmail.com';
const DEFAULT_KOYEB_AUTH_URL = 'https://bloody-brigitta-ahzafar-de9b1709.koyeb.app';
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

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
  return PRIMARY_ADMIN_EMAIL;
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

function getKoyebAuthUrl(): string {
  return (process.env.ZAFAR_AUTH_API_URL?.trim() || DEFAULT_KOYEB_AUTH_URL).replace(
    /\/+$/,
    '',
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

function extractFastApiError(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback;
  const detail = (payload as { detail?: unknown; message?: string }).detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail) && detail.length > 0) {
    const first = detail[0] as { msg?: string };
    if (first?.msg) return first.msg.replace(/^Value error,\s*/i, '');
  }
  return (payload as { message?: string }).message || fallback;
}

async function callKoyebAuth<T>(
  path: string,
  options: {
    method?: string;
    json?: unknown;
    form?: Record<string, string>;
    bearer?: string;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: BodyInit | undefined;

  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  } else if (options.form !== undefined) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(options.form).toString();
  }
  if (options.bearer) {
    headers['Authorization'] = `Bearer ${options.bearer}`;
  }

  let res: Response;
  try {
    res = await fetch(`${getKoyebAuthUrl()}${path}`, {
      method: options.method || 'GET',
      headers,
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(35_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Network error';
    throw new AuthServiceError(
      502,
      `Email authentication server is waking up or unreachable (${msg}). Try again in a moment.`,
    );
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = extractFastApiError(data, `Authentication error (${res.status})`);
    throw new AuthServiceError(
      res.status,
      message,
      res.status === 403 && /not verified/i.test(message),
    );
  }
  return data as T;
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

  if (isDirectSmtpConfigured()) {
    const existing = await findAccountByEmailOrUsername(email);
    if (existing && existing.isVerified) {
      throw new AuthServiceError(400, 'An account with this email already exists.');
    }

    const code = generateSixDigitCode();
    const passwordHash = await bcrypt.hash(password, 10);
    const baseUsername =
      email.split('@')[0].replace(/[^a-z0-9_]/gi, '').toLowerCase() || 'user';
    const username = existing?.username || `${baseUsername}_${Date.now().toString(36)}`;

    await upsertAccount({
      email,
      username,
      name,
      passwordHash,
      isVerified: false,
      verificationCode: code,
      codeExpiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString(),
      verificationAttempts: 0,
      resetCode: null,
      resetExpiresAt: null,
      resetAttempts: 0,
      createdAt: existing?.createdAt || new Date().toISOString(),
    });

    const mailResult = await sendVerificationEmail(email, name, code);
    return {
      email,
      message: `We sent a 6-digit verification code to ${email}.`,
      devPreviewCode: mailResult.devPreviewCode,
    };
  }

  const upstream = await callKoyebAuth<{ message: string; email: string }>(
    '/auth/register',
    {
      method: 'POST',
      json: { name, email, password },
    },
  );
  return {
    email: upstream.email || email,
    message: `We sent a 6-digit verification code to ${email}.`,
  };
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
    throw new AuthServiceError(400, 'Enter the 6-digit verification code from your email.');
  }

  if (isDirectSmtpConfigured()) {
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

  await callKoyebAuth<{ message: string }>('/auth/verify', {
    method: 'POST',
    json: { email, code },
  });

  if (params.password) {
    const signedIn = await signInWithEmailPassword({
      email,
      password: params.password,
    });
    return {
      verified: true,
      message: 'Email verified! Welcome to ZaFar.',
      sessionToken: signedIn.sessionToken,
      user: signedIn.user,
    };
  }

  return {
    verified: true,
    message: 'Email verified — you can now sign in.',
  };
}

export async function resendVerificationEmailCode(
  rawEmail: string,
): Promise<{ message: string; devPreviewCode?: string }> {
  const email = rawEmail.trim().toLowerCase();

  if (isDirectSmtpConfigured()) {
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
    const mailResult = await sendVerificationEmail(email, account.name, code);
    return {
      message: `Sent a new 6-digit verification code to ${email}.`,
      devPreviewCode: mailResult.devPreviewCode,
    };
  }

  await callKoyebAuth<{ message: string }>('/auth/resend', {
    method: 'POST',
    json: { email },
  });
  return { message: `Sent a new 6-digit verification code to ${email}.` };
}

export async function signInWithEmailPassword(params: {
  email: string;
  password: string;
}): Promise<{ sessionToken: string; user: AuthUser }> {
  const identifier = params.email.trim().toLowerCase();
  const password = params.password;

  if (!identifier || !password) {
    throw new AuthServiceError(400, 'Enter both your email address and password.');
  }

  if (isDirectSmtpConfigured()) {
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
  }

  let tokenRes: { access_token: string };
  try {
    tokenRes = await callKoyebAuth<{ access_token: string }>('/auth/login', {
      method: 'POST',
      form: { email: identifier, password },
    });
  } catch (err) {
    if (
      isDirectSmtpConfigured() &&
      err instanceof AuthServiceError &&
      err.status === 502
    ) {
      throw new AuthServiceError(401, 'Incorrect email or password.');
    }
    throw err;
  }

  const profile = await callKoyebAuth<{
    id: number;
    name: string | null;
    email: string | null;
    username: string;
    is_verified: boolean;
    created_at: string;
  }>('/auth/me', {
    bearer: tokenRes.access_token,
  });

  const resolvedEmail = (profile.email || identifier).toLowerCase();
  const resolvedName = profile.name || profile.username || 'Member';
  const currentlyAllowed = await isMemberEmailAllowed(resolvedEmail);
  await setMemberPermission(resolvedEmail, currentlyAllowed, resolvedName);

  const user = await buildAuthUser({
    id: profile.id,
    name: resolvedName,
    email: resolvedEmail,
    username: profile.username,
    isVerified: profile.is_verified,
    createdAt: profile.created_at,
  });

  const sessionToken = signSessionJwt({
    sub: user.email,
    email: user.email,
    name: user.name,
    uid: user.id,
    upstream: tokenRes.access_token,
  });

  return { sessionToken, user };
}

export async function requestPasswordResetCode(
  rawEmail: string,
): Promise<{ message: string; devPreviewCode?: string }> {
  const email = rawEmail.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AuthServiceError(400, 'Enter a valid email address.');
  }

  if (isDirectSmtpConfigured()) {
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
      message: 'If that email has a verified account, a 6-digit reset code has been sent.',
      devPreviewCode,
    };
  }

  await callKoyebAuth<{ message: string }>('/auth/forgot-password', {
    method: 'POST',
    json: { email },
  });
  return {
    message: 'If that email has a verified account, a 6-digit reset code has been sent.',
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
    throw new AuthServiceError(400, 'New password must be at least 6 characters.');
  }

  if (isDirectSmtpConfigured()) {
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
    return { message: 'Password updated — you can now sign in with your new password.' };
  }

  return callKoyebAuth<{ message: string }>('/auth/reset-password', {
    method: 'POST',
    json: { email, code, new_password: newPassword },
  });
}

export async function getAuthenticatedSession(req: NextRequest): Promise<{
  user: AuthUser;
  quota: UserQuota | null;
  upstreamToken?: string;
} | null> {
  const rawToken = extractSessionToken(req);
  if (!rawToken) return null;

  const claims = verifySessionJwt(rawToken);
  if (!claims) return null;

  if (claims.upstream) {
    try {
      const [me, quota] = await Promise.all([
        callKoyebAuth<{
          id: number;
          name: string | null;
          email: string | null;
          username: string;
          is_verified: boolean;
          created_at: string;
        }>('/auth/me', { bearer: claims.upstream }),
        callKoyebAuth<UserQuota>('/auth/quota', { bearer: claims.upstream }).catch(
          () => null,
        ),
      ]);

      return {
        user: await buildAuthUser({
          id: me.id,
          name: me.name || me.username,
          email: me.email || claims.email || claims.sub,
          username: me.username,
          isVerified: me.is_verified,
          createdAt: me.created_at,
        }),
        quota,
        upstreamToken: claims.upstream,
      };
    } catch {
      return null;
    }
  }

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
    throw new AuthServiceError(400, 'Name must be between 1 and 100 characters.');
  }

  if (session.upstreamToken) {
    const updated = await callKoyebAuth<{
      id: number;
      name: string | null;
      email: string | null;
      username: string;
      is_verified: boolean;
      created_at: string;
    }>('/auth/name', {
      method: 'PATCH',
      bearer: session.upstreamToken,
      json: { name: cleanName },
    });

    const user = await buildAuthUser({
      id: updated.id,
      name: updated.name || cleanName,
      email: updated.email || session.user.email,
      username: updated.username,
      isVerified: updated.is_verified,
      createdAt: updated.created_at,
    });

    const sessionToken = signSessionJwt({
      sub: user.email,
      email: user.email,
      name: user.name,
      uid: user.id,
      upstream: session.upstreamToken,
    });
    return { user, sessionToken };
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
