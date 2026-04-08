// Markets data for the dashboard ticker tape and market hours clock.
//
// Two slices, one cache:
//   1. Commodities — selected futures (gold, oil, S&P futures, etc.) with
//      end-of-day-ish prices for the scrolling ticker tape.
//   2. Exchange hours — metadata for ~30 global exchanges (opening/closing
//      hours, timezone). isMarketOpen is computed CLIENT-SIDE from current
//      time + timezone so the display is always accurate without polling.
//
// API source: FMP /stable endpoints. Free tier on Stocks Basic.
//   GET /stable/quote?symbol={symbol}        → single commodity quote
//   GET /stable/all-exchange-market-hours    → all exchanges metadata
//
// Free-tier note: /stable/batch-quote and comma-separated /stable/quote are
// both gated to paid tiers. We must call /stable/quote sequentially per
// commodity. With the cache below this stays well under the 250/day limit.
//
// Cache budget:
//   - 10 commodity quote calls per refresh
//   - 1 exchange hours call per refresh
//   - Cache TTL: 6 hours
//   - Daily cron warms once per day proactively
//   - = 11-44 calls/day total depending on lazy fills

import { Redis } from '@upstash/redis';
import { getUpstashConfig } from './store-upstash';

const FMP_API_BASE = 'https://financialmodelingprep.com/stable';
// Bumped to v2 when the symbol list expanded to include major global
// indexes alongside commodities. Bumping the key invalidates the old
// cache instantly instead of waiting for the 6h TTL to expire.
const CACHE_KEY = 'xbr:markets:v2';
const CACHE_TTL_SECONDS = 6 * 60 * 60; // 6 hours

/**
 * Instruments we ticker-tape across the top of the dashboard. Mix of
 * major global stock indexes (S&P 500, Nasdaq, Dow, FTSE, Nikkei, Hang
 * Seng), key commodities (metals, energy), and Treasury futures.
 *
 * Order: most-watched US indexes first, then global indexes, then
 * commodities, then bonds. Reads as a "global market summary" left-to-right.
 *
 * Two notable indexes excluded due to FMP free-tier coverage gaps:
 *   - ^GDAXI (DAX 40 / Germany) — premium endpoint
 *   - ^AXJO (ASX 200 / Australia) — premium endpoint
 * Re-add when/if upgrading to FMP Stocks Starter ($14/mo).
 *
 * NOTE: ^N225 returns "Nikkei 225" which is the index, not the JPX
 * exchange. The exchange hours pill (right side of MarketStrip) covers
 * the "is Tokyo trading?" question separately via JPX.
 */
const INSTRUMENT_SYMBOLS: Array<{ symbol: string; label: string }> = [
  // US indexes — most-watched
  { symbol: '^GSPC', label: 'S&P 500' },
  { symbol: '^IXIC', label: 'NASDAQ' },
  { symbol: '^DJI', label: 'DOW' },
  // Global indexes
  { symbol: '^FTSE', label: 'FTSE 100' },
  { symbol: '^N225', label: 'NIKKEI' },
  { symbol: '^HSI', label: 'HANG SENG' },
  // Metals
  { symbol: 'GCUSD', label: 'GOLD' },
  { symbol: 'SIUSD', label: 'SILVER' },
  { symbol: 'HGUSD', label: 'COPPER' },
  // Energy
  { symbol: 'CLUSD', label: 'WTI OIL' },
  { symbol: 'BZUSD', label: 'BRENT' },
  { symbol: 'NGUSD', label: 'NAT GAS' },
  // Bonds
  { symbol: 'ZNUSD', label: '10Y NOTE' },
  { symbol: 'ZBUSD', label: '30Y BOND' },
];

export interface CommodityQuote {
  symbol: string;
  label: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  previousClose: number | null;
}

export interface ExchangeHours {
  exchange: string;     // e.g. "NYSE"
  name: string;         // e.g. "New York Stock Exchange"
  /** Local opening time string from FMP, e.g. "09:30 AM -04:00" */
  openingHour: string;
  /** Local closing time string from FMP, e.g. "04:00 PM -04:00" */
  closingHour: string;
  /** IANA timezone, e.g. "America/New_York" */
  timezone: string;
}

export interface MarketsCache {
  commodities: CommodityQuote[];
  exchanges: ExchangeHours[];
  /** ISO timestamp of when this cache was populated. */
  fetchedAt: string;
}

// ─── FMP client ─────────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.FMP_API_KEY;
  if (!key) throw new Error('FMP_API_KEY is not set in env');
  return key;
}

interface FMPQuoteResult {
  symbol?: string;
  name?: string;
  price?: number;
  change?: number;
  changePercentage?: number;
  previousClose?: number;
}

function isFMPErrorBody(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  return 'Error Message' in body || 'error' in body;
}

/**
 * Fetch a single commodity quote. Returns null if FMP doesn't have data
 * for the symbol (small-cap-style coverage gap, error response, etc.).
 */
async function fetchCommodityQuote(
  symbol: string,
  label: string,
): Promise<CommodityQuote | null> {
  const apiKey = encodeURIComponent(getApiKey());
  const url = `${FMP_API_BASE}/quote?symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`;

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });

  if (!res.ok) return null;

  const json = (await res.json()) as unknown;
  if (isFMPErrorBody(json)) return null;
  if (!Array.isArray(json) || json.length === 0) return null;

  const q = json[0] as FMPQuoteResult;
  if (typeof q.price !== 'number') return null;

  return {
    symbol,
    label,
    name: q.name ?? symbol,
    price: q.price,
    change: typeof q.change === 'number' ? q.change : 0,
    changePercent: typeof q.changePercentage === 'number' ? q.changePercentage : 0,
    previousClose: typeof q.previousClose === 'number' ? q.previousClose : null,
  };
}

/**
 * Fetch all instrument quotes sequentially. ~200ms per quote × 14 = ~3s
 * total cold-cache cost. Hot cache is instant. Failures don't break the
 * whole batch — missing symbols just get omitted from the result so a
 * single broken ticker doesn't take down the whole strip.
 */
async function fetchAllCommodities(): Promise<CommodityQuote[]> {
  const out: CommodityQuote[] = [];
  for (const { symbol, label } of INSTRUMENT_SYMBOLS) {
    try {
      const quote = await fetchCommodityQuote(symbol, label);
      if (quote) out.push(quote);
    } catch (err) {
      console.warn(`[markets] quote failed for ${symbol}:`, err);
    }
  }
  return out;
}

interface FMPExchangeHoursResult {
  exchange?: string;
  name?: string;
  openingHour?: string;
  closingHour?: string;
  timezone?: string;
  isMarketOpen?: boolean;
}

/**
 * Fetch all exchange hours metadata. Single call, returns ~30 exchanges.
 * We strip the isMarketOpen flag because it's stale by display time —
 * client computes it on demand from openingHour/closingHour/timezone.
 */
async function fetchExchangeHours(): Promise<ExchangeHours[]> {
  const apiKey = encodeURIComponent(getApiKey());
  const url = `${FMP_API_BASE}/all-exchange-market-hours?apikey=${apiKey}`;

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });

  if (!res.ok) return [];

  const json = (await res.json()) as unknown;
  if (isFMPErrorBody(json) || !Array.isArray(json)) return [];

  return (json as FMPExchangeHoursResult[])
    .filter(
      (r): r is Required<Omit<FMPExchangeHoursResult, 'isMarketOpen'>> & { isMarketOpen?: boolean } =>
        typeof r.exchange === 'string' &&
        typeof r.name === 'string' &&
        typeof r.openingHour === 'string' &&
        typeof r.closingHour === 'string' &&
        typeof r.timezone === 'string',
    )
    .map((r) => ({
      exchange: r.exchange,
      name: r.name,
      openingHour: r.openingHour,
      closingHour: r.closingHour,
      timezone: r.timezone,
    }));
}

// ─── Cache layer ────────────────────────────────────────────────────────────

let _redis: Redis | null = null;
function getRedis(): Redis | null {
  if (_redis) return _redis;
  const config = getUpstashConfig();
  if (!config) return null;
  _redis = new Redis({ url: config.url, token: config.token });
  return _redis;
}

function parseCached(raw: unknown): MarketsCache | null {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw as MarketsCache;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as MarketsCache;
    } catch {
      return null;
    }
  }
  return null;
}

let inFlight: Promise<MarketsCache> | null = null;

/**
 * Get the markets data for the dashboard ticker tape + market hours.
 * Always served from Upstash cache when available; refreshes from FMP on
 * cache miss with a 6h TTL. Sharing one cache across all users keeps
 * total API usage at ~10-20 calls/day regardless of user count.
 */
export async function getMarkets(): Promise<MarketsCache> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const redis = getRedis();
    if (redis) {
      const cached = await redis.get<MarketsCache | string>(CACHE_KEY);
      const parsed = parseCached(cached);
      if (parsed) return parsed;
    }

    // Cache miss — fetch fresh
    const [commodities, exchanges] = await Promise.all([
      fetchAllCommodities(),
      fetchExchangeHours(),
    ]);
    const fresh: MarketsCache = {
      commodities,
      exchanges,
      fetchedAt: new Date().toISOString(),
    };

    if (redis) {
      await redis.set(CACHE_KEY, JSON.stringify(fresh), { ex: CACHE_TTL_SECONDS });
    }
    return fresh;
  })();

  // Clear in-flight memoization shortly after settle so subsequent
  // invocations in the same warm Lambda don't hold a stale promise.
  inFlight.finally(() => {
    setTimeout(() => {
      inFlight = null;
    }, 1000);
  });

  return inFlight;
}

/**
 * Force-refresh the markets cache. Called by the daily cron so the morning
 * users see fresh data without paying the cold-cache fetch cost themselves.
 */
export async function refreshMarkets(): Promise<MarketsCache> {
  const redis = getRedis();
  if (redis) await redis.del(CACHE_KEY);
  inFlight = null;
  return getMarkets();
}
