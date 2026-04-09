import { NextResponse, type NextRequest } from 'next/server';
import { verifyMagicLink, AuthError } from '@/lib/auth';
import { sendNewUserNotification } from '@/lib/auth/email';

export const runtime = 'nodejs';

/**
 * Step 2 of sign-in: user clicks the link in their email. We verify the
 * token, create a session, set the cookie, and redirect to the dashboard.
 *
 * On failure (token expired, invalid, already used) redirect back to the
 * sign-in page with an error code in the query string.
 *
 * Cookie set via cookies() from next/headers (called inside verifyMagicLink
 * → setSessionCookie). Per Next.js 15 docs, cookie mutations from route
 * handlers are merged into the response, including redirects.
 *
 * On a successful FIRST-TIME sign-in (verifyMagicLink returns isNew=true),
 * fire an admin notification email so the operator gets visibility into
 * who's joining the trial. Fire-and-forget — failures don't block the
 * user's redirect to the dashboard.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token') ?? '';

  try {
    const { user, isNew } = await verifyMagicLink(token);

    if (isNew) {
      // Fire-and-forget admin notification. Don't await — sign-in flow
      // shouldn't be slowed down or blocked by an email send.
      sendNewUserNotification({
        email: user.email,
        userId: user.id,
        signedInAt: new Date().toISOString(),
        ipAddress: extractClientIp(request),
        userAgent: request.headers.get('user-agent'),
      }).catch((err) => {
        console.error('[auth] new user notification failed', err);
      });
    }
  } catch (err) {
    const code =
      err instanceof AuthError ? err.code ?? 'TOKEN_INVALID' : 'TOKEN_INVALID';
    return NextResponse.redirect(
      new URL(`/sign-in?error=${encodeURIComponent(code)}`, request.url),
    );
  }

  return NextResponse.redirect(new URL('/', request.url));
}

/**
 * Pull the originating client IP from forwarding headers Vercel/Cloudflare
 * inject. Falls back through the standard chain. Returns null if nothing
 * is found.
 */
function extractClientIp(request: NextRequest): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    // x-forwarded-for can be a comma-separated chain — first entry is the
    // original client.
    return forwarded.split(',')[0]?.trim() || null;
  }
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-real-ip') ||
    null
  );
}
