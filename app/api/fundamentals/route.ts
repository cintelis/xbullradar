import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getFundamentalSignal, type FundamentalSignal } from '@/lib/fundamentals';

export const runtime = 'nodejs';

const TICKER_PATTERN = /^[A-Z]{1,10}$/;
const MAX_TICKERS_PER_REQUEST = 50;

interface FundamentalSignalResponse {
  ticker: string;
  signal: FundamentalSignal | null;
}

/**
 * GET /api/fundamentals?tickers=NVDA,TSLA,AAPL
 *
 * Returns the aggregated fundamental signal (BUY/SELL/NEUTRAL) for each
 * ticker. Reads from the per-ticker FMP cache (lib/fundamentals.ts) which
 * has a 48h TTL — fundamentals only update on quarterly earnings reports
 * so a 2-day cache is more than fresh enough.
 *
 * On a warm cache: zero FMP calls. On a cold cache: 2 FMP calls per
 * uncached ticker (sequential to stay under the 250/day Stocks Basic
 * rate budget).
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

  // Sequential — most calls hit cache anyway, and FMP free tier is rate-limited.
  const results: FundamentalSignalResponse[] = [];
  for (const ticker of tickers) {
    try {
      const signal = await getFundamentalSignal(ticker);
      results.push({ ticker, signal });
    } catch (err) {
      console.error(`[fundamentals] ${ticker} failed`, err);
      results.push({ ticker, signal: null });
    }
  }

  return Response.json({ results });
}
