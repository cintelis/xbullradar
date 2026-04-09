// Earnings calendar + history fetcher for the dashboard.
//
// Source: FMP /stable/earnings?symbol={ticker} — per-ticker endpoint that
// returns past actuals and future estimates in one call. Available on
// FMP Stocks Starter (the per-symbol filter is required; the no-filter
// /stable/earnings call returns "missing query parameter").
//
// Two use cases:
//
//   1. PORTFOLIO BADGES — show "Earnings TODAY!" / "in 3d" / "in 18d"
//      next to holdings so users know when their stocks will move.
//      Use getNextEarnings(ticker).
//
//   2. FUNDAMENTALS BUCKET — compute the company's beat/miss track record
//      over the last 4 quarters and feed that into the BUY/SELL/NEUTRAL
//      aggregation as a 5th signal bucket. Use getEarningsHistory(ticker).
//
// Cache: 12-hour TTL per ticker. Earnings data only changes when a new
// estimate or actual is published, which happens at most once per quarter
// for any given ticker. 12h is conservatively fresh.

import { Redis } from '@upstash/redis';
import { getUpstashConfig } from './store-upstash';

const FMP_API_BASE = 'https://financialmodelingprep.com/stable';
const CACHE_KEY = (ticker: string) => `xbr:earnings:v1:${ticker}`;
const CACHE_TTL_SECONDS = 12 * 60 * 60; // 12 hours
const HISTORY_LIMIT = 8; // last 4 reported + ~4 future scheduled

export interface EarningsRecord {
  /** ISO date string of the earnings report (YYYY-MM-DD) */
  date: string;
  /** Reported EPS — null if the report is in the future */
  epsActual: number | null;
  /** Analyst consensus EPS estimate */
  epsEstimated: number | null;
  /** Reported revenue in USD — null if future */
  revenueActual: number | null;
  /** Analyst consensus revenue estimate in USD */
  revenueEstimated: number | null;
}

export interface EarningsCache {
  ticker: string;
  records: EarningsRecord[];
  fetchedAt: string;
}

// ─── FMP client ─────────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.FMP_API_KEY;
  if (!key) throw new Error('FMP_API_KEY is not set in env');
  return key;
}

interface FMPEarningsRaw {
  symbol?: string;
  date?: string;
  epsActual?: number | null;
  epsEstimated?: number | null;
  revenueActual?: number | null;
  revenueEstimated?: number | null;
  lastUpdated?: string;
}

function isFMPErrorBody(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  return 'Error Message' in body || 'error' in body;
}

/**
 * Fetch raw earnings records for a ticker. Returns null if FMP doesn't
 * have data (typo, ETF, foreign listing, etc.). Throws only on real
 * network/auth failures.
 */
async function fetchEarningsRaw(ticker: string): Promise<EarningsRecord[] | null> {
  const apiKey = encodeURIComponent(getApiKey());
  const upper = ticker.toUpperCase();
  const url = `${FMP_API_BASE}/earnings?symbol=${encodeURIComponent(upper)}&limit=${HISTORY_LIMIT}&apikey=${apiKey}`;

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });

  if (!res.ok) {
    if (res.status === 404) return null;
    return null;
  }

  const json = (await res.json()) as unknown;
  if (isFMPErrorBody(json)) return null;
  if (!Array.isArray(json) || json.length === 0) return null;

  return (json as FMPEarningsRaw[])
    .filter((r): r is FMPEarningsRaw & { date: string } => typeof r.date === 'string')
    .map((r) => ({
      date: r.date,
      epsActual: typeof r.epsActual === 'number' ? r.epsActual : null,
      epsEstimated: typeof r.epsEstimated === 'number' ? r.epsEstimated : null,
      revenueActual: typeof r.revenueActual === 'number' ? r.revenueActual : null,
      revenueEstimated:
        typeof r.revenueEstimated === 'number' ? r.revenueEstimated : null,
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

function parseCached(raw: unknown): EarningsCache | null {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw as EarningsCache;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as EarningsCache;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Get the cached earnings for a ticker. Falls through to FMP on cache
 * miss with a 12h TTL. Returns null if FMP doesn't have data for the
 * ticker (ETFs, typos, international listings, etc.).
 */
export async function getEarnings(ticker: string): Promise<EarningsCache | null> {
  const upper = ticker.toUpperCase();
  const redis = getRedis();

  if (redis) {
    const cached = await redis.get<EarningsCache | string>(CACHE_KEY(upper));
    const parsed = parseCached(cached);
    if (parsed) return parsed;
  }

  const records = await fetchEarningsRaw(upper);
  if (!records) return null;

  const fresh: EarningsCache = {
    ticker: upper,
    records,
    fetchedAt: new Date().toISOString(),
  };

  if (redis) {
    await redis.set(CACHE_KEY(upper), JSON.stringify(fresh), { ex: CACHE_TTL_SECONDS });
  }
  return fresh;
}

/**
 * Force-refresh a ticker's earnings cache. Used by the daily cron's
 * cache-warming pass.
 */
export async function refreshEarnings(ticker: string): Promise<EarningsCache | null> {
  const upper = ticker.toUpperCase();
  const redis = getRedis();
  if (redis) await redis.del(CACHE_KEY(upper));
  return getEarnings(upper);
}

// ─── Helpers used by the UI / fundamentals signal ───────────────────────────

export interface NextEarnings {
  /** ISO date of the next scheduled report */
  date: string;
  /** Days from today (negative = in the past, but getNextEarnings filters those out) */
  daysAway: number;
  /** Analyst consensus EPS estimate, if any */
  epsEstimated: number | null;
  /** Analyst consensus revenue estimate, if any */
  revenueEstimated: number | null;
}

/**
 * Find the next upcoming earnings report for a ticker. Returns null if
 * there's no scheduled report in the records (e.g., ETF, recently
 * reported with no forward date, or coverage gap).
 *
 * "Upcoming" = date is today or in the future AND epsActual is null.
 */
export function getNextEarnings(
  cache: EarningsCache | null,
  now: Date = new Date(),
): NextEarnings | null {
  if (!cache?.records) return null;

  const todayMs = startOfDayUtc(now).getTime();

  // Find the earliest upcoming record (date >= today, no actuals yet)
  let next: { record: EarningsRecord; ms: number } | null = null;
  for (const record of cache.records) {
    if (record.epsActual != null) continue; // already reported
    const ms = parseDateMs(record.date);
    if (ms == null || ms < todayMs) continue;
    if (!next || ms < next.ms) {
      next = { record, ms };
    }
  }

  if (!next) return null;
  const daysAway = Math.floor((next.ms - todayMs) / (24 * 60 * 60 * 1000));
  return {
    date: next.record.date,
    daysAway,
    epsEstimated: next.record.epsEstimated,
    revenueEstimated: next.record.revenueEstimated,
  };
}

export interface EarningsBeatRecord {
  date: string;
  epsActual: number;
  epsEstimated: number;
  /** epsActual - epsEstimated */
  surprise: number;
  /** True if epsActual > epsEstimated */
  beat: boolean;
}

/**
 * Compute the beat/miss history from the most recent N reported quarters.
 * Used by the fundamentals signal to add a "consistency" bucket — companies
 * that consistently beat their consensus are usually executing well.
 *
 * Returns the records sorted newest-first.
 */
export function getEarningsBeatHistory(
  cache: EarningsCache | null,
  maxQuarters = 4,
): EarningsBeatRecord[] {
  if (!cache?.records) return [];

  const reported = cache.records
    .filter(
      (r): r is EarningsRecord & { epsActual: number; epsEstimated: number } =>
        r.epsActual != null && r.epsEstimated != null,
    )
    .sort((a, b) => parseDateMs(b.date)! - parseDateMs(a.date)!)
    .slice(0, maxQuarters);

  return reported.map((r) => ({
    date: r.date,
    epsActual: r.epsActual,
    epsEstimated: r.epsEstimated,
    surprise: r.epsActual - r.epsEstimated,
    beat: r.epsActual > r.epsEstimated,
  }));
}

/**
 * "Beat rate" = fraction of recent quarters where actual EPS beat consensus.
 * Returns null if there's not enough data (need at least 2 reported quarters).
 *
 * Used by the fundamentals signal to bucket the company's earnings consistency:
 *   - >= 0.75 → BUY (consistently beats consensus)
 *   - <= 0.25 → SELL (consistently misses)
 *   - else    → NEUTRAL
 */
export function getEarningsBeatRate(cache: EarningsCache | null): number | null {
  const history = getEarningsBeatHistory(cache, 4);
  if (history.length < 2) return null;
  const beats = history.filter((r) => r.beat).length;
  return beats / history.length;
}

// ─── Date utils ─────────────────────────────────────────────────────────────

function startOfDayUtc(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function parseDateMs(dateStr: string): number | null {
  // FMP returns "YYYY-MM-DD" — parse as UTC midnight to avoid timezone drift
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const ms = Date.UTC(
    parseInt(match[1], 10),
    parseInt(match[2], 10) - 1,
    parseInt(match[3], 10),
  );
  return Number.isNaN(ms) ? null : ms;
}
