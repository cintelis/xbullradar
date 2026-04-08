// End-of-day price data from Polygon (now Massive). Free Stocks Basic tier.
//
// Strategy: use the grouped daily endpoint, which returns OHLC data for ALL
// US stocks for one trading day in a single API call. We make 2 calls per
// refresh (most recent trading day + the day before, to compute day change
// %), cache the result in Upstash for 12 hours, and serve all user portfolio
// reads from the cache.
//
// Total API usage: ~2 calls per ~12 hours = 4 calls/day. Well under the
// Stocks Basic free-tier limit of 5 calls/minute.
//
// Endpoint docs: https://massive.com/docs/rest/stocks/aggregates/daily-market-summary

import { Redis } from '@upstash/redis';
import { getUpstashConfig } from './store-upstash';

const POLYGON_API_BASE = 'https://api.polygon.io';
const CACHE_KEY = 'xbr:prices:daily';
const CACHE_TTL_SECONDS = 12 * 60 * 60; // 12 hours
const MAX_LOOKBACK_DAYS = 7; // weekend + a long-weekend safety margin

export interface PriceSnapshot {
  ticker: string;
  /** Most recent trading day close. */
  close: number;
  /** Trading day before `close` — null if the ticker only had data on one day (e.g., new IPO). */
  prevClose: number | null;
  /** ((close - prevClose) / prevClose) * 100. Null if prevClose is null. */
  dayChangePercent: number | null;
}

export interface CachedPrices {
  /** ISO date (YYYY-MM-DD) of the `close` price — the most recent trading day we found data for. */
  asOfDate: string;
  /** Map of ticker → snapshot. */
  prices: Record<string, PriceSnapshot>;
  /** ISO timestamp when this cache entry was populated. */
  fetchedAt: string;
}

interface PolygonGroupedDailyResult {
  T: string;     // ticker
  o: number;     // open
  h: number;     // high
  l: number;     // low
  c: number;     // close
  v: number;     // volume
  vw?: number;   // volume-weighted average
  n?: number;    // transaction count
}

interface PolygonGroupedDailyResponse {
  results?: PolygonGroupedDailyResult[];
  resultsCount?: number;
  status?: string;
}

// ─── Polygon client ─────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.POLYGON_API_KEY;
  if (!key) {
    throw new Error('POLYGON_API_KEY is not set in env');
  }
  return key;
}

/**
 * Fetch the grouped daily aggregates for a single date. Returns null if the
 * day has no data (weekend, holiday, or not yet posted). Throws on real API
 * errors so callers can decide whether to retry or surface.
 */
async function fetchGroupedDaily(
  date: string,
): Promise<Map<string, PolygonGroupedDailyResult> | null> {
  const url = `${POLYGON_API_BASE}/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true&apiKey=${encodeURIComponent(getApiKey())}`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    // Cache hint to Vercel: we already cache at the app layer in Upstash, so
    // serverless function runtime cache is unnecessary.
    cache: 'no-store',
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Polygon ${res.status} for ${date}: ${text || res.statusText}`);
  }

  const data = (await res.json()) as PolygonGroupedDailyResponse;
  if (!data.results || data.results.length === 0) {
    return null;
  }

  const map = new Map<string, PolygonGroupedDailyResult>();
  for (const row of data.results) {
    map.set(row.T, row);
  }
  return map;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Find the two most recent trading days that have data, walking backwards
 * from today. Returns the most recent two — needed to compute day change %.
 */
async function fetchTwoMostRecentTradingDays(): Promise<{
  recent: { date: string; data: Map<string, PolygonGroupedDailyResult> };
  previous: { date: string; data: Map<string, PolygonGroupedDailyResult> } | null;
}> {
  let recent: { date: string; data: Map<string, PolygonGroupedDailyResult> } | null = null;
  let previous: { date: string; data: Map<string, PolygonGroupedDailyResult> } | null = null;

  for (let i = 1; i <= MAX_LOOKBACK_DAYS; i += 1) {
    const date = isoDate(new Date(Date.now() - i * 24 * 60 * 60 * 1000));
    const data = await fetchGroupedDaily(date);
    if (!data) continue;

    if (!recent) {
      recent = { date, data };
      continue;
    }
    previous = { date, data };
    break;
  }

  if (!recent) {
    throw new Error(
      `No Polygon trading day data found in the last ${MAX_LOOKBACK_DAYS} days`,
    );
  }
  return { recent, previous };
}

/**
 * Build the per-ticker snapshot map from two consecutive trading days.
 * Tickers present in `recent` but not `previous` get prevClose=null.
 */
function buildSnapshots(
  recent: Map<string, PolygonGroupedDailyResult>,
  previous: Map<string, PolygonGroupedDailyResult> | null,
): Record<string, PriceSnapshot> {
  const out: Record<string, PriceSnapshot> = {};
  for (const [ticker, row] of recent.entries()) {
    const prevRow = previous?.get(ticker);
    const prevClose = prevRow?.c ?? null;
    const dayChangePercent =
      prevClose != null && prevClose !== 0
        ? ((row.c - prevClose) / prevClose) * 100
        : null;
    out[ticker] = {
      ticker,
      close: row.c,
      prevClose,
      dayChangePercent,
    };
  }
  return out;
}

// ─── Upstash cache layer ────────────────────────────────────────────────────

let _redis: Redis | null = null;
function getRedis(): Redis | null {
  if (_redis) return _redis;
  const config = getUpstashConfig();
  if (!config) return null;
  _redis = new Redis({ url: config.url, token: config.token });
  return _redis;
}

/**
 * Cached prices in memory inside a single function invocation. Avoids
 * hitting Upstash twice within the same request when both /api/portfolio
 * and the daily scan happen to read prices in parallel.
 */
let inFlight: Promise<CachedPrices> | null = null;

/**
 * The main public API. Returns a map of ticker → snapshot. Always served
 * from cache when possible; refreshes from Polygon when the cache is empty
 * or expired (12h TTL).
 *
 * Throws if no cached data exists AND Polygon is unreachable. Callers
 * should handle this gracefully (return empty enrichment, log the error).
 */
export async function getDailyPrices(): Promise<CachedPrices> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const redis = getRedis();

    // Cache lookup
    if (redis) {
      const cached = await redis.get<CachedPrices | string>(CACHE_KEY);
      const parsed = parseCached(cached);
      if (parsed) return parsed;
    }

    // Cache miss — fetch fresh
    const { recent, previous } = await fetchTwoMostRecentTradingDays();
    const fresh: CachedPrices = {
      asOfDate: recent.date,
      prices: buildSnapshots(recent.data, previous?.data ?? null),
      fetchedAt: new Date().toISOString(),
    };

    if (redis) {
      await redis.set(CACHE_KEY, JSON.stringify(fresh), { ex: CACHE_TTL_SECONDS });
    }
    return fresh;
  })();

  // Clear in-flight memoization shortly after settle so subsequent invocations
  // (in the same warm Lambda) don't hold a stale reference forever.
  inFlight.finally(() => {
    setTimeout(() => {
      inFlight = null;
    }, 1000);
  });

  return inFlight;
}

function parseCached(raw: unknown): CachedPrices | null {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw as CachedPrices;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as CachedPrices;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Look up a single ticker's snapshot. Returns null if the ticker isn't in
 * the cache (typically a typo or a non-US-listed symbol the user entered).
 * Convenience wrapper around getDailyPrices().
 */
export async function getPriceForTicker(ticker: string): Promise<PriceSnapshot | null> {
  const all = await getDailyPrices();
  return all.prices[ticker.toUpperCase()] ?? null;
}

/**
 * Force-refresh the cache. Used by the daily cron to keep prices fresh.
 * Returns the new CachedPrices.
 */
export async function refreshDailyPrices(): Promise<CachedPrices> {
  const redis = getRedis();
  if (redis) {
    await redis.del(CACHE_KEY);
  }
  inFlight = null;
  return getDailyPrices();
}
