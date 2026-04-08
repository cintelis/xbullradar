import type { NextRequest } from 'next/server';
import { analyzeTickersBatch } from '@/lib/sentiment';
import { store, SYSTEM_USER_ID } from '@/lib/store';
import { detectAlert, sendAlert } from '@/lib/alerts';

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
  // TODO Commit 4: iterate over store.listUserIds() and scan each user's
  // watchlist. For now scans only the system user (the global pre-auth
  // dataset) so the cron keeps working through Commit 2/3.
  const userId = SYSTEM_USER_ID;
  const watchlist = await store.getWatchlist(userId);
  if (watchlist.length === 0) {
    return { success: true, message: 'Watchlist is empty', results: [], alerts: [] };
  }

  const results = await analyzeTickersBatch(watchlist);

  const alerts = [];
  for (const sentiment of results) {
    const previous = await store.getLastSentiment(userId, sentiment.ticker);
    const alert = detectAlert({ current: sentiment, previous });
    if (alert) {
      alerts.push(alert);
      await sendAlert(alert);
    }
    await store.setLastSentiment(userId, sentiment);
  }

  return {
    success: true,
    timestamp: new Date().toISOString(),
    scanned: results.length,
    alertsFired: alerts.length,
    results,
    alerts,
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
