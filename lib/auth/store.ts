// AuthStore implementations (router, JSON-file, Upstash) for xBullRadar.
//
// Mirrors the pattern in lib/store.ts: a JSON-file backend for local dev and
// an Upstash Redis backend for production. The router picks at module load
// based on whether Upstash credentials are available.
//
// Ported and simplified from:
//   C:\code\adsoptimiser-tiktok\src\worker\src\db\user-identity.ts
//   C:\code\adsoptimiser-tiktok\src\worker\src\db\sessions.ts

import { promises as fs } from 'fs';
import path from 'path';
import { Redis } from '@upstash/redis';
import { getUpstashConfig } from '@/lib/store-upstash';
import type { AuthStore, MagicLink, Session, User } from './types';

// ─── ID generation ──────────────────────────────────────────────────────────

function generateId(prefix: string): string {
  const ts = Date.now().toString(36);
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const rand = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${prefix}_${ts}_${rand}`;
}

/**
 * Magic link tokens use a different shape from normal IDs because they go in
 * URLs and need to be hard to guess. 32 random hex chars = 128 bits of entropy.
 */
function generateMagicLinkToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return (
    'ml_' +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  );
}

function normalizeEmail(email: string): string {
  return String(email ?? '').trim().toLowerCase();
}

// ─── JsonFileAuthStore (local dev) ──────────────────────────────────────────

interface AuthData {
  users: Record<string, User>;          // userId → User
  usersByEmail: Record<string, string>; // email → userId
  magicLinks: Record<string, MagicLink>; // token → MagicLink
  sessions: Record<string, Session>;     // sessionId → Session
}

const EMPTY_AUTH_DATA: AuthData = {
  users: {},
  usersByEmail: {},
  magicLinks: {},
  sessions: {},
};

class JsonFileAuthStore implements AuthStore {
  private readonly filePath: string;
  private cache: AuthData | null = null;
  private writePromise: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private async load(): Promise<AuthData> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      this.cache = { ...EMPTY_AUTH_DATA, ...JSON.parse(raw) };
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        this.cache = JSON.parse(JSON.stringify(EMPTY_AUTH_DATA));
        await this.persist();
      } else {
        throw err;
      }
    }
    return this.cache!;
  }

  private async persist(): Promise<void> {
    this.writePromise = this.writePromise.then(async () => {
      if (!this.cache) return;
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(this.cache, null, 2), 'utf-8');
    });
    return this.writePromise;
  }

  /**
   * Best-effort cleanup of expired magic links and sessions on every load.
   * Cheap because the JSON store is small in dev.
   */
  private sweepExpired(data: AuthData): void {
    const now = Date.now();
    for (const [token, ml] of Object.entries(data.magicLinks)) {
      if (new Date(ml.expiresAt).getTime() < now) {
        delete data.magicLinks[token];
      }
    }
    for (const [id, sess] of Object.entries(data.sessions)) {
      if (new Date(sess.expiresAt).getTime() < now) {
        delete data.sessions[id];
      }
    }
  }

  async getUserById(userId: string): Promise<User | null> {
    const data = await this.load();
    return data.users[userId] ?? null;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const data = await this.load();
    const userId = data.usersByEmail[normalizeEmail(email)];
    if (!userId) return null;
    return data.users[userId] ?? null;
  }

  async createUser(email: string): Promise<User> {
    const data = await this.load();
    const normalized = normalizeEmail(email);
    const existingId = data.usersByEmail[normalized];
    if (existingId) {
      const existing = data.users[existingId];
      if (existing) return existing;
    }

    const now = new Date().toISOString();
    const user: User = {
      id: generateId('usr'),
      email: normalized,
      createdAt: now,
      lastLoginAt: now,
    };
    data.users[user.id] = user;
    data.usersByEmail[normalized] = user.id;
    await this.persist();
    return user;
  }

  async touchUserLogin(userId: string): Promise<void> {
    const data = await this.load();
    const user = data.users[userId];
    if (!user) return;
    user.lastLoginAt = new Date().toISOString();
    await this.persist();
  }

  async createMagicLink(email: string, ttlMinutes: number): Promise<MagicLink> {
    const data = await this.load();
    this.sweepExpired(data);
    const ml: MagicLink = {
      id: generateId('ml'),
      email: normalizeEmail(email),
      token: generateMagicLinkToken(),
      expiresAt: new Date(Date.now() + Math.max(1, ttlMinutes) * 60 * 1000).toISOString(),
      usedAt: null,
    };
    data.magicLinks[ml.token] = ml;
    await this.persist();
    return ml;
  }

  async getMagicLinkByToken(token: string): Promise<MagicLink | null> {
    const data = await this.load();
    const ml = data.magicLinks[String(token ?? '').trim()];
    if (!ml) return null;
    if (ml.usedAt) return null;
    if (new Date(ml.expiresAt).getTime() < Date.now()) return null;
    return ml;
  }

  async consumeMagicLink(token: string): Promise<void> {
    const data = await this.load();
    const ml = data.magicLinks[String(token ?? '').trim()];
    if (!ml) return;
    ml.usedAt = new Date().toISOString();
    await this.persist();
  }

  async createSession(userId: string, email: string, ttlHours: number): Promise<Session> {
    const data = await this.load();
    this.sweepExpired(data);
    const now = new Date();
    const session: Session = {
      id: generateId('sess'),
      userId,
      email: normalizeEmail(email),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + Math.max(1, ttlHours) * 60 * 60 * 1000).toISOString(),
    };
    data.sessions[session.id] = session;
    await this.persist();
    return session;
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const data = await this.load();
    const session = data.sessions[sessionId];
    if (!session) return null;
    if (new Date(session.expiresAt).getTime() < Date.now()) {
      delete data.sessions[sessionId];
      await this.persist();
      return null;
    }
    return session;
  }

  async revokeSession(sessionId: string): Promise<void> {
    const data = await this.load();
    if (!data.sessions[sessionId]) return;
    delete data.sessions[sessionId];
    await this.persist();
  }
}

// ─── UpstashAuthStore (production) ──────────────────────────────────────────

const KEY_USER = (id: string) => `xbr:user:${id}`;
const KEY_USER_BY_EMAIL = (email: string) => `xbr:user:byEmail:${email}`;
const KEY_MAGIC_LINK = (token: string) => `xbr:ml:${token}`;
const KEY_SESSION = (id: string) => `xbr:session:${id}`;

class UpstashAuthStore implements AuthStore {
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  // Upstash auto-deserializes some shapes; be defensive about both string and
  // object responses (mirrors parseObject in lib/store-upstash.ts).
  private parse<T>(raw: unknown): T | null {
    if (raw == null) return null;
    if (typeof raw === 'object') return raw as T;
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    }
    return null;
  }

  async getUserById(userId: string): Promise<User | null> {
    const raw = await this.redis.get<string | User>(KEY_USER(userId));
    return this.parse<User>(raw);
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const userId = await this.redis.get<string>(KEY_USER_BY_EMAIL(normalizeEmail(email)));
    if (!userId || typeof userId !== 'string') return null;
    return this.getUserById(userId);
  }

  async createUser(email: string): Promise<User> {
    const normalized = normalizeEmail(email);
    const existing = await this.getUserByEmail(normalized);
    if (existing) return existing;

    const now = new Date().toISOString();
    const user: User = {
      id: generateId('usr'),
      email: normalized,
      createdAt: now,
      lastLoginAt: now,
    };
    // No transaction here — race window is "two parallel sign-ins for a brand
    // new email"; loser overwrites the winner with identical data. Acceptable.
    await Promise.all([
      this.redis.set(KEY_USER(user.id), JSON.stringify(user)),
      this.redis.set(KEY_USER_BY_EMAIL(normalized), user.id),
    ]);
    return user;
  }

  async touchUserLogin(userId: string): Promise<void> {
    const user = await this.getUserById(userId);
    if (!user) return;
    user.lastLoginAt = new Date().toISOString();
    await this.redis.set(KEY_USER(user.id), JSON.stringify(user));
  }

  async createMagicLink(email: string, ttlMinutes: number): Promise<MagicLink> {
    const ttl = Math.max(1, ttlMinutes);
    const ml: MagicLink = {
      id: generateId('ml'),
      email: normalizeEmail(email),
      token: generateMagicLinkToken(),
      expiresAt: new Date(Date.now() + ttl * 60 * 1000).toISOString(),
      usedAt: null,
    };
    // Native EX TTL handles expiry — no sweep job needed.
    await this.redis.set(KEY_MAGIC_LINK(ml.token), JSON.stringify(ml), { ex: ttl * 60 });
    return ml;
  }

  async getMagicLinkByToken(token: string): Promise<MagicLink | null> {
    const ml = this.parse<MagicLink>(
      await this.redis.get<string | MagicLink>(KEY_MAGIC_LINK(String(token ?? '').trim())),
    );
    if (!ml) return null;
    if (ml.usedAt) return null;
    return ml;
  }

  async consumeMagicLink(token: string): Promise<void> {
    // Single-use: just delete the key. The link is unrecoverable after this.
    await this.redis.del(KEY_MAGIC_LINK(String(token ?? '').trim()));
  }

  async createSession(userId: string, email: string, ttlHours: number): Promise<Session> {
    const ttl = Math.max(1, ttlHours);
    const now = new Date();
    const session: Session = {
      id: generateId('sess'),
      userId,
      email: normalizeEmail(email),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttl * 60 * 60 * 1000).toISOString(),
    };
    await this.redis.set(KEY_SESSION(session.id), JSON.stringify(session), {
      ex: ttl * 60 * 60,
    });
    return session;
  }

  async getSession(sessionId: string): Promise<Session | null> {
    return this.parse<Session>(
      await this.redis.get<string | Session>(KEY_SESSION(sessionId)),
    );
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.redis.del(KEY_SESSION(sessionId));
  }
}

// ─── Router (lazy-initialized so module load is side-effect free) ───────────

let _authStore: AuthStore | null = null;

function createAuthStore(): AuthStore {
  const config = getUpstashConfig();
  if (config) {
    return new UpstashAuthStore(new Redis({ url: config.url, token: config.token }));
  }
  const filePath =
    process.env.XBULLRADAR_AUTH_PATH ||
    path.join(process.cwd(), 'data', 'auth.json');
  return new JsonFileAuthStore(filePath);
}

/**
 * Lazy accessor — the store is only instantiated on first use, not at
 * module load. This keeps the auth modules safe to import from any context
 * (Server Components, Route Handlers, build-time scripts) without forcing
 * a Redis client construction or filesystem touch.
 */
export function getAuthStore(): AuthStore {
  if (!_authStore) {
    _authStore = createAuthStore();
  }
  return _authStore;
}

// Backwards-compat shim: a Proxy that defers to the lazy accessor on every
// access. Lets callers continue to write `authStore.getUserById(...)` while
// the actual instance is created on demand.
export const authStore: AuthStore = new Proxy({} as AuthStore, {
  get(_target, prop) {
    const store = getAuthStore();
    const value = (store as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === 'function' ? value.bind(store) : value;
  },
});
