// Session cookie helpers for xBullRadar.
//
// Uses Next.js 15 `cookies()` from next/headers. Cookie is httpOnly, Secure
// in production, SameSite=Lax. Single Vercel domain — no Domain attribute,
// so the cookie is scoped to whichever host is serving the response (the
// production deploy and any preview deploys each get their own session).
//
// Ported from C:\code\adsoptimiser-tiktok\src\worker\src\lib\session.ts
// (Hono-based) and adapted for Next.js Route Handlers / Server Components.

import { cookies } from 'next/headers';
import { authStore } from './store';
import type { Session, User } from './types';

const SESSION_COOKIE_NAME = 'xbr_session';
const SESSION_TTL_HOURS_DEFAULT = 24;

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function getSessionTtlHours(): number {
  const raw = process.env.SESSION_TTL_HOURS;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return SESSION_TTL_HOURS_DEFAULT;
}

/**
 * Set the session cookie on the current response. Call this from the
 * verify route handler after creating a session.
 */
export async function setSessionCookie(session: Session): Promise<void> {
  const jar = await cookies();
  jar.set({
    name: SESSION_COOKIE_NAME,
    value: session.id,
    httpOnly: true,
    secure: isProduction(),
    sameSite: 'lax',
    path: '/',
    expires: new Date(session.expiresAt),
  });
}

/**
 * Clear the session cookie. Call this from the sign-out handler.
 */
export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.set({
    name: SESSION_COOKIE_NAME,
    value: '',
    httpOnly: true,
    secure: isProduction(),
    sameSite: 'lax',
    path: '/',
    expires: new Date(0),
    maxAge: 0,
  });
}

/**
 * Read the current session from the cookie. Returns the Session record (not
 * the User) if the cookie exists, the session is in the store, and it
 * hasn't expired. Returns null otherwise.
 *
 * Safe to call from Server Components, Route Handlers, and Server Actions.
 */
export async function getSessionFromCookie(): Promise<Session | null> {
  const jar = await cookies();
  const sessionId = jar.get(SESSION_COOKIE_NAME)?.value;
  if (!sessionId) return null;
  return authStore.getSession(sessionId);
}

/**
 * Read the currently authenticated user (full user record). Convenience
 * wrapper around getSessionFromCookie() + authStore.getUserById().
 */
export async function getCurrentUser(): Promise<User | null> {
  const session = await getSessionFromCookie();
  if (!session) return null;
  return authStore.getUserById(session.userId);
}

/**
 * Like getCurrentUser() but throws if there's no authenticated user. Use in
 * Route Handlers that should 401 unauthenticated requests.
 */
export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) {
    throw new UnauthorizedError();
  }
  return user;
}

export class UnauthorizedError extends Error {
  status = 401;
  constructor(message = 'Not authenticated') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export { SESSION_COOKIE_NAME, getSessionTtlHours };
