import { NextRequest, NextResponse } from 'next/server';
import { AuthServiceError, registerUserAccount } from '@/lib/auth-engine';
import {
  checkRateLimit,
  getClientIp,
  recordRateLimitHit,
} from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const REGISTER_WINDOW_MS = 15 * 60 * 1000;
const MAX_REGISTER_PER_IP = 8;

export async function POST(req: NextRequest) {
  const ipKey = `register:ip:${getClientIp(req)}`;
  const rate = checkRateLimit(ipKey, MAX_REGISTER_PER_IP, REGISTER_WINDOW_MS);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'Too many registration requests. Please wait a few minutes.' },
      {
        status: 429,
        headers: { 'Retry-After': String(rate.retryAfterSeconds) },
      },
    );
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  try {
    recordRateLimitHit(ipKey, REGISTER_WINDOW_MS);
    const result = await registerUserAccount({
      name: String(body.name || ''),
      email: String(body.email || ''),
      password: String(body.password || ''),
    });
    return NextResponse.json({ ok: true, ...result }, { status: 201 });
  } catch (err) {
    if (err instanceof AuthServiceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: 'Unable to send verification email right now. Please try again.' },
      { status: 500 },
    );
  }
}
