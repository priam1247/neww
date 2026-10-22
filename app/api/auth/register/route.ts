import { NextRequest, NextResponse } from 'next/server';
import { AuthServiceError, registerUserAccount } from '@/lib/auth-engine';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  try {
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
