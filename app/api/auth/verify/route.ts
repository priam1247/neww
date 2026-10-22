import { NextRequest, NextResponse } from 'next/server';
import { AuthServiceError, verifyUserEmailCode } from '@/lib/auth-engine';
import { attachSessionCookie } from '@/lib/jwt';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  try {
    const result = await verifyUserEmailCode({
      email: String(body.email || ''),
      code: String(body.code || ''),
      password: body.password ? String(body.password) : undefined,
    });

    const res = NextResponse.json({
      ok: true,
      message: result.message,
      token: result.sessionToken || null,
      user: result.user || null,
    });

    if (result.sessionToken) {
      attachSessionCookie(res, result.sessionToken);
    }
    return res;
  } catch (err) {
    if (err instanceof AuthServiceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: 'Verification failed. Please check your code and try again.' },
      { status: 500 },
    );
  }
}
