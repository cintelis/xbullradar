// High-level auth functions for xBullRadar.
//
// These are the only entry points the route handlers and server components
// should use. They wrap authStore + email + cookies to provide the three
// magic-link operations the rest of the app needs:
//
//   requestMagicLink(email)  → generate token, persist, send email
//   verifyMagicLink(token)   → consume token, find/create user, create session
//   signOut()                → revoke session, clear cookie
//
// Plus session readers re-exported from ./session.

import { authStore } from './store';
import { sendMagicLinkEmail } from './email';
import {
  getCurrentUser,
  getSessionFromCookie,
  setSessionCookie,
  clearSessionCookie,
  requireUser,
  getSessionTtlHours,
  UnauthorizedError,
} from './session';
import type { Session, User } from './types';

const MAGIC_LINK_TTL_MINUTES = 15;

export class AuthError extends Error {
  constructor(message: string, public status = 400, public code?: string) {
    super(message);
    this.name = 'AuthError';
  }
}

// ─── Allowlist (limited trial gate) ─────────────────────────────────────────

/**
 * Limited-trial allowlist. Only emails listed in ALLOWED_EMAILS may sign in.
 * The env var is comma- or whitespace-separated and case-insensitive.
 *
 *   ALLOWED_EMAILS=alice@x.com, bob@y.com  carol@z.com
 *
 * If ALLOWED_EMAILS is unset, the allowlist is OFF and any email can sign in.
 * That's intentional for local dev. In production set the env var.
 */
function getAllowlist(): Set<string> | null {
  const raw = process.env.ALLOWED_EMAILS?.trim();
  if (!raw) return null;
  const emails = raw
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set(emails);
}

function isEmailAllowed(email: string): boolean {
  const list = getAllowlist();
  if (!list) return true;
  return list.has(email.trim().toLowerCase());
}

function isValidEmail(email: string): boolean {
  // Intentionally simple — we don't need RFC 5322 perfection, just
  // "looks like an email and has a dot in the domain".
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ─── Operations ─────────────────────────────────────────────────────────────

/**
 * Step 1 of sign-in: user submits their email, we generate a magic-link
 * token and email it to them. Idempotent — calling twice in a row creates
 * two valid links until the first is consumed or expires.
 *
 * Throws AuthError on validation failure or if the email isn't allowlisted.
 * Email send failures bubble up as EmailServiceError.
 *
 * Returns the magic link object (without the token!) for telemetry. Never
 * return the token from the API — only emit it via the email channel.
 */
export async function requestMagicLink(email: string): Promise<{
  email: string;
  expiresAt: string;
}> {
  const normalized = String(email ?? '').trim().toLowerCase();

  if (!isValidEmail(normalized)) {
    throw new AuthError('Please enter a valid email address.', 400, 'INVALID_EMAIL');
  }

  if (!isEmailAllowed(normalized)) {
    // Same error message as a successful send, so an attacker can't probe
    // the allowlist by submitting random emails. The route handler returns
    // a generic "check your email" response either way.
    throw new AuthError(
      'This email is not approved for the trial. Contact the team to request access.',
      403,
      'NOT_ALLOWLISTED',
    );
  }

  const ml = await authStore.createMagicLink(normalized, MAGIC_LINK_TTL_MINUTES);

  await sendMagicLinkEmail({
    email: normalized,
    token: ml.token,
    expiresInMinutes: MAGIC_LINK_TTL_MINUTES,
  });

  return { email: normalized, expiresAt: ml.expiresAt };
}

/**
 * Step 2 of sign-in: user clicks the link in their email, we verify the
 * token, mark it consumed, find or create the user, create a session, and
 * set the session cookie. Returns the user AND a flag indicating whether
 * this was the user's first ever sign-in (used by the route handler to
 * fire the admin notification email only for genuinely new users).
 *
 * Throws AuthError if the token is missing/expired/already-used.
 */
export async function verifyMagicLink(token: string): Promise<{ user: User; isNew: boolean }> {
  const trimmed = String(token ?? '').trim();
  if (!trimmed) {
    throw new AuthError('Sign-in link is missing.', 400, 'TOKEN_MISSING');
  }

  const ml = await authStore.getMagicLinkByToken(trimmed);
  if (!ml) {
    throw new AuthError(
      'Sign-in link is invalid or has expired. Request a new one.',
      400,
      'TOKEN_INVALID',
    );
  }

  // Consume immediately to prevent replay. If anything below fails the link
  // is still gone — user just requests another. Better than leaving a window
  // where two parallel verifies could both succeed.
  await authStore.consumeMagicLink(trimmed);

  // Re-check allowlist at verify time too. Catches the case where an email
  // was allowlisted at request time but removed before they clicked the link.
  if (!isEmailAllowed(ml.email)) {
    throw new AuthError(
      'This email is no longer approved for the trial.',
      403,
      'NOT_ALLOWLISTED',
    );
  }

  // Detect first-time sign-in BEFORE createUser() so the caller can fire
  // an admin notification only for genuinely new users (not returning
  // sign-ins). createUser() is idempotent — returns the existing user if
  // the email is already registered, so we need the lookup beforehand.
  const existingUser = await authStore.getUserByEmail(ml.email);
  const isNew = !existingUser;

  // Find or create the user. New users get auto-provisioned on first verify.
  const user = await authStore.createUser(ml.email);
  await authStore.touchUserLogin(user.id);

  // Create session and set cookie.
  const session = await authStore.createSession(user.id, user.email, getSessionTtlHours());
  await setSessionCookie(session);

  return { user, isNew };
}

/**
 * Sign out the current user. Revokes the session in the store and clears
 * the cookie. Idempotent — safe to call when not signed in.
 */
export async function signOut(): Promise<void> {
  const session = await getSessionFromCookie();
  if (session) {
    await authStore.revokeSession(session.id);
  }
  await clearSessionCookie();
}

// Re-export session readers so callers only need to import from this module.
export {
  getCurrentUser,
  getSessionFromCookie,
  requireUser,
  UnauthorizedError,
};
export type { Session, User };
