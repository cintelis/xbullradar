import { analyzeTickersBatch } from '@/lib/sentiment';
import { store } from '@/lib/store';

export const runtime = 'nodejs';

/**
 * GET — return last-known sentiment scores from the store (cheap, no Grok call).
 *      Used by the dashboard on initial load.
 *
 * POST — re-score the watchlist with a single Grok call and persist results.
 *        Used when the user clicks "refresh".
 */
export async function GET() {
  const watchlist = await store.getWatchlist();
  const lastAll = await store.getAllLastSentiments();

  const results = watchlist.map((ticker) => {
    const last = lastAll[ticker];
    return (
      last ?? {
        ticker,
        score: 0,
        reasoning: '',
      }
    );
  });

  return Response.json({ results, fresh: false });
}

export async function POST() {
  try {
    const watchlist = await store.getWatchlist();
    const results = await analyzeTickersBatch(watchlist);
    for (const sentiment of results) {
      await store.setLastSentiment(sentiment);
    }
    return Response.json({ results, fresh: true });
  } catch (err) {
    return Response.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
