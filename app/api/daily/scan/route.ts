import type { NextRequest } from 'next/server';
import { analyzeTickersBatch } from '@/lib/sentiment';
import { store } from '@/lib/store';
import { detectAlert, sendAlert } from '@/lib/alerts';
import { refreshDailyPrices } from '@/lib/prices';

export const runtime = 'nodejs';

/**
 * Daily portfolio scan. Triggered by Vercel Cron (configured in vercel.json)
 * or manually via POST.
 *
 * Steps:
 *   1. Load watchlist from store
 *   2. Batch-score all tickers in a single Grok call
 *   3. Compare each result to last known score, fire webhook alerts on crossings
 *   4. Persist new last-known scores
 *
 * Auth: when CRON_SECRET is set in env, requests must include
 * `Authorization: Bearer ${CRON_SECRET}`. Vercel Cron sends this header
 * automatically. In local dev (no CRON_SECRET), no auth is required.
 */

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // Local dev: no secret, no check.
  const auth = request.headers.get('authorization') || '';
  return auth === `Bearer ${secret}`;
}

async function runScan() {
  // Refresh the price cache once per scan so portfolio views see fresh
  // end-of-day prices on the next request. Don't fail the whole scan if
  // Polygon is down — sentiment is the priority, prices are nice-to-have.
  try {
    const prices = await refreshDailyPrices();
    console.log(`[daily/scan] refreshed price cache, asOfDate=${prices.asOfDate}`);
  } catch (err) {
    console.error('[daily/scan] price cache refresh failed', err);
  }

  const userIds = await store.listUserIds();
  if (userIds.length === 0) {
    return {
      success: true,
      message: 'No users to scan',
      timestamp: new Date().toISOString(),
      usersScanned: 0,
      tickersScanned: 0,
      alertsFired: 0,
      perUser: [],
    };
  }

  // Sequential, not parallel — N users × 1 batch Grok call each. Parallel
  // would hammer Grok rate limits and we don't get faster results from the
  // user's perspective anyway (this is a background cron, not a UI request).
  // When this becomes a bottleneck (probably ~100+ active users), the right
  // optimization is to deduplicate tickers across users into a single Grok
  // call and split the results — see backlog.
  const perUser: Array<{
    userId: string;
    tickerCount: number;
    alertCount: number;
  }> = [];
  let totalTickers = 0;
  let totalAlerts = 0;

  for (const userId of userIds) {
    try {
      const watchlist = await store.getWatchlist(userId);
      if (watchlist.length === 0) {
        perUser.push({ userId, tickerCount: 0, alertCount: 0 });
        continue;
      }

      const results = await analyzeTickersBatch(watchlist);
      let alertCount = 0;

      for (const sentiment of results) {
        const previous = await store.getLastSentiment(userId, sentiment.ticker);
        const alert = detectAlert({ current: sentiment, previous });
        if (alert) {
          alertCount += 1;
          totalAlerts += 1;
          await sendAlert(alert);
        }
        await store.setLastSentiment(userId, sentiment);
      }

      totalTickers += results.length;
      perUser.push({ userId, tickerCount: results.length, alertCount });
    } catch (err) {
      // One user's failure shouldn't stop the whole scan. Log and continue.
      console.error(`[daily/scan] failed for user ${userId}:`, err);
      perUser.push({ userId, tickerCount: 0, alertCount: 0 });
    }
  }

  return {
    success: true,
    timestamp: new Date().toISOString(),
    usersScanned: userIds.length,
    tickersScanned: totalTickers,
    alertsFired: totalAlerts,
    perUser,
  };
}

async function handle(request: NextRequest) {
  if (!isAuthorized(request)) {
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const result = await runScan();
    return Response.json(result);
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

// Vercel Cron sends GET requests.
export const GET = handle;
// POST kept for manual triggering and backward compatibility.
export const POST = handle;
