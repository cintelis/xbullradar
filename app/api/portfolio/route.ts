import { NextRequest } from 'next/server';
import { store, SYSTEM_USER_ID } from '@/lib/store';
import type { PortfolioHolding } from '@/types';

export const runtime = 'nodejs';

export async function GET() {
  // TODO Commit 4: read userId from authenticated session.
  const userId = SYSTEM_USER_ID;
  const [holdings, lastAll] = await Promise.all([
    store.getHoldings(userId),
    store.getAllLastSentiments(userId),
  ]);

  // Hydrate each holding with its latest sentiment score from the store.
  const enriched: PortfolioHolding[] = holdings.map((h) => ({
    ...h,
    sentimentScore: lastAll[h.ticker.toUpperCase()]?.score ?? h.sentimentScore ?? 0,
  }));

  return Response.json({ holdings: enriched });
}

export async function PUT(request: NextRequest) {
  // TODO Commit 4: read userId from authenticated session.
  const userId = SYSTEM_USER_ID;
  try {
    const body = (await request.json()) as { holdings: PortfolioHolding[] };
    if (!Array.isArray(body?.holdings)) {
      return Response.json({ error: 'holdings array required' }, { status: 400 });
    }
    await store.setHoldings(userId, body.holdings);
    return Response.json({ success: true });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
