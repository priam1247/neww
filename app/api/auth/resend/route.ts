import { NextRequest, NextResponse } from 'next/server';
import { AuthServiceError, resendVerificationEmailCode } from '@/lib/auth-engine';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  try {
    const result = await resendVerificationEmailCode(String(body.email || ''));
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof AuthServiceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: 'Could not resend verification email right now.' },
      { status: 500 },
    );
  }
}
