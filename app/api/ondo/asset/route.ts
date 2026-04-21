import { NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getOndoAsset } from '@/lib/ondo';

export const runtime = 'nodejs';

const TICKER_PATTERN = /^[A-Z]{1,10}$/;

/**
 * GET /api/ondo/asset?ticker=NVDA
 *
 * Returns live Ondo on-chain token price + underlying stock price + spread
 * for the given ticker. 60s cache layer in lib/ondo.ts shields the
 * upstream API from hot-path traffic.
 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const tickerParam = request.nextUrl.searchParams.get('ticker') ?? '';
  const ticker = tickerParam.trim().toUpperCase();

  if (!ticker) {
    return Response.json({ error: 'ticker query param required' }, { status: 400 });
  }
  if (!TICKER_PATTERN.test(ticker)) {
    return Response.json({ error: `Invalid ticker "${ticker}"` }, { status: 400 });
  }

  const asset = await getOndoAsset(ticker);
  if (!asset) {
    return Response.json({ error: 'Not available on Ondo' }, { status: 404 });
  }

  return Response.json(asset);
}
