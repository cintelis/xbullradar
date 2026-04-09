// Upstash Redis-backed Store implementation for xBullRadar.
//
// Activated when UPSTASH_REDIS_REST_URL is set in env. Used in production
// (Vercel) where there is no writable filesystem. Works on any serverless
// host because it talks to Upstash over HTTPS, not TCP — no connection
// pooling required.
//
// As of Commit 2 (per-user refactor), each user has their own keys:
//   xbr:user:{userId}:watchlist           string  (JSON array of tickers)
//   xbr:user:{userId}:holdings            string  (JSON array of holdings)
//   xbr:user:{userId}:sentiment:last      hash    (field=ticker, value=JSON)
//   xbr:users                             set     (set of all userIds for cron)
//
// Hash for last-sentiment lets the daily scan write 7 ticker scores as 7
// HSET field updates per user instead of rewriting one big blob.

import { Redis } from '@upstash/redis';
import type { CashHolding, PortfolioHolding, StockSentiment } from '@/types';
import type { Store } from './store-types';
import { DEFAULT_USER_DATA } from './store-types';

const KEY_USERS_SET = 'xbr:users';
const KEY_WATCHLIST = (userId: string) => `xbr:user:${userId}:watchlist`;
const KEY_HOLDINGS = (userId: string) => `xbr:user:${userId}:holdings`;
const KEY_CASH = (userId: string) => `xbr:user:${userId}:cash`;
const KEY_SENTIMENT_HASH = (userId: string) => `xbr:user:${userId}:sentiment:last`;

export class UpstashStore implements Store {
  private readonly redis: Redis;
  private readonly seedPromises = new Map<string, Promise<void>>();

  constructor(redis: Redis) {
    this.redis = redis;
  }

  /**
   * One-time seed of defaults if a user's watchlist key is missing. Cached
   * per user so parallel reads during a cold start await the same operation.
   * Also adds the userId to the global users set so the cron can iterate.
   */
  private async ensureUserSeeded(userId: string): Promise<void> {
    const existing = this.seedPromises.get(userId);
    if (existing) return existing;

    const promise = (async () => {
      const exists = await this.redis.exists(KEY_WATCHLIST(userId));
      if (!exists) {
        await Promise.all([
          this.redis.set(KEY_WATCHLIST(userId), JSON.stringify(DEFAULT_USER_DATA.watchlist)),
          this.redis.set(KEY_HOLDINGS(userId), JSON.stringify(DEFAULT_USER_DATA.holdings)),
        ]);
      }
      // Always SADD — it's idempotent and cheap. Ensures the cron sees this user
      // even if their watchlist key existed but they weren't yet in the set
      // (shouldn't happen, but defensive against partial state).
      await this.redis.sadd(KEY_USERS_SET, userId);
    })();

    this.seedPromises.set(userId, promise);
    return promise;
  }

  async getWatchlist(userId: string): Promise<string[]> {
    await this.ensureUserSeeded(userId);
    const raw = await this.redis.get<string | string[]>(KEY_WATCHLIST(userId));
    return parseArray<string>(raw, DEFAULT_USER_DATA.watchlist);
  }

  async setWatchlist(userId: string, tickers: string[]): Promise<void> {
    await this.ensureUserSeeded(userId);
    const upper = tickers.map((t) => t.toUpperCase());
    await this.redis.set(KEY_WATCHLIST(userId), JSON.stringify(upper));
  }

  async getHoldings(userId: string): Promise<PortfolioHolding[]> {
    await this.ensureUserSeeded(userId);
    const raw = await this.redis.get<string | PortfolioHolding[]>(KEY_HOLDINGS(userId));
    return parseArray<PortfolioHolding>(raw, DEFAULT_USER_DATA.holdings);
  }

  async setHoldings(userId: string, holdings: PortfolioHolding[]): Promise<void> {
    await this.ensureUserSeeded(userId);
    await this.redis.set(KEY_HOLDINGS(userId), JSON.stringify(holdings));
  }

  async getCash(userId: string): Promise<CashHolding[]> {
    await this.ensureUserSeeded(userId);
    // No backfill on the cash key — if it's missing (legacy users from
    // before the cash field shipped) we return an empty array. Lazy
    // upgrade: setCash will create the key on the first write.
    const raw = await this.redis.get<string | CashHolding[]>(KEY_CASH(userId));
    return parseArray<CashHolding>(raw, []);
  }

  async setCash(userId: string, cash: CashHolding[]): Promise<void> {
    await this.ensureUserSeeded(userId);
    await this.redis.set(KEY_CASH(userId), JSON.stringify(cash));
  }

  async getLastSentiment(userId: string, ticker: string): Promise<StockSentiment | null> {
    await this.ensureUserSeeded(userId);
    const raw = await this.redis.hget<string | StockSentiment>(
      KEY_SENTIMENT_HASH(userId),
      ticker.toUpperCase(),
    );
    return parseObject<StockSentiment>(raw);
  }

  async setLastSentiment(userId: string, sentiment: StockSentiment): Promise<void> {
    await this.ensureUserSeeded(userId);
    await this.redis.hset(KEY_SENTIMENT_HASH(userId), {
      [sentiment.ticker.toUpperCase()]: JSON.stringify(sentiment),
    });
  }

  async getAllLastSentiments(userId: string): Promise<Record<string, StockSentiment>> {
    await this.ensureUserSeeded(userId);
    const raw = await this.redis.hgetall<Record<string, string | StockSentiment>>(
      KEY_SENTIMENT_HASH(userId),
    );
    if (!raw) return {};
    const out: Record<string, StockSentiment> = {};
    for (const [ticker, value] of Object.entries(raw)) {
      const parsed = parseObject<StockSentiment>(value);
      if (parsed) out[ticker] = parsed;
    }
    return out;
  }

  async listUserIds(): Promise<string[]> {
    const ids = await this.redis.smembers(KEY_USERS_SET);
    if (!Array.isArray(ids)) return [];
    return ids.filter((id): id is string => typeof id === 'string' && id !== 'system');
  }
}

/**
 * Upstash auto-deserializes JSON for some clients/versions but not others.
 * These helpers accept either shape so we don't blow up if the SDK changes
 * its parsing behavior.
 */
function parseArray<T>(raw: unknown, fallback: T[]): T[] {
  if (raw == null) return [...fallback];
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as T[]) : [...fallback];
    } catch {
      return [...fallback];
    }
  }
  return [...fallback];
}

function parseObject<T>(raw: unknown): T | null {
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

/**
 * Upstash credentials can land in env under several different names depending
 * on how the database was provisioned:
 *
 *   - Manual setup or `vercel env add`:
 *       UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
 *
 *   - Vercel Marketplace → Upstash integration with default prefix `KV`:
 *       KV_REST_API_URL / KV_REST_API_TOKEN
 *
 *   - Same integration with a custom prefix (e.g. UPSTASH_REDIS_REST):
 *       <PREFIX>_KV_REST_API_URL / <PREFIX>_KV_REST_API_TOKEN
 *
 * We probe all of them in priority order so the same code works regardless
 * of how the user set up their database.
 */
export function getUpstashConfig(): { url: string; token: string } | null {
  const env = process.env;
  const candidates: Array<[string | undefined, string | undefined]> = [
    [env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN],
    [env.KV_REST_API_URL, env.KV_REST_API_TOKEN],
    [
      env.UPSTASH_REDIS_REST_KV_REST_API_URL,
      env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN,
    ],
  ];
  for (const [url, token] of candidates) {
    if (url && token) return { url, token };
  }
  return null;
}

export function createUpstashStore(): UpstashStore {
  const config = getUpstashConfig();
  if (!config) {
    throw new Error(
      'No Upstash credentials found in env. Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN, ' +
        'or KV_REST_API_URL + KV_REST_API_TOKEN, or use the Vercel Marketplace integration.',
    );
  }
  const redis = new Redis({ url: config.url, token: config.token });
  return new UpstashStore(redis);
}
