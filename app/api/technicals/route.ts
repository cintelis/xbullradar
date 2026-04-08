import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getHistoricalCloses } from '@/lib/prices';
import { computeTechnicalSignal, type TechnicalSignal } from '@/lib/technicals';

export const runtime = 'nodejs';

const TICKER_PATTERN = /^[A-Z]{1,10}$/;
const MAX_TICKERS_PER_REQUEST = 50;

interface TechnicalSignalResponse {
  ticker: string;
  signal: TechnicalSignal | null;
  /** ISO date the underlying historical data was last refreshed. */
  asOfDate: string | null;
}

/**
 * GET /api/technicals?tickers=NVDA,TSLA,AAPL
 *
 * Returns the aggregated technical signal (BUY/SELL/NEUTRAL) for each
 * ticker. Reads from the per-ticker historical cache (lib/prices.ts
 * getHistoricalCloses) and computes the indicator vote in pure TS
 * (lib/technicals.ts computeTechnicalSignal).
 *
 * On a warm cache: zero Polygon calls. On a cold cache: 1 Polygon call
 * per uncached ticker (sequential to stay under the 5/min Stocks Basic
 * rate limit).
 *
 * Auth-gated like the other portfolio endpoints.
 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const tickersParam = request.nextUrl.searchParams.get('tickers') ?? '';
  const tickers = tickersParam
    .split(',')
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);

  if (tickers.length === 0) {
    return Response.json({ error: 'tickers query param required' }, { status: 400 });
  }
  if (tickers.length > MAX_TICKERS_PER_REQUEST) {
    return Response.json(
      { error: `Too many tickers — limit ${MAX_TICKERS_PER_REQUEST}` },
      { status: 400 },
    );
  }
  for (const t of tickers) {
    if (!TICKER_PATTERN.test(t)) {
      return Response.json({ error: `Invalid ticker "${t}"` }, { status: 400 });
    }
  }

  // Sequential, not parallel — Polygon's free tier rate-limits and we want
  // to stay friendly. Most calls will be cache hits anyway.
  const results: TechnicalSignalResponse[] = [];
  for (const ticker of tickers) {
    try {
      const history = await getHistoricalCloses(ticker);
      if (!history || history.closes.length === 0) {
        results.push({ ticker, signal: null, asOfDate: null });
        continue;
      }
      const signal = computeTechnicalSignal(history.closes);
      results.push({ ticker, signal, asOfDate: history.asOfDate });
    } catch (err) {
      console.error(`[technicals] ${ticker} failed`, err);
      results.push({ ticker, signal: null, asOfDate: null });
    }
  }

  return Response.json({ results });
}
