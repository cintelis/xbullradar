// Upstash Redis-backed Store implementation for xBullRadar.
//
// Activated when UPSTASH_REDIS_REST_URL is set in env. Used in production
// (Vercel) where there is no writable filesystem. Works on any serverless
// host because it talks to Upstash over HTTPS, not TCP — no connection
// pooling required.
//
// Data layout:
//   xbr:watchlist            string  (JSON array of tickers)
//   xbr:holdings             string  (JSON array of holdings)
//   xbr:sentiment:last       hash    (field=ticker, value=JSON StockSentiment)
//
// Hash for last-sentiment lets the daily scan write 7 ticker scores as 7
// HSET field updates instead of rewriting one big blob.

import { Redis } from '@upstash/redis';
import type { PortfolioHolding, StockSentiment } from '@/types';
import type { Store } from './store-types';
import { DEFAULT_DATA } from './store-types';

const KEY_WATCHLIST = 'xbr:watchlist';
const KEY_HOLDINGS = 'xbr:holdings';
const KEY_SENTIMENT_HASH = 'xbr:sentiment:last';

export class UpstashStore implements Store {
  private readonly redis: Redis;
  private seedPromise: Promise<void> | null = null;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  /**
   * One-time seed of defaults if the watchlist key is missing. Idempotent
   * and concurrency-safe via the cached promise — multiple parallel reads
   * during a cold start all await the same seed operation.
   */
  private async ensureSeeded(): Promise<void> {
    if (this.seedPromise) return this.seedPromise;
    this.seedPromise = (async () => {
      const exists = await this.redis.exists(KEY_WATCHLIST);
      if (exists) return;
      await Promise.all([
        this.redis.set(KEY_WATCHLIST, JSON.stringify(DEFAULT_DATA.watchlist)),
        this.redis.set(KEY_HOLDINGS, JSON.stringify(DEFAULT_DATA.holdings)),
      ]);
    })();
    return this.seedPromise;
  }

  async getWatchlist(): Promise<string[]> {
    await this.ensureSeeded();
    const raw = await this.redis.get<string | string[]>(KEY_WATCHLIST);
    return parseArray<string>(raw, DEFAULT_DATA.watchlist);
  }

  async setWatchlist(tickers: string[]): Promise<void> {
    const upper = tickers.map((t) => t.toUpperCase());
    await this.redis.set(KEY_WATCHLIST, JSON.stringify(upper));
  }

  async getHoldings(): Promise<PortfolioHolding[]> {
    await this.ensureSeeded();
    const raw = await this.redis.get<string | PortfolioHolding[]>(KEY_HOLDINGS);
    return parseArray<PortfolioHolding>(raw, DEFAULT_DATA.holdings);
  }

  async setHoldings(holdings: PortfolioHolding[]): Promise<void> {
    await this.redis.set(KEY_HOLDINGS, JSON.stringify(holdings));
  }

  async getLastSentiment(ticker: string): Promise<StockSentiment | null> {
    const raw = await this.redis.hget<string | StockSentiment>(
      KEY_SENTIMENT_HASH,
      ticker.toUpperCase(),
    );
    return parseObject<StockSentiment>(raw);
  }

  async setLastSentiment(sentiment: StockSentiment): Promise<void> {
    await this.redis.hset(KEY_SENTIMENT_HASH, {
      [sentiment.ticker.toUpperCase()]: JSON.stringify(sentiment),
    });
  }

  async getAllLastSentiments(): Promise<Record<string, StockSentiment>> {
    const raw = await this.redis.hgetall<Record<string, string | StockSentiment>>(
      KEY_SENTIMENT_HASH,
    );
    if (!raw) return {};
    const out: Record<string, StockSentiment> = {};
    for (const [ticker, value] of Object.entries(raw)) {
      const parsed = parseObject<StockSentiment>(value);
      if (parsed) out[ticker] = parsed;
    }
    return out;
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
