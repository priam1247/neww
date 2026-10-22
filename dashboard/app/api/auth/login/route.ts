import { NextRequest, NextResponse } from 'next/server';
import { AuthServiceError, signInWithEmailPassword } from '@/lib/auth-engine';
import { attachSessionCookie } from '@/lib/jwt';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  try {
    const { sessionToken, user } = await signInWithEmailPassword({
      email: String(body.email || ''),
      password: String(body.password || ''),
    });

    const res = NextResponse.json({
      ok: true,
      token: sessionToken,
      user,
    });
    return attachSessionCookie(res, sessionToken);
  } catch (err) {
    if (err instanceof AuthServiceError) {
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
