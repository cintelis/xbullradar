// Auth domain types for xBullRadar.
//
// Simplified port from C:\code\adsoptimiser-tiktok\src\worker\src\db\user-identity.ts
// — magic-link only, no passwords, no TOTP, no workspace concept, no user_emails
// alias table. Single email per user.

export interface User {
  id: string;          // usr_<base36>_<32hex>
  email: string;       // lowercase, trimmed
  createdAt: string;   // ISO8601
  lastLoginAt: string; // ISO8601
}

export interface MagicLink {
  id: string;          // ml_<base36>_<32hex>
  email: string;       // lowercase, trimmed
  token: string;       // ml_<32hex> — the bearer credential, embedded in the email link
  expiresAt: string;   // ISO8601 (typically +15 minutes from creation)
  usedAt: string | null;
}

export interface Session {
  id: string;          // sess_<base36>_<32hex>
  userId: string;
  email: string;
  createdAt: string;
  expiresAt: string;   // ISO8601 (typically +24 hours from creation)
}

/**
 * AuthStore is the persistence interface used by the magic-link auth flow.
 * Two implementations:
 *   - JsonFileAuthStore (local dev, writes to data/auth.json)
 *   - UpstashAuthStore (production, Redis-backed with native TTLs)
 *
 * Both satisfy the same contract so the route handlers and high-level
 * functions in lib/auth/index.ts don't care which backend is in use.
 */
export interface AuthStore {
  // Users
  getUserById(userId: string): Promise<User | null>;
  getUserByEmail(email: string): Promise<User | null>;
  createUser(email: string): Promise<User>;
  touchUserLogin(userId: string): Promise<void>;

  // Magic links
  createMagicLink(email: string, ttlMinutes: number): Promise<MagicLink>;
  getMagicLinkByToken(token: string): Promise<MagicLink | null>;
  consumeMagicLink(token: string): Promise<void>;

  // Sessions
  createSession(userId: string, email: string, ttlHours: number): Promise<Session>;
  getSession(sessionId: string): Promise<Session | null>;
  revokeSession(sessionId: string): Promise<void>;
}
