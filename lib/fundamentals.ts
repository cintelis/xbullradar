// Fundamentals analysis aggregation for xBullRadar.
//
// Fetches financial ratios and metrics from Financial Modeling Prep (FMP)
// free tier and aggregates them into a single BUY / SELL / NEUTRAL signal
// across four buckets: valuation, profitability, growth, financial health.
//
// Same aggregation pattern as lib/technicals.ts: each bucket votes, the
// majority wins. Caching is aggressive (48h TTL) because fundamentals only
// update on quarterly earnings reports — there's no point hammering the
// API more than necessary.
//
// API docs: https://site.financialmodelingprep.com/developer/docs
// Endpoints used (FMP "Stable" API — replaces deprecated /api/v3/* paths
// retired in August 2025):
//   GET /stable/key-metrics-ttm?symbol={ticker}  → TTM key metrics
//   GET /stable/ratios-ttm?symbol={ticker}        → TTM financial ratios
//
// Rate limit: 250 calls/day on free tier. 2 calls per ticker per refresh.
// At 50 holdings × 2 calls / 48h cache = ~50 calls/day average. Well under.
//
// Coverage note: FMP free tier covers large caps and most S&P 500 tickers
// but excludes many small-cap and recent-IPO names. The fetch returns null
// for unsupported tickers (FMP responds with a "Premium Query Parameter"
// error in the body for those) — the UI shows "—" in the Fund column.

import { Redis } from '@upstash/redis';
import { getUpstashConfig } from './store-upstash';
import type { Signal } from './technicals';

const FMP_API_BASE = 'https://financialmodelingprep.com/stable';
const CACHE_TTL_SECONDS = 48 * 60 * 60; // 48 hours
const FUND_KEY = (ticker: string) => `xbr:fundamentals:${ticker}`;

export interface FundamentalIndicators {
  valuation: Signal;     // P/E, P/B, P/S — is the stock cheap or expensive?
  profitability: Signal; // ROE, net margin — does the business make money?
  growth: Signal;        // Revenue growth, EPS growth — is it expanding?
  health: Signal;        // Debt/equity, current ratio, FCF — will it survive?
}

export interface FundamentalSignal {
  signal: Signal;
  /** 0..1, fraction of indicators that voted with the winning side */
  confidence: number;
  indicators: FundamentalIndicators;
  /** Snapshot of raw metrics so the UI can show "why" on hover */
  metrics: {
    peRatio: number | null;
    priceToBook: number | null;
    priceToSales: number | null;
    roe: number | null;          // return on equity (decimal, e.g. 0.15 = 15%)
    netMargin: number | null;    // net margin (decimal)
    revenueGrowth: number | null; // YoY (decimal)
    debtToEquity: number | null;
    currentRatio: number | null;
    freeCashFlow: number | null;
  };
  /** ISO timestamp of when this data was fetched from FMP. */
  fetchedAt: string;
}

// ─── FMP API client ─────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.FMP_API_KEY;
  if (!key) {
    throw new Error('FMP_API_KEY is not set in env');
  }
  return key;
}

/**
 * FMP Stable API key-metrics-ttm response shape (only the fields we use).
 * Note: P/E, P/B, P/S ratios moved OUT of this endpoint into ratios-ttm
 * with the v3 → stable migration. This endpoint now contains structural
 * metrics like ROE, current ratio, and FCF yield.
 */
interface FMPKeyMetricsTTM {
  symbol?: string;
  returnOnEquityTTM?: number | null;
  currentRatioTTM?: number | null;
  freeCashFlowYieldTTM?: number | null;
  freeCashFlowToEquityTTM?: number | null;
  marketCap?: number | null;
}

/**
 * FMP Stable API ratios-ttm response shape (only the fields we use).
 * P/E, P/B, P/S, debt-to-equity, and net margin all live here now.
 */
interface FMPRatiosTTM {
  symbol?: string;
  priceToEarningsRatioTTM?: number | null;
  priceToBookRatioTTM?: number | null;
  priceToSalesRatioTTM?: number | null;
  netProfitMarginTTM?: number | null;
  debtToEquityRatioTTM?: number | null;
  netIncomePerShareTTM?: number | null;
}

/**
 * Detect FMP error responses that come back as 200 OK with an error body.
 * Both "Legacy Endpoint" and "Premium Query Parameter" errors use this
 * pattern instead of HTTP status codes. Returns true if the body looks
 * like an FMP error response.
 */
function isFMPErrorBody(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  return 'Error Message' in body || 'error' in body;
}

/**
 * Fetch raw fundamentals from FMP for a single ticker. Returns null if
 * the ticker is unknown to FMP OR not covered by the current subscription
 * tier (small caps, recent IPOs, ETFs). Throws only on real API errors
 * like network failure or auth problems.
 */
async function fetchFundamentalsRaw(ticker: string): Promise<{
  metrics: FMPKeyMetricsTTM;
  ratios: FMPRatiosTTM;
} | null> {
  const apiKey = encodeURIComponent(getApiKey());
  const upper = ticker.toUpperCase();

  const [metricsRes, ratiosRes] = await Promise.all([
    fetch(`${FMP_API_BASE}/key-metrics-ttm?symbol=${encodeURIComponent(upper)}&apikey=${apiKey}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    }),
    fetch(`${FMP_API_BASE}/ratios-ttm?symbol=${encodeURIComponent(upper)}&apikey=${apiKey}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    }),
  ]);

  if (!metricsRes.ok || !ratiosRes.ok) {
    if (metricsRes.status === 404 || ratiosRes.status === 404) return null;
    const text = await metricsRes.text().catch(() => '');
    throw new Error(
      `FMP ${metricsRes.status}/${ratiosRes.status} for ${upper}: ${text || 'no body'}`,
    );
  }

  const metricsJson = (await metricsRes.json()) as unknown;
  const ratiosJson = (await ratiosRes.json()) as unknown;

  // FMP returns errors as 200 OK with `{ "Error Message": "..." }` in the body.
  // Treat as "no data available" — the UI shows "—" in the Fund column rather
  // than crashing the whole portfolio request.
  if (isFMPErrorBody(metricsJson) || isFMPErrorBody(ratiosJson)) {
    const errMsg =
      (metricsJson as { ['Error Message']?: string })?.['Error Message'] ??
      (ratiosJson as { ['Error Message']?: string })?.['Error Message'] ??
      'unknown FMP error';
    console.warn(`[fundamentals] ${upper} not available: ${errMsg.slice(0, 120)}`);
    return null;
  }

  // FMP wraps single-ticker responses in an array
  const metrics = (Array.isArray(metricsJson) ? metricsJson[0] : metricsJson) as FMPKeyMetricsTTM | undefined;
  const ratios = (Array.isArray(ratiosJson) ? ratiosJson[0] : ratiosJson) as FMPRatiosTTM | undefined;

  if (!metrics) return null;

  return { metrics, ratios: ratios ?? {} };
}

// ─── Per-bucket signal classification ───────────────────────────────────────

/**
 * Valuation: lower P/E and P/B = potentially undervalued. Uses absolute
 * thresholds for MVP — not sector-aware. A 30 P/E is normal for tech and
 * alarming for autos, but we ignore that nuance until we have sector
 * baseline data. Disclaimer covers this in the UI.
 *
 * Note: with the FMP v3→stable migration, P/E, P/B, and P/S all live in
 * the ratios-ttm endpoint now (they used to be in key-metrics-ttm).
 */
function valuationSignal(ratios: FMPRatiosTTM): Signal {
  const pe = ratios.priceToEarningsRatioTTM ?? null;
  const pb = ratios.priceToBookRatioTTM ?? null;
  const ps = ratios.priceToSalesRatioTTM ?? null;

  let bullish = 0;
  let bearish = 0;
  let counted = 0;

  if (pe != null && pe > 0) {
    counted += 1;
    if (pe < 15) bullish += 1;
    else if (pe > 30) bearish += 1;
  }
  if (pb != null && pb > 0) {
    counted += 1;
    if (pb < 1.5) bullish += 1;
    else if (pb > 5) bearish += 1;
  }
  if (ps != null && ps > 0) {
    counted += 1;
    if (ps < 2) bullish += 1;
    else if (ps > 10) bearish += 1;
  }

  if (counted === 0) return 'NEUTRAL';
  if (bullish > bearish && bullish >= Math.ceil(counted / 2)) return 'BUY';
  if (bearish > bullish && bearish >= Math.ceil(counted / 2)) return 'SELL';
  return 'NEUTRAL';
}

/**
 * Profitability: ROE > 15% is generally great; net margin > 10% is
 * generally healthy. Negative either is a warning sign.
 *
 * ROE is now in key-metrics-ttm under returnOnEquityTTM. Net margin
 * stayed in ratios-ttm.
 */
function profitabilitySignal(metrics: FMPKeyMetricsTTM, ratios: FMPRatiosTTM): Signal {
  const roe = metrics.returnOnEquityTTM ?? null;
  const netMargin = ratios.netProfitMarginTTM ?? null;

  let bullish = 0;
  let bearish = 0;
  let counted = 0;

  if (roe != null) {
    counted += 1;
    if (roe > 0.15) bullish += 1;
    else if (roe < 0) bearish += 1;
  }
  if (netMargin != null) {
    counted += 1;
    if (netMargin > 0.1) bullish += 1;
    else if (netMargin < 0) bearish += 1;
  }

  if (counted === 0) return 'NEUTRAL';
  if (bullish > bearish && bullish >= Math.ceil(counted / 2)) return 'BUY';
  if (bearish > bullish && bearish >= Math.ceil(counted / 2)) return 'SELL';
  return 'NEUTRAL';
}

/**
 * Growth: positive EPS on a TTM basis as the bare minimum profitability
 * gate. True YoY growth requires historical snapshots (deferred to v1.1).
 */
function growthSignal(ratios: FMPRatiosTTM): Signal {
  const epsTTM = ratios.netIncomePerShareTTM ?? null;
  if (epsTTM == null) return 'NEUTRAL';
  if (epsTTM > 0) return 'BUY'; // profitable on a TTM basis
  return 'SELL'; // losing money on a TTM basis
}

/**
 * Financial health: low debt/equity, positive FCF yield, current ratio
 * > 1.5. Conservative balance sheet wins.
 *
 * FCF check uses freeCashFlowYieldTTM > 0 instead of per-share value
 * because the new stable API doesn't expose freeCashFlowPerShareTTM.
 * Yield > 0 is mathematically equivalent to "FCF positive" so the
 * signal logic is unchanged.
 */
function healthSignal(metrics: FMPKeyMetricsTTM, ratios: FMPRatiosTTM): Signal {
  const dToE = ratios.debtToEquityRatioTTM ?? null;
  const currentRatio = metrics.currentRatioTTM ?? null;
  const fcfYield = metrics.freeCashFlowYieldTTM ?? null;

  let bullish = 0;
  let bearish = 0;
  let counted = 0;

  if (dToE != null && dToE >= 0) {
    counted += 1;
    if (dToE < 0.5) bullish += 1;
    else if (dToE > 2) bearish += 1;
  }
  if (currentRatio != null && currentRatio > 0) {
    counted += 1;
    if (currentRatio > 1.5) bullish += 1;
    else if (currentRatio < 1) bearish += 1;
  }
  if (fcfYield != null) {
    counted += 1;
    if (fcfYield > 0) bullish += 1;
    else bearish += 1;
  }

  if (counted === 0) return 'NEUTRAL';
  if (bullish > bearish && bullish >= Math.ceil(counted / 2)) return 'BUY';
  if (bearish > bullish && bearish >= Math.ceil(counted / 2)) return 'SELL';
  return 'NEUTRAL';
}

// ─── Aggregation ────────────────────────────────────────────────────────────

function aggregate(
  metrics: FMPKeyMetricsTTM,
  ratios: FMPRatiosTTM,
): FundamentalSignal {
  const indicators: FundamentalIndicators = {
    valuation: valuationSignal(ratios),
    profitability: profitabilitySignal(metrics, ratios),
    growth: growthSignal(ratios),
    health: healthSignal(metrics, ratios),
  };

  let buys = 0;
  let sells = 0;
  let neutrals = 0;
  for (const v of Object.values(indicators)) {
    if (v === 'BUY') buys += 1;
    else if (v === 'SELL') sells += 1;
    else neutrals += 1;
  }

  // Majority of 4: 3+ wins. Otherwise NEUTRAL.
  let signal: Signal = 'NEUTRAL';
  let confidence = 0;
  if (buys >= 3) {
    signal = 'BUY';
    confidence = buys / 4;
  } else if (sells >= 3) {
    signal = 'SELL';
    confidence = sells / 4;
  } else {
    confidence = neutrals / 4;
  }

  return {
    signal,
    confidence,
    indicators,
    metrics: {
      peRatio: ratios.priceToEarningsRatioTTM ?? null,
      priceToBook: ratios.priceToBookRatioTTM ?? null,
      priceToSales: ratios.priceToSalesRatioTTM ?? null,
      roe: metrics.returnOnEquityTTM ?? null,
      netMargin: ratios.netProfitMarginTTM ?? null,
      revenueGrowth: null, // not exposed by TTM endpoints — v1.1 with historical
      debtToEquity: ratios.debtToEquityRatioTTM ?? null,
      currentRatio: metrics.currentRatioTTM ?? null,
      freeCashFlow: metrics.freeCashFlowYieldTTM ?? null, // yield, not per-share
    },
    fetchedAt: new Date().toISOString(),
  };
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

function parseCached(raw: unknown): FundamentalSignal | null {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw as FundamentalSignal;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as FundamentalSignal;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Get the fundamental signal for a single ticker. Always serves from cache
 * if available; refreshes from FMP on miss with 48h TTL. Returns null if
 * FMP doesn't recognize the ticker.
 */
export async function getFundamentalSignal(ticker: string): Promise<FundamentalSignal | null> {
  const upper = ticker.toUpperCase();
  const redis = getRedis();

  if (redis) {
    const cached = await redis.get<FundamentalSignal | string>(FUND_KEY(upper));
    const parsed = parseCached(cached);
    if (parsed) return parsed;
  }

  const raw = await fetchFundamentalsRaw(upper);
  if (!raw) return null;

  const fresh = aggregate(raw.metrics, raw.ratios);

  if (redis) {
    await redis.set(FUND_KEY(upper), JSON.stringify(fresh), { ex: CACHE_TTL_SECONDS });
  }
  return fresh;
}

/**
 * Force-refresh a single ticker's fundamentals cache. Used by the cron's
 * cache warming so the on-demand fetch in /api/fundamentals stays fast.
 */
export async function refreshFundamentalSignal(ticker: string): Promise<FundamentalSignal | null> {
  const upper = ticker.toUpperCase();
  const redis = getRedis();
  if (redis) {
    await redis.del(FUND_KEY(upper));
  }
  return getFundamentalSignal(upper);
}
