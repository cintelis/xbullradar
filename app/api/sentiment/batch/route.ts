import { analyzeTickersBatch } from '@/lib/sentiment';
import { store } from '@/lib/store';
import { getCurrentUser } from '@/lib/auth';

export const runtime = 'nodejs';

/**
 * GET — return last-known sentiment scores from the store (cheap, no Grok call).
 *      Used by the dashboard on initial load.
 *
 * POST — re-score the watchlist with a single Grok call and persist results.
 *        Used when the user clicks "refresh".
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }
  const watchlist = await store.getWatchlist(user.id);
  const lastAll = await store.getAllLastSentiments(user.id);

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
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }
  try {
    const watchlist = await store.getWatchlist(user.id);
    const results = await analyzeTickersBatch(watchlist);
    for (const sentiment of results) {
      await store.setLastSentiment(user.id, sentiment);
    }
    return Response.json({ results, fresh: true });
  } catch (err) {
    return Response.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
