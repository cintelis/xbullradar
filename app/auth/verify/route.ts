import { NextResponse, type NextRequest } from 'next/server';
import { verifyMagicLink, AuthError } from '@/lib/auth';

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
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token') ?? '';

  try {
    await verifyMagicLink(token);
  } catch (err) {
    const code =
      err instanceof AuthError ? err.code ?? 'TOKEN_INVALID' : 'TOKEN_INVALID';
    return NextResponse.redirect(
      new URL(`/sign-in?error=${encodeURIComponent(code)}`, request.url),
    );
  }

  return NextResponse.redirect(new URL('/', request.url));
}
