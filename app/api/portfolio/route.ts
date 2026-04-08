import { NextRequest } from 'next/server';
import { store } from '@/lib/store';
import { getCurrentUser } from '@/lib/auth';
import { getDailyPrices } from '@/lib/prices';
import type { EnrichedPortfolioHolding, PortfolioHolding } from '@/types';

export const runtime = 'nodejs';

const TICKER_PATTERN = /^[A-Z]{1,10}$/;
const MAX_HOLDINGS = 50;
const MAX_SHARES = 1_000_000_000;

interface PutBody {
  holdings?: Array<{ ticker?: unknown; shares?: unknown }>;
}

interface GetResponse {
  holdings: EnrichedPortfolioHolding[];
  totals: {
    value: number | null;
    dayChangeAmount: number | null;
    dayChangePercent: number | null;
    weightedSentiment: number | null;
  };
  /** ISO date of the close prices the values were computed against. */
  pricesAsOfDate: string | null;
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const [rawHoldings, sentimentMap, priceCache] = await Promise.all([
    store.getHoldings(user.id),
    store.getAllLastSentiments(user.id),
    // Don't blow up the whole portfolio response if Polygon is down — fall
    // back to "no prices available" so the UI can still show shares + sentiment.
    getDailyPrices().catch((err) => {
      console.error('[portfolio] price fetch failed', err);
      return null;
    }),
  ]);

  const enriched: EnrichedPortfolioHolding[] = rawHoldings.map((h) => {
    const ticker = h.ticker.toUpperCase();
    const snapshot = priceCache?.prices[ticker] ?? null;
    const lastClose = snapshot?.close ?? null;
    const prevClose = snapshot?.prevClose ?? null;
    const dayChangePercent = snapshot?.dayChangePercent ?? null;
    const value = lastClose != null ? lastClose * h.shares : null;
    const sentimentScore = sentimentMap[ticker]?.score ?? 0;

    return {
      ticker,
      shares: h.shares,
      lastClose,
      prevClose,
      dayChangePercent,
      value,
      sentimentScore,
    };
  });

  const totals = computeTotals(enriched);

  const response: GetResponse = {
    holdings: enriched,
    totals,
    pricesAsOfDate: priceCache?.asOfDate ?? null,
  };
  return Response.json(response);
}

export async function PUT(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: 'Not authenticated' }, { status: 401 });
  }

  let body: PutBody;
  try {
    body = (await request.json()) as PutBody;
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!Array.isArray(body.holdings)) {
    return Response.json({ error: 'holdings array required' }, { status: 400 });
  }

  if (body.holdings.length > MAX_HOLDINGS) {
    return Response.json(
      { error: `Holdings limited to ${MAX_HOLDINGS} entries.` },
      { status: 400 },
    );
  }

  // Validate, normalize, dedupe.
  const seen = new Set<string>();
  const normalized: PortfolioHolding[] = [];
  for (const raw of body.holdings) {
    if (typeof raw !== 'object' || raw === null) {
      return Response.json({ error: 'Each holding must be an object.' }, { status: 400 });
    }
    if (typeof raw.ticker !== 'string') {
      return Response.json({ error: 'Each holding needs a string ticker.' }, { status: 400 });
    }
    const ticker = raw.ticker.trim().toUpperCase();
    if (!TICKER_PATTERN.test(ticker)) {
      return Response.json(
        { error: `Invalid ticker "${ticker}" — must be 1-10 letters.` },
        { status: 400 },
      );
    }
    const sharesNum = typeof raw.shares === 'number' ? raw.shares : Number(raw.shares);
    if (!Number.isFinite(sharesNum) || sharesNum <= 0 || sharesNum > MAX_SHARES) {
      return Response.json(
        { error: `Invalid shares for ${ticker}: must be a positive number ≤ ${MAX_SHARES}.` },
        { status: 400 },
      );
    }
    if (seen.has(ticker)) {
      return Response.json(
        { error: `Duplicate ticker ${ticker} — combine into one entry.` },
        { status: 400 },
      );
    }
    seen.add(ticker);
    normalized.push({ ticker, shares: sharesNum });
  }

  await store.setHoldings(user.id, normalized);
  return Response.json({ holdings: normalized });
}

function computeTotals(holdings: EnrichedPortfolioHolding[]): GetResponse['totals'] {
  if (holdings.length === 0) {
    return { value: null, dayChangeAmount: null, dayChangePercent: null, weightedSentiment: null };
  }

  let totalValue = 0;
  let totalPrevValue = 0;
  let weightedSentimentNumerator = 0;
  let weightedSentimentDenominator = 0;
  let anyValue = false;
  let anyPrev = false;

  for (const h of holdings) {
    if (h.value != null) {
      totalValue += h.value;
      anyValue = true;
      weightedSentimentNumerator += h.value * h.sentimentScore;
      weightedSentimentDenominator += h.value;
    }
    if (h.value != null && h.prevClose != null) {
      totalPrevValue += h.prevClose * h.shares;
      anyPrev = true;
    }
  }

  const value = anyValue ? totalValue : null;
  const dayChangeAmount = anyPrev ? totalValue - totalPrevValue : null;
  const dayChangePercent =
    anyPrev && totalPrevValue !== 0
      ? ((totalValue - totalPrevValue) / totalPrevValue) * 100
      : null;
  const weightedSentiment =
    weightedSentimentDenominator > 0
      ? weightedSentimentNumerator / weightedSentimentDenominator
      : null;

  return { value, dayChangeAmount, dayChangePercent, weightedSentiment };
}
