import { getCurrentUser } from '@/lib/auth';
import { getNews } from '@/lib/news';

export const runtime = 'nodejs';

/**
 * GET /api/news → returns the cached financial news feed.
 *
 * Auth-gated like the other dashboard endpoints. Reads from the shared
 * Upstash cache (20-minute TTL); cold cache triggers a single FMP call
 * to /stable/fmp-articles.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  try {
    const data = await getNews();
    return Response.json(data);
  } catch (err) {
    console.error('[news] fetch failed', err);
    return Response.json(
      { error: (err as Error).message, articles: [], fetchedAt: null },
      { status: 500 },
    );
  }
}
