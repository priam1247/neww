import { NextRequest, NextResponse } from 'next/server';
import { AuthServiceError, completePasswordReset } from '@/lib/auth-engine';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  try {
    const result = await completePasswordReset({
      email: String(body.email || ''),
      code: String(body.code || ''),
      newPassword: String(body.newPassword || body.new_password || ''),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof AuthServiceError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: 'Unable to reset password right now.' },
      { status: 500 },
    );
  }
}
