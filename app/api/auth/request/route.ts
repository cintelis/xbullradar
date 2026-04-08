import { NextResponse, type NextRequest } from 'next/server';
import { requestMagicLink, AuthError } from '@/lib/auth';

export const runtime = 'nodejs';

/**
 * Step 1 of sign-in: client posts an email, we generate a magic link and
 * email it. Always returns a generic success message on a happy path so
 * the response can't be used to enumerate the allowlist.
 *
 * Errors that DO get surfaced to the user:
 *   - Invalid email format (so they can fix the typo)
 *   - Email service down (so they don't sit there waiting)
 *
 * Allowlist rejections return 200 with the same generic success message
 * to prevent probing — but log them server-side so the operator can see
 * who tried to sign in without an invite.
 */
export async function POST(request: NextRequest) {
  let email: string;
  try {
    const body = (await request.json()) as { email?: string };
    email = String(body?.email ?? '').trim();
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  if (!email) {
    return NextResponse.json({ error: 'Email is required.' }, { status: 400 });
  }

  try {
    await requestMagicLink(email);
  } catch (err) {
    if (err instanceof AuthError) {
      // Invalid email format → surface immediately so user can fix the typo.
      if (err.code === 'INVALID_EMAIL') {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      // Allowlist rejection → fall through to the generic success response
      // below so attackers can't probe membership. Log it server-side.
      if (err.code === 'NOT_ALLOWLISTED') {
        console.warn(`[auth] sign-in attempt from non-allowlisted email: ${email}`);
        return NextResponse.json({ success: true });
      }
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[auth/request] failed', err);
    return NextResponse.json(
      { error: 'Could not send sign-in email. Please try again in a moment.' },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true });
}
