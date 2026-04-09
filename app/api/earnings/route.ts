import { type NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getEarnings, getNextEarnings, getEarningsBeatHistory } from '@/lib/earnings';

export const runtime = 'nodejs';

const TICKER_PATTERN = /^[A-Z]{1,10}$/;
const MAX_TICKERS_PER_REQUEST = 50;

interface EarningsResponseRow {
  ticker: string;
  next: ReturnType<typeof getNextEarnings>;
  recentBeats: ReturnType<typeof getEarningsBeatHistory>;
}

/**
 * GET /api/earnings?tickers=NVDA,TSLA,AAPL
 *
 * Returns the next upcoming earnings + recent beat/miss history per
 * ticker. Used by the dashboard to show "Earnings in 3d" badges on
 * portfolio rows + watchlist rows.
 *
 * Auth-gated. Reads from per-ticker Upstash cache (12h TTL); cold cache
 * triggers 1 FMP call per uncached ticker.
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

  // Sequential — most calls hit the warm cache anyway. Even cold-fetching
  // 50 tickers takes ~10 seconds, well under any reasonable timeout.
  const results: EarningsResponseRow[] = [];
  for (const ticker of tickers) {
    try {
      const cache = await getEarnings(ticker);
      results.push({
        ticker,
        next: getNextEarnings(cache),
        recentBeats: getEarningsBeatHistory(cache, 4),
      });
    } catch (err) {
      console.error(`[earnings] ${ticker} failed`, err);
      results.push({ ticker, next: null, recentBeats: [] });
    }
  }

  return Response.json({ results });
}
