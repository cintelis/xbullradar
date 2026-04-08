import { getCurrentUser } from '@/lib/auth';
import { getMarkets } from '@/lib/markets';

export const runtime = 'nodejs';

/**
 * GET /api/markets
 *
 * Returns the cached commodities ticker tape data + exchange hours
 * metadata for the dashboard MarketStrip component. Auth-gated like
 * the other dashboard endpoints.
 *
 * Reads from Upstash cache shared across all users. Cold cache fetch
 * costs ~11 sequential FMP calls (~2s); warm cache is instant.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  try {
    const data = await getMarkets();
    return Response.json(data);
  } catch (err) {
    console.error('[markets] fetch failed', err);
    return Response.json(
      { error: (err as Error).message, commodities: [], exchanges: [], fetchedAt: null },
      { status: 500 },
    );
  }
}
