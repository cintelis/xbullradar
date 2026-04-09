import type { NextRequest } from 'next/server';
import { analyzeTickersBatch } from '@/lib/sentiment';
import { store } from '@/lib/store';
import { detectAlert, sendAlert } from '@/lib/alerts';
import { refreshDailyPrices, refreshHistoricalCloses } from '@/lib/prices';
import { refreshFundamentalSignal } from '@/lib/fundamentals';
import { refreshMarkets } from '@/lib/markets';
import { refreshNews } from '@/lib/news';
import { refreshEarnings } from '@/lib/earnings';

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

  // Refresh the markets cache (commodities + exchange hours) so the
  // dashboard ticker strip is fresh for morning users. Non-fatal —
  // strip is decorative.
  try {
    const markets = await refreshMarkets();
    console.log(
      `[daily/scan] refreshed markets cache, ${markets.commodities.length} commodities, ${markets.exchanges.length} exchanges`,
    );
  } catch (err) {
    console.error('[daily/scan] markets cache refresh failed', err);
  }

  // Refresh the news cache so the right-sidebar NewsPanel has fresh
  // content for morning users instead of paying the cold-cache cost
  // themselves. Warms all 4 category caches in sequence. Non-fatal —
  // news is decorative when chat is showing.
  try {
    await refreshNews();
    console.log('[daily/scan] refreshed news cache (4 categories)');
  } catch (err) {
    console.error('[daily/scan] news cache refresh failed', err);
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

      // Warm the technical-indicators history cache for each ticker in this
      // user's watchlist. Sequential to respect Polygon's 5/min rate limit.
      // One ticker at a time, ~1 call per ticker, ~7-50 calls per user.
      // Failures here are non-fatal — the on-demand fetch in /api/technicals
      // will fall back if a particular ticker isn't pre-warmed.
      for (const ticker of watchlist) {
        try {
          await refreshHistoricalCloses(ticker);
        } catch (err) {
          console.warn(`[daily/scan] history refresh failed for ${ticker}:`, err);
        }
      }

      // Warm the fundamentals cache for each ticker. 2 FMP calls per ticker
      // (key-metrics-ttm + ratios-ttm). Cached for 48h, so this only does
      // real work every other day. Failures non-fatal.
      for (const ticker of watchlist) {
        try {
          await refreshFundamentalSignal(ticker);
        } catch (err) {
          console.warn(`[daily/scan] fundamentals refresh failed for ${ticker}:`, err);
        }
      }

      // Warm the earnings cache for each ticker — 1 FMP call per ticker
      // hitting /stable/earnings, cached for 12h. Used by the portfolio
      // earnings badges and the fundamentals beat/miss signal bucket.
      for (const ticker of watchlist) {
        try {
          await refreshEarnings(ticker);
        } catch (err) {
          console.warn(`[daily/scan] earnings refresh failed for ${ticker}:`, err);
        }
      }
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
