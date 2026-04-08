import { NextRequest } from 'next/server';
import { store } from '@/lib/store';
import { getCurrentUser } from '@/lib/auth';
import type { PortfolioHolding } from '@/types';

export const runtime = 'nodejs';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }
  const [holdings, lastAll] = await Promise.all([
    store.getHoldings(user.id),
    store.getAllLastSentiments(user.id),
  ]);

  // Hydrate each holding with its latest sentiment score from the store.
  const enriched: PortfolioHolding[] = holdings.map((h) => ({
    ...h,
    sentimentScore: lastAll[h.ticker.toUpperCase()]?.score ?? h.sentimentScore ?? 0,
  }));

  return Response.json({ holdings: enriched });
}

export async function PUT(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }
  try {
    const body = (await request.json()) as { holdings: PortfolioHolding[] };
    if (!Array.isArray(body?.holdings)) {
      return Response.json({ error: 'holdings array required' }, { status: 400 });
    }
    await store.setHoldings(user.id, body.holdings);
    return Response.json({ success: true });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
