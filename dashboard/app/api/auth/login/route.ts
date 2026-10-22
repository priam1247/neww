import { NextRequest, NextResponse } from 'next/server';
import { AuthServiceError, signInWithEmailPassword } from '@/lib/auth-engine';
import { attachSessionCookie, JwtConfigError } from '@/lib/jwt';
import {
  checkRateLimit,
  clearRateLimit,
  getClientIp,
  recordRateLimitHit,
} from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_IP_FAILURES = 12;
const MAX_ACCOUNT_FAILURES = 6;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const ip = getClientIp(req);

  const ipKey = `login:ip:${ip}`;
  const accountKey = email ? `login:acct:${ip}:${email}` : '';

  const ipCheck = checkRateLimit(ipKey, MAX_IP_FAILURES, LOGIN_WINDOW_MS);
  const acctCheck = accountKey
    ? checkRateLimit(accountKey, MAX_ACCOUNT_FAILURES, LOGIN_WINDOW_MS)
    : { allowed: true, retryAfterSeconds: 0, remaining: MAX_ACCOUNT_FAILURES };

  if (!ipCheck.allowed || !acctCheck.allowed) {
    const retryAfter = Math.max(
      ipCheck.retryAfterSeconds,
      acctCheck.retryAfterSeconds,
      1,
    );
    const waitMinutes = Math.max(1, Math.ceil(retryAfter / 60));
    return NextResponse.json(
      {
        error: `Too many sign-in attempts. Please wait ${waitMinutes} minute${
          waitMinutes === 1 ? '' : 's'
        } before trying again.`,
      },
      {
        status: 429,
        headers: { 'Retry-After': String(retryAfter) },
      },
    );
  }

  try {
    const { sessionToken, user } = await signInWithEmailPassword({
      email,
      password,
    });

    if (accountKey) clearRateLimit(accountKey);

    const res = NextResponse.json({
      ok: true,
      token: sessionToken,
      user,
    });
    return attachSessionCookie(res, sessionToken);
  } catch (err) {
    if (err instanceof JwtConfigError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    if (err instanceof AuthServiceError) {
      if (err.status === 401) {
        recordRateLimitHit(ipKey, LOGIN_WINDOW_MS);
        if (accountKey) recordRateLimitHit(accountKey, LOGIN_WINDOW_MS);
      }
      return NextResponse.json(
        {
          error: err.message,
          needsVerification: Boolean(err.needsVerification),
        },
        { status: err.status },
      );
    }
    return NextResponse.json(
      { error: 'Unable to sign in right now. Please try again.' },
      { status: 500 },
    );
  }
}
