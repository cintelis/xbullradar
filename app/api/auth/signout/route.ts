import { NextResponse, type NextRequest } from 'next/server';
import { signOut } from '@/lib/auth';

export const runtime = 'nodejs';

/**
 * Sign out the current user. Revokes the session in the store and clears
 * the cookie. Idempotent — safe to call when not signed in.
 *
 * POST so it's not callable via a stray <a href> or browser prefetch.
 * Redirects to /sign-in on success.
 */
export async function POST(request: NextRequest) {
  await signOut();
  return NextResponse.redirect(new URL('/sign-in', request.url), { status: 303 });
}
