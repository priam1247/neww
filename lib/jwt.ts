import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

export const SESSION_COOKIE_NAME = 'zafar_session';
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days (matches zafar-backend)

export interface SessionClaims {
  sub: string;
  email?: string;
  name?: string;
  uid?: number | string;
  upstream?: string; // upstream Koyeb bearer token when authenticated via zafar-backend
  exp: number;
  iat?: number;
}

function getSigningSecret(): string {
  const configured = process.env.JWT_SECRET_KEY?.trim();
  if (configured) return configured;

  // Ephemeral per-instance secret when relying purely on upstream zafar-backend verification
  if (!globalThis.__zafarRuntimeJwtSecret) {
    globalThis.__zafarRuntimeJwtSecret = crypto.randomBytes(32).toString('hex');
  }
  return globalThis.__zafarRuntimeJwtSecret;
}

declare global {
  // eslint-disable-next-line no-var
  var __zafarRuntimeJwtSecret: string | undefined;
}

function toBase64Url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + '='.repeat(padLen), 'base64');
}

export function signSessionJwt(
  claims: Omit<SessionClaims, 'exp' | 'iat'>,
  expiresInSeconds = SESSION_MAX_AGE_SECONDS,
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = toBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = toBase64Url(
    JSON.stringify({
      ...claims,
      iat: now,
      exp: now + expiresInSeconds,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const sig = crypto
    .createHmac('sha256', getSigningSecret())
    .update(signingInput)
    .digest();
  return `${signingInput}.${toBase64Url(sig)}`;
}

export function verifySessionJwt(token: string): SessionClaims | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;

    const header = JSON.parse(fromBase64Url(headerB64).toString('utf8'));
    if (header?.alg !== 'HS256') return null;

    const expectedSig = crypto
      .createHmac('sha256', getSigningSecret())
      .update(`${headerB64}.${payloadB64}`)
      .digest();
    const providedSig = fromBase64Url(sigB64);

    if (
      expectedSig.length !== providedSig.length ||
      !crypto.timingSafeEqual(expectedSig, providedSig)
    ) {
      return null;
    }

    const payload = JSON.parse(
      fromBase64Url(payloadB64).toString('utf8'),
    ) as SessionClaims;

    const now = Math.floor(Date.now() / 1000);
    if (!payload.sub || typeof payload.exp !== 'number' || payload.exp <= now) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

export function extractSessionToken(req: NextRequest): string | null {
  const bearer = req.headers
    .get('x-session-token')
    ?.trim() ||
    req.headers
      .get('authorization')
      ?.replace(/^Bearer\s+/i, '')
      .trim();

  if (bearer) return bearer;

  const cookie = req.cookies.get(SESSION_COOKIE_NAME)?.value?.trim();
  return cookie || null;
}

export function attachSessionCookie(res: NextResponse, token: string): NextResponse {
  res.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return res;
}

export function clearSessionCookie(res: NextResponse): NextResponse {
  res.cookies.set(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return res;
}
