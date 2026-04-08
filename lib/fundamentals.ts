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
// Endpoints used:
//   GET /api/v3/key-metrics-ttm/{ticker}      → returns TTM key metrics
//   GET /api/v3/ratios-ttm/{ticker}            → returns TTM financial ratios
//
// Rate limit: 250 calls/day on free tier. 2 calls per ticker per refresh.
// At 50 holdings × 2 calls / 48h cache = ~50 calls/day average. Well under.

import { Redis } from '@upstash/redis';
import { getUpstashConfig } from './store-upstash';
import type { Signal } from './technicals';

const FMP_API_BASE = 'https://financialmodelingprep.com/api/v3';
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

interface FMPKeyMetricsTTM {
  symbol?: string;
  peRatioTTM?: number | null;
  pbRatioTTM?: number | null;
  priceToSalesRatioTTM?: number | null;
  roeTTM?: number | null;
  netIncomePerShareTTM?: number | null;
  freeCashFlowPerShareTTM?: number | null;
  currentRatioTTM?: number | null;
  debtToEquityTTM?: number | null;
}

interface FMPRatiosTTM {
  symbol?: string;
  netProfitMarginTTM?: number | null;
  // FMP also returns dozens of other fields; we only need the ones above for MVP.
}

/**
 * Fetch raw fundamentals from FMP for a single ticker. Returns null if
 * the ticker is unknown to FMP. Throws on real API errors.
 */
async function fetchFundamentalsRaw(ticker: string): Promise<{
  metrics: FMPKeyMetricsTTM;
  ratios: FMPRatiosTTM;
} | null> {
  const apiKey = encodeURIComponent(getApiKey());
  const upper = ticker.toUpperCase();

  const [metricsRes, ratiosRes] = await Promise.all([
    fetch(`${FMP_API_BASE}/key-metrics-ttm/${encodeURIComponent(upper)}?apikey=${apiKey}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    }),
    fetch(`${FMP_API_BASE}/ratios-ttm/${encodeURIComponent(upper)}?apikey=${apiKey}`, {
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

  const metricsJson = (await metricsRes.json()) as FMPKeyMetricsTTM[] | FMPKeyMetricsTTM;
  const ratiosJson = (await ratiosRes.json()) as FMPRatiosTTM[] | FMPRatiosTTM;

  // FMP wraps single-ticker responses in an array
  const metrics = Array.isArray(metricsJson) ? metricsJson[0] : metricsJson;
  const ratios = Array.isArray(ratiosJson) ? ratiosJson[0] : ratiosJson;

  if (!metrics) return null;

  return { metrics, ratios: ratios ?? {} };
}

// ─── Per-bucket signal classification ───────────────────────────────────────

/**
 * Valuation: lower P/E and P/B = potentially undervalued. Uses absolute
 * thresholds for MVP — not sector-aware. A 30 P/E is normal for tech and
 * alarming for autos, but we ignore that nuance until we have sector
 * baseline data. Disclaimer covers this in the UI.
 */
function valuationSignal(metrics: FMPKeyMetricsTTM): Signal {
  const pe = metrics.peRatioTTM ?? null;
  const pb = metrics.pbRatioTTM ?? null;
  const ps = metrics.priceToSalesRatioTTM ?? null;

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
 */
function profitabilitySignal(metrics: FMPKeyMetricsTTM, ratios: FMPRatiosTTM): Signal {
  const roe = metrics.roeTTM ?? null;
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
 * Growth: positive net income per share is the bare minimum. We'd want
 * YoY revenue growth too, but FMP's TTM endpoints don't include it
 * directly. Using EPS as a proxy — positive and not declining is the
 * signal. Real growth signal would need historical comparisons (a v1.1
 * extension when we cache older snapshots).
 */
function growthSignal(metrics: FMPKeyMetricsTTM): Signal {
  const epsTTM = metrics.netIncomePerShareTTM ?? null;
  if (epsTTM == null) return 'NEUTRAL';
  if (epsTTM > 0) return 'BUY'; // profitable on a TTM basis
  return 'SELL'; // losing money on a TTM basis
}

/**
 * Financial health: low debt/equity, positive FCF, current ratio > 1.5.
 * Conservative balance sheet wins.
 */
function healthSignal(metrics: FMPKeyMetricsTTM): Signal {
  const dToE = metrics.debtToEquityTTM ?? null;
  const currentRatio = metrics.currentRatioTTM ?? null;
  const fcfPerShare = metrics.freeCashFlowPerShareTTM ?? null;

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
  if (fcfPerShare != null) {
    counted += 1;
    if (fcfPerShare > 0) bullish += 1;
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
    valuation: valuationSignal(metrics),
    profitability: profitabilitySignal(metrics, ratios),
    growth: growthSignal(metrics),
    health: healthSignal(metrics),
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
      peRatio: metrics.peRatioTTM ?? null,
      priceToBook: metrics.pbRatioTTM ?? null,
      priceToSales: metrics.priceToSalesRatioTTM ?? null,
      roe: metrics.roeTTM ?? null,
      netMargin: ratios.netProfitMarginTTM ?? null,
      revenueGrowth: null, // not exposed by TTM endpoints — v1.1 with historical
      debtToEquity: metrics.debtToEquityTTM ?? null,
      currentRatio: metrics.currentRatioTTM ?? null,
      freeCashFlow: metrics.freeCashFlowPerShareTTM ?? null,
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
