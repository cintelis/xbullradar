import { NextRequest } from 'next/server';
import { store } from '@/lib/store';
import { getCurrentUser } from '@/lib/auth';

export const runtime = 'nodejs';

const TICKER_PATTERN = /^[A-Z]{1,10}$/;
const MAX_WATCHLIST_SIZE = 50;

/**
 * GET — return the current user's watchlist (lightweight, no Grok calls).
 * PUT — replace the watchlist with the provided array of tickers.
 *
 * Validation:
 *   - Each ticker must be 1-10 uppercase letters (we uppercase before checking)
 *   - Max 50 tickers per watchlist (prevents abuse + keeps Grok batch sane)
 *   - Duplicates collapsed silently
 */

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }
  const watchlist = await store.getWatchlist(user.id);
  return Response.json({ watchlist });
}

export async function PUT(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  let body: { tickers?: unknown };
  try {
    body = (await request.json()) as { tickers?: unknown };
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!Array.isArray(body.tickers)) {
    return Response.json({ error: 'tickers array required' }, { status: 400 });
  }

  // Normalize: uppercase, trim, dedupe, validate.
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of body.tickers) {
    if (typeof raw !== 'string') {
      return Response.json(
        { error: `Invalid ticker (not a string): ${JSON.stringify(raw)}` },
        { status: 400 },
      );
    }
    const ticker = raw.trim().toUpperCase();
    if (!ticker) continue;
    if (!TICKER_PATTERN.test(ticker)) {
      return Response.json(
        { error: `Invalid ticker "${ticker}" — must be 1-10 letters.` },
        { status: 400 },
      );
    }
    if (seen.has(ticker)) continue;
    seen.add(ticker);
    normalized.push(ticker);
  }

  if (normalized.length > MAX_WATCHLIST_SIZE) {
    return Response.json(
      { error: `Watchlist limited to ${MAX_WATCHLIST_SIZE} tickers.` },
      { status: 400 },
    );
  }

  await store.setWatchlist(user.id, normalized);
  return Response.json({ watchlist: normalized });
}
