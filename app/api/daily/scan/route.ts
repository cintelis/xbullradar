import { analyzeTickersBatch } from '@/lib/sentiment';
import { store } from '@/lib/store';
import { detectAlert, sendAlert } from '@/lib/alerts';

export const runtime = 'nodejs';

/**
 * Daily portfolio scan. Trigger from a scheduler (Vercel Cron, Cloudflare
 * Pages cron, GitHub Actions cron, etc.) by POSTing to this route.
 *
 * Steps:
 *   1. Load watchlist from store
 *   2. Batch-score all tickers in a single Grok call
 *   3. Compare each result to last known score, fire webhook alerts on crossings
 *   4. Persist new last-known scores
 */
export async function POST() {
  try {
    const watchlist = await store.getWatchlist();
    if (watchlist.length === 0) {
      return Response.json({ success: true, message: 'Watchlist is empty', results: [] });
    }

    const results = await analyzeTickersBatch(watchlist);

    const alerts = [];
    for (const sentiment of results) {
      const previous = await store.getLastSentiment(sentiment.ticker);
      const alert = detectAlert({ current: sentiment, previous });
      if (alert) {
        alerts.push(alert);
        await sendAlert(alert);
      }
      await store.setLastSentiment(sentiment);
    }

    return Response.json({
      success: true,
      timestamp: new Date().toISOString(),
      scanned: results.length,
      alertsFired: alerts.length,
      results,
      alerts,
    });
  } catch (err) {
    console.error('[daily/scan] failed', err);
    return Response.json(
      {
        success: false,
        error: (err as Error).message,
      },
      { status: 500 },
    );
  }
}
