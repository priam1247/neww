import { NextRequest, NextResponse } from 'next/server';
import {
  AuthServiceError,
  getAuthenticatedSession,
  updateUserDisplayName,
} from '@/lib/auth-engine';
import { attachSessionCookie, JwtConfigError } from '@/lib/jwt';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const session = await getAuthenticatedSession(req);
    if (!session) {
      return NextResponse.json(
        { authenticated: false, user: null },
        { status: 401 },
      );
    }
    return NextResponse.json({
      authenticated: true,
      user: session.user,
      quota: session.quota,
    });
  } catch (err) {
    if (err instanceof JwtConfigError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    return NextResponse.json(
      { authenticated: false, user: null },
      { status: 401 },
    );
  }
}

export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  try {
    const { user, sessionToken } = await updateUserDisplayName(
      req,
      String(body.name || ''),
    );
    const res = NextResponse.json({ ok: true, user, token: sessionToken });
    return attachSessionCookie(res, sessionToken);
  } catch (err) {
    if (err instanceof JwtConfigError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    if (err instanceof AuthServiceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: 'Unable to update profile name.' },
      { status: 500 },
    );
  }
}
