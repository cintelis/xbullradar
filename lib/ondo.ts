// Ondo Finance tokenized asset catalog.
//
// Fetches the live list of available assets from the Ondo GM API
// (GET /v1/assets/all/prices/latest) and caches it in Upstash for 6h.
// Falls back to a static set if the API key isn't set or the call fails,
// so the bot and UI never lose Ondo awareness entirely.
//
// URL patterns:
//   Direct asset page: https://app.ondo.finance/assets/{ticker}on
//   Search page:       https://app.ondo.finance/?search={ticker}on
//   (lowercase ticker + "on" suffix)
//
// API docs: https://ondo-finance.readme.io/reference/overview

import { Redis } from '@upstash/redis';
import { getUpstashConfig } from './store-upstash';

const ONDO_API_BASE = 'https://api.gm.ondo.finance';
const CATALOG_CACHE_KEY = 'xbr:ondo:catalog:v1';
const CATALOG_CACHE_TTL_SECONDS = 6 * 60 * 60; // 6 hours
const PRICES_CACHE_KEY = 'xbr:ondo:prices:v1';
const PRICES_CACHE_TTL_SECONDS = 60;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OndoAssetPrice {
  /** On-chain token symbol, e.g. "MSFTon" */
  ondoSymbol: string;
  /** Underlying stock ticker, e.g. "MSFT" */
  ticker: string;
  /** On-chain token price in USD (string with up to 18 decimals) */
  tokenPrice: string;
  /** Underlying stock price in USD */
  stockPrice: string;
  /** Unix ms timestamp of the price */
  timestamp: number;
}

export interface OndoAssetsCache {
  assets: OndoAssetPrice[];
  /** Set of uppercase stock tickers for O(1) lookup */
  tickers: string[];
  fetchedAt: string;
}

// ─── Static fallback ────────────────────────────────────────────────────────
// Used when ONDO_API_KEY is not set or the API call fails. Scraped from
// app.ondo.finance on 2026-04-09 (263 tickers). Stale but better than
// nothing — the bot can still mention Ondo for these tickers.

const STATIC_FALLBACK_TICKERS: ReadonlySet<string> = new Set([
  'AAL', 'AAPL', 'ABBV', 'ABNB', 'ABT', 'ACHR', 'ACN', 'ADBE', 'ADI', 'AGG',
  'ALB', 'AMAT', 'AMC', 'AMD', 'AMGN', 'AMZN', 'ANET', 'APLD', 'APO', 'APP',
  'ARM', 'ASML', 'ASTS', 'AVGO', 'AXP', 'BA', 'BABA', 'BAC', 'BBAI', 'BIDU',
  'BILI', 'BINC', 'BLK', 'BLSH', 'BMNR', 'BNO', 'BTG', 'BTGO', 'BZ', 'C',
  'CAPR', 'CAT', 'CEG', 'CIBR', 'CIFR', 'CLOA', 'CLOI', 'CMG', 'COF', 'COHR',
  'COIN', 'COP', 'COPX', 'COST', 'CPNG', 'CRCL', 'CRM', 'CRWD', 'CRWV', 'CSCO',
  'CVNA', 'CVX', 'DASH', 'DBC', 'DE', 'DGRW', 'DIS', 'DNN', 'ECH', 'EEM',
  'EFA', 'ENLV', 'ENPH', 'EQIX', 'ETHA', 'ETN', 'EWJ', 'EWY', 'EWZ', 'EXOD',
  'F', 'FCX', 'FFOG', 'FGDL', 'FIG', 'FIGR', 'FLHY', 'FLQL', 'FSOL', 'FTGC',
  'FUTU', 'FXI', 'GE', 'GEMI', 'GEV', 'GLD', 'GLTR', 'GLXY', 'GME', 'GOOGL',
  'GRAB', 'GRND', 'GS', 'HD', 'HIMS', 'HOOD', 'HYG', 'HYS', 'IAU', 'IBIT',
  'IBM', 'IEF', 'IEFA', 'IEMG', 'IJH', 'INCE', 'INDA', 'INTC', 'INTU', 'IONQ',
  'IREN', 'ISRG', 'ITA', 'ITOT', 'IVV', 'IWF', 'IWM', 'IWN', 'JAAA', 'JD',
  'JNJ', 'JPM', 'KLAC', 'KO', 'KWEB', 'LI', 'LIN', 'LLY', 'LMT', 'LOW',
  'LRCX', 'LUNR', 'MA', 'MARA', 'MCD', 'MELI', 'META', 'MP', 'MRK', 'MRNA',
  'MRVL', 'MSFT', 'MSTR', 'MTZ', 'MU', 'NBIS', 'NEE', 'NEM', 'NFLX', 'NIKL',
  'NIO', 'NKE', 'NOC', 'NOW', 'NTES', 'NVDA', 'NVO', 'OIH', 'OKLO', 'ON',
  'ONDS', 'OPEN', 'OPRA', 'ORCL', 'OSCR', 'OXY', 'PALL', 'PANW', 'PAVE', 'PBR',
  'PCG', 'PDBC', 'PDD', 'PEP', 'PFE', 'PG', 'PINS', 'PLTR', 'PLUG', 'PPLT',
  'PSQ', 'PYPL', 'QBTS', 'QCOM', 'QQQ', 'QUBT', 'RDDT', 'RDW', 'REGN', 'REMX',
  'RGTI', 'RIOT', 'RIVN', 'RKLB', 'RTX', 'SBET', 'SBUX', 'SCCO', 'SCHW', 'SEDG',
  'SGOV', 'SHOP', 'SHY', 'SLV', 'SMCI', 'SNAP', 'SNDK', 'SNOW', 'SO', 'SOFI',
  'SOUN', 'SOXX', 'SPGI', 'SPOT', 'SPY', 'SQQQ', 'STX', 'T', 'TCOM', 'TIP',
  'TLN', 'TLT', 'TM', 'TMO', 'TMUS', 'TQQQ', 'TSLA', 'TSM', 'TXN', 'UBER',
  'UEC', 'UNG', 'UNH', 'UNP', 'URA', 'USFR', 'USO', 'V', 'VFS', 'VNQ',
  'VRT', 'VRTX', 'VST', 'VTI', 'VTV', 'VZ', 'WDC', 'WFC', 'WM', 'WMT',
  'WULF', 'XOM', 'XYZ',
]);

// ─── Redis cache ────────────────────────────────────────────────────────────

let _redis: Redis | null = null;
function getRedis(): Redis | null {
  if (_redis) return _redis;
  const config = getUpstashConfig();
  if (!config) return null;
  _redis = new Redis({ url: config.url, token: config.token });
  return _redis;
}

function parseCached(raw: unknown): OndoAssetsCache | null {
  if (raw == null) return null;
  if (typeof raw === 'object' && raw !== null && 'assets' in raw) {
    return raw as OndoAssetsCache;
  }
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as OndoAssetsCache;
    } catch {
      return null;
    }
  }
  return null;
}

// ─── API client ─────────────────────────────────────────────────────────────

interface OndoApiPriceEntry {
  primaryMarket: { symbol: string; price: string };
  underlyingMarket: { ticker: string; price: string };
  timestamp: number;
}

function getApiKey(): string | null {
  return process.env.ONDO_API_KEY ?? null;
}

async function fetchFromApi(): Promise<OndoAssetPrice[]> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('ONDO_API_KEY not set');
  }

  const res = await fetch(`${ONDO_API_BASE}/v1/assets/all/prices/latest`, {
    headers: { 'x-api-key': apiKey },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ondo API ${res.status}: ${text || res.statusText}`);
  }

  const data = (await res.json()) as OndoApiPriceEntry[];
  if (!Array.isArray(data)) {
    throw new Error('Ondo API returned non-array');
  }

  return data
    .filter(
      (d) =>
        d.primaryMarket?.symbol &&
        d.underlyingMarket?.ticker &&
        d.primaryMarket?.price,
    )
    .map((d) => ({
      ondoSymbol: d.primaryMarket.symbol,
      ticker: d.underlyingMarket.ticker.toUpperCase(),
      tokenPrice: d.primaryMarket.price,
      stockPrice: d.underlyingMarket.price,
      timestamp: d.timestamp,
    }));
}

// ─── In-flight dedup ────────────────────────────────────────────────────────

let inFlight: Promise<OndoAssetsCache> | null = null;

/**
 * Get the full Ondo assets catalog. Served from Upstash cache when
 * available (6h TTL). On cache miss, fetches from the Ondo GM API.
 * Falls back to the static ticker set if the API key isn't configured
 * or the call fails.
 */
export async function getOndoAssets(): Promise<OndoAssetsCache> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      // Try cache first.
      const redis = getRedis();
      if (redis) {
        const cached = await redis.get<OndoAssetsCache | string>(CATALOG_CACHE_KEY);
        const parsed = parseCached(cached);
        if (parsed) return parsed;
      }

      // Cache miss — fetch from API.
      const assets = await fetchFromApi();
      const tickers = assets.map((a) => a.ticker);
      const fresh: OndoAssetsCache = {
        assets,
        tickers,
        fetchedAt: new Date().toISOString(),
      };

      if (redis) {
        await redis.set(CATALOG_CACHE_KEY, JSON.stringify(fresh), {
          ex: CATALOG_CACHE_TTL_SECONDS,
        });
      }

      console.log(
        `[ondo] fetched ${assets.length} assets from API, cached for ${CATALOG_CACHE_TTL_SECONDS / 3600}h`,
      );
      return fresh;
    } catch (err) {
      console.warn('[ondo] API fetch failed, using static fallback', err);
      return buildStaticFallback();
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

function buildStaticFallback(): OndoAssetsCache {
  const tickers = [...STATIC_FALLBACK_TICKERS];
  return {
    assets: tickers.map((t) => ({
      ondoSymbol: `${t}on`,
      ticker: t,
      tokenPrice: '0',
      stockPrice: '0',
      timestamp: 0,
    })),
    tickers,
    fetchedAt: 'static-fallback',
  };
}

// ─── Convenience helpers ────────────────────────────────────────────────────
// These are synchronous and use the static fallback for callers that
// can't await (e.g. copilot route post-processing). For the freshest
// data, call getOndoAssets() directly and check the returned cache.

// In-memory ticker set, populated on first load. Updated by refreshOndoCache().
let _tickerSet: Set<string> = new Set(STATIC_FALLBACK_TICKERS);
let _initialized = false;

/**
 * Warm the in-memory ticker set from the API/cache. Call this at app
 * startup or from the daily cron. After this, isOnOndo() and getOndoUrl()
 * use the live data instead of the static fallback.
 */
export async function refreshOndoCache(): Promise<number> {
  const cache = await getOndoAssets();
  _tickerSet = new Set(cache.tickers);
  _initialized = true;
  return _tickerSet.size;
}

/** Check whether a stock ticker is available as a tokenized asset on Ondo. */
export function isOnOndo(ticker: string): boolean {
  return _tickerSet.has(ticker.toUpperCase());
}

/**
 * Get the direct Ondo asset page URL for a ticker. Returns null if the
 * ticker isn't on Ondo. URL uses the lowercase ticker + "on" convention:
 * MSFT → https://app.ondo.finance/assets/msfton
 */
export function getOndoUrl(ticker: string): string | null {
  const upper = ticker.toUpperCase();
  if (!_tickerSet.has(upper)) return null;
  return `https://app.ondo.finance/assets/${upper.toLowerCase()}on`;
}

/** Whether the in-memory set has been refreshed from the API (vs static fallback). */
export function isOndoCacheLive(): boolean {
  return _initialized;
}

/** Total number of tickers currently known. */
export function getOndoTickerCount(): number {
  return _tickerSet.size;
}

// ─── Live prices (60s cache) ────────────────────────────────────────────────

interface OndoPricesCache {
  byTicker: Record<string, OndoAssetPrice>;
  fetchedAt: string;
}

export interface OndoAssetView {
  ondoSymbol: string;
  ticker: string;
  tokenPrice: number;
  stockPrice: number;
  premiumPct: number;
  timestamp: number;
}

function parsePricesCached(raw: unknown): OndoPricesCache | null {
  if (raw == null) return null;
  if (typeof raw === 'object' && raw !== null && 'byTicker' in raw) {
    return raw as OndoPricesCache;
  }
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as OndoPricesCache;
    } catch {
      return null;
    }
  }
  return null;
}

let pricesInFlight: Promise<OndoPricesCache> | null = null;

async function getOndoPrices(): Promise<OndoPricesCache> {
  if (pricesInFlight) return pricesInFlight;

  pricesInFlight = (async () => {
    try {
      const redis = getRedis();
      if (redis) {
        const cached = await redis.get<OndoPricesCache | string>(PRICES_CACHE_KEY);
        const parsed = parsePricesCached(cached);
        if (parsed) return parsed;
      }

      const assets = await fetchFromApi();
      const byTicker: Record<string, OndoAssetPrice> = {};
      for (const a of assets) byTicker[a.ticker] = a;

      const fresh: OndoPricesCache = {
        byTicker,
        fetchedAt: new Date().toISOString(),
      };

      if (redis) {
        await redis.set(PRICES_CACHE_KEY, JSON.stringify(fresh), {
          ex: PRICES_CACHE_TTL_SECONDS,
        });
      }

      return fresh;
    } finally {
      pricesInFlight = null;
    }
  })();

  return pricesInFlight;
}

/**
 * Get live Ondo token + stock price for a ticker, plus the spread.
 * Returns null if the ticker isn't on Ondo, if we only have static
 * fallback data (no real prices), or if the live prices fetch failed.
 */
export async function getOndoAsset(ticker: string): Promise<OndoAssetView | null> {
  const upper = ticker.toUpperCase();

  let prices: OndoPricesCache;
  try {
    prices = await getOndoPrices();
  } catch {
    return null;
  }

  const entry = prices.byTicker[upper];
  if (!entry) return null;

  const tokenPrice = Number(entry.tokenPrice);
  const stockPrice = Number(entry.stockPrice);
  if (
    !Number.isFinite(tokenPrice) ||
    !Number.isFinite(stockPrice) ||
    tokenPrice <= 0 ||
    stockPrice <= 0
  ) {
    return null;
  }

  const premiumPct = ((tokenPrice - stockPrice) / stockPrice) * 100;

  return {
    ondoSymbol: entry.ondoSymbol,
    ticker: entry.ticker,
    tokenPrice,
    stockPrice,
    premiumPct,
    timestamp: entry.timestamp,
  };
}
