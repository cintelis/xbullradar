import { type NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getNews, type NewsCategory } from '@/lib/news';

export const runtime = 'nodejs';

const VALID_CATEGORIES: ReadonlySet<NewsCategory> = new Set([
  'all',
  'general',
  'stock',
  'crypto',
  'forex',
]);

/**
 * GET /api/news?category=all|general|stock|crypto|forex
 *
 * Returns the cached financial news feed for the requested category.
 * Defaults to 'all' which merges general + stock + crypto + forex sorted
 * by publishedDate descending.
 *
 * Auth-gated like the other dashboard endpoints. Reads from the per-
 * category Upstash cache (5-minute TTL); cold cache triggers 1-4 FMP
 * calls depending on the category.
 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const requested = (request.nextUrl.searchParams.get('category') ?? 'all').toLowerCase();
  const category: NewsCategory = VALID_CATEGORIES.has(requested as NewsCategory)
    ? (requested as NewsCategory)
    : 'all';

  try {
    const data = await getNews(category);
    return Response.json(data);
  } catch (err) {
    console.error('[news] fetch failed', err);
    return Response.json(
      { error: (err as Error).message, articles: [], fetchedAt: null, category },
      { status: 500 },
    );
  }
}
