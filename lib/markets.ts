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
// Bumped to v5 when the treasury yield set expanded from 3 points
// (2Y/10Y/30Y) to 6 points (3M/2Y/5Y/10Y/20Y/30Y), giving a more
// complete yield-curve picture across the tape. Bumping the key
// invalidates the old cache instantly so the new instruments take
// effect on next deploy without waiting for the 6h TTL to expire.
const CACHE_KEY = 'xbr:markets:v5';
const CACHE_TTL_SECONDS = 6 * 60 * 60; // 6 hours

/**
 * Instruments we ticker-tape across the top of the dashboard. Mix of:
 *   - Major global stock indexes (US: S&P / Nasdaq / Dow, Global: FTSE / Nikkei / Hang Seng)
 *   - Crypto (Bitcoin, Ethereum)
 *   - Forex pairs (EUR / GBP / JPY against USD)
 *   - Key commodities (metals + energy)
 *   - Treasury futures (10Y / 30Y notes/bonds)
 *
 * Order: indexes → crypto → forex → metals → energy → bonds. Reads
 * as a "global market summary" left-to-right with the most-watched
 * benchmarks (S&P/Nasdaq/Dow) leading.
 *
 * NOT in the list — premium-gated even on FMP Stocks Starter ($14/mo):
 *
 * Indexes:
 *   - ^GDAXI (DAX 40 / Germany)
 *   - ^AXJO (ASX 200 / Australia)
 *   - DXUSD (US Dollar Index)
 *   - RTYUSD (Russell 2000 micro futures)
 *   - YMUSD (Mini Dow Jones futures)
 *
 * Agricultural futures (verified all blocked on Starter — directly
 * tested 2026-04-09):
 *   - ZSUSX (Soybeans), KEUSX (Wheat), ZCUSX (Corn), SBUSX (Sugar)
 *   - KCUSX (Coffee), CCUSD (Cocoa), CTUSX (Cotton), OJUSX (Orange Juice)
 *
 * Specialty metals (also blocked on Starter):
 *   - PAUSD (Palladium), PLUSD (Platinum)
 *
 * All of the above need FMP Stocks Pro or higher. Add them back if
 * the FMP plan ever upgrades.
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
  // Crypto
  { symbol: 'BTCUSD', label: 'BTC' },
  { symbol: 'ETHUSD', label: 'ETH' },
  // Forex (major pairs against USD)
  { symbol: 'EURUSD', label: 'EUR/USD' },
  { symbol: 'GBPUSD', label: 'GBP/USD' },
  { symbol: 'JPYUSD', label: 'JPY/USD' },
  // Metals
  { symbol: 'GCUSD', label: 'GOLD' },
  { symbol: 'SIUSD', label: 'SILVER' },
  { symbol: 'HGUSD', label: 'COPPER' },
  // Energy
  { symbol: 'CLUSD', label: 'WTI OIL' },
  { symbol: 'BZUSD', label: 'BRENT' },
  { symbol: 'NGUSD', label: 'NAT GAS' },
  // Treasury yields are fetched separately via /stable/treasury-rates
  // (see fetchTreasuryYields below). They get appended to the result
  // of fetchAllCommodities() in fetchAllInstruments(). The bond futures
  // (ZNUSD, ZBUSD) were removed in v4 because the actual yields are
  // more meaningful for casual users than the futures positioning.
];

export interface CommodityQuote {
  symbol: string;
  label: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  previousClose: number | null;
  /**
   * How the price should be rendered in the ticker tape. Default 'usd'
   * renders as "$1,234.56". 'percent' renders as "4.29%" — used for
   * treasury yields where the value IS itself a percentage and a "$"
   * prefix would be misleading.
   */
  unit?: 'usd' | 'percent';
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
 * Fetch all instrument quotes sequentially. ~200ms per quote × N = a few
 * seconds total cold-cache cost. Hot cache is instant. Failures don't
 * break the whole batch — missing symbols just get omitted from the
 * result so a single broken ticker doesn't take down the whole strip.
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

// ─── Treasury yields (separate endpoint, full yield curve in one call) ──────

interface FMPTreasuryRate {
  date: string;
  month1?: number;
  month2?: number;
  month3?: number;
  month6?: number;
  year1?: number;
  year2?: number;
  year3?: number;
  year5?: number;
  year7?: number;
  year10?: number;
  year20?: number;
  year30?: number;
}

/**
 * Treasury yield curve points to surface in the ticker tape. The
 * /stable/treasury-rates endpoint returns the entire curve in one call,
 * so adding more maturities here costs us nothing.
 *
 * Order is short-to-long maturity (3M → 30Y), which is the standard
 * yield curve presentation order — left side of a curve chart is the
 * short end, right side is the long end.
 *
 * Six points selected:
 *   3M  — short-term Fed policy proxy (mirrors Fed Funds rate moves)
 *   2Y  — front-end of curve, sensitive to near-term rate expectations
 *   5Y  — belly of the curve
 *   10Y — benchmark, drives mortgages and corporate borrowing
 *   20Y — between 10Y and 30Y, useful for curve shape
 *   30Y — long bond, drives long-term inflation expectations
 */
const TREASURY_YIELD_POINTS: Array<{
  key: keyof FMPTreasuryRate;
  symbol: string;
  label: string;
  name: string;
}> = [
  { key: 'month3', symbol: 'US3M', label: '3M YIELD', name: 'US 3-Month Treasury Yield' },
  { key: 'year2', symbol: 'US2Y', label: '2Y YIELD', name: 'US 2-Year Treasury Yield' },
  { key: 'year5', symbol: 'US5Y', label: '5Y YIELD', name: 'US 5-Year Treasury Yield' },
  { key: 'year10', symbol: 'US10Y', label: '10Y YIELD', name: 'US 10-Year Treasury Yield' },
  { key: 'year20', symbol: 'US20Y', label: '20Y YIELD', name: 'US 20-Year Treasury Yield' },
  { key: 'year30', symbol: 'US30Y', label: '30Y YIELD', name: 'US 30-Year Treasury Yield' },
];

/**
 * Fetch treasury yields via /stable/treasury-rates and convert into the
 * shared CommodityQuote shape. The endpoint returns multiple historical
 * days, so we use the latest day for the current value and the day
 * before for the previous-close comparison.
 *
 * One API call returns the entire yield curve for the past ~60 days.
 * Trivial cost compared to per-symbol /quote fetches.
 */
async function fetchTreasuryYields(): Promise<CommodityQuote[]> {
  const apiKey = encodeURIComponent(getApiKey());
  const url = `${FMP_API_BASE}/treasury-rates?limit=2&apikey=${apiKey}`;

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });

  if (!res.ok) {
    console.warn(`[markets] treasury-rates returned ${res.status}`);
    return [];
  }

  const json = (await res.json()) as unknown;
  if (!Array.isArray(json) || json.length === 0) return [];

  const rates = json as FMPTreasuryRate[];
  const latest = rates[0];
  const previous = rates.length >= 2 ? rates[1] : null;
  if (!latest) return [];

  const out: CommodityQuote[] = [];
  for (const point of TREASURY_YIELD_POINTS) {
    const current = latest[point.key];
    if (typeof current !== 'number') continue;
    const prev = previous?.[point.key];
    const prevValue = typeof prev === 'number' ? prev : null;
    const change = prevValue != null ? current - prevValue : 0;
    const changePercent = prevValue != null && prevValue !== 0 ? (change / prevValue) * 100 : 0;

    out.push({
      symbol: point.symbol,
      label: point.label,
      name: point.name,
      price: current,
      change,
      changePercent,
      previousClose: prevValue,
      unit: 'percent',
    });
  }

  return out;
}

/**
 * Fetch ALL ticker-tape instruments: /quote-based commodities/indexes/
 * crypto/forex AND /stable/treasury-rates yields. Runs the two fetches
 * in parallel since they hit different endpoints.
 */
async function fetchAllInstruments(): Promise<CommodityQuote[]> {
  const [commodities, yields] = await Promise.all([
    fetchAllCommodities(),
    fetchTreasuryYields().catch((err) => {
      console.warn('[markets] treasury-rates fetch failed:', err);
      return [] as CommodityQuote[];
    }),
  ]);
  return [...commodities, ...yields];
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

    // Cache miss — fetch fresh. fetchAllInstruments combines /quote
    // commodities/indexes/crypto/forex and /stable/treasury-rates yields.
    const [commodities, exchanges] = await Promise.all([
      fetchAllInstruments(),
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
