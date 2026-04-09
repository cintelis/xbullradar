import { NextRequest } from 'next/server';
import { store } from '@/lib/store';
import { getCurrentUser } from '@/lib/auth';
import { getDailyPrices } from '@/lib/prices';
import type {
  CashCategory,
  CashHolding,
  EnrichedPortfolioHolding,
  PortfolioHolding,
} from '@/types';

export const runtime = 'nodejs';

const TICKER_PATTERN = /^[A-Z]{1,10}$/;
const MAX_HOLDINGS = 50;
const MAX_SHARES = 1_000_000_000;
const MAX_CASH_ENTRIES = 50;
const MAX_CASH_AMOUNT = 1_000_000_000_000; // $1T cap, more than any individual user
const MAX_LABEL_LENGTH = 60;
const VALID_CASH_CATEGORIES: ReadonlySet<CashCategory> = new Set([
  'cash',
  'stablecoin',
  'bond',
  'other',
]);

interface PutBody {
  holdings?: Array<{ ticker?: unknown; shares?: unknown }>;
  cash?: Array<{
    id?: unknown;
    label?: unknown;
    amount?: unknown;
    category?: unknown;
  }>;
}

interface GetResponse {
  holdings: EnrichedPortfolioHolding[];
  cash: CashHolding[];
  totals: {
    /**
     * Total of equity holdings + cash. Null only if NO holding has a
     * known price AND there are no cash entries — i.e. truly nothing
     * to value.
     */
    value: number | null;
    /** Equity-only value, separate from cash, for the UI breakdown. */
    equityValue: number | null;
    /** Total cash + stablecoin + bond + other. 0 if no cash entries. */
    cashValue: number;
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

  const [rawHoldings, rawCash, sentimentMap, priceCache] = await Promise.all([
    store.getHoldings(user.id),
    store.getCash(user.id),
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

  const totals = computeTotals(enriched, rawCash);

  const response: GetResponse = {
    holdings: enriched,
    cash: rawCash,
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

  // Caller can update holdings, cash, or both. Either field is optional;
  // omitting one means "leave it alone". Sending an empty array means
  // "set this to empty" (e.g. user removed their last holding/cash entry).
  if (body.holdings === undefined && body.cash === undefined) {
    return Response.json(
      { error: 'Provide holdings array, cash array, or both.' },
      { status: 400 },
    );
  }

  let normalizedHoldings: PortfolioHolding[] | null = null;
  if (body.holdings !== undefined) {
    if (!Array.isArray(body.holdings)) {
      return Response.json({ error: 'holdings must be an array' }, { status: 400 });
    }
    if (body.holdings.length > MAX_HOLDINGS) {
      return Response.json(
        { error: `Holdings limited to ${MAX_HOLDINGS} entries.` },
        { status: 400 },
      );
    }
    const result = validateHoldings(body.holdings);
    if ('error' in result) {
      return Response.json({ error: result.error }, { status: 400 });
    }
    normalizedHoldings = result.holdings;
  }

  let normalizedCash: CashHolding[] | null = null;
  if (body.cash !== undefined) {
    if (!Array.isArray(body.cash)) {
      return Response.json({ error: 'cash must be an array' }, { status: 400 });
    }
    if (body.cash.length > MAX_CASH_ENTRIES) {
      return Response.json(
        { error: `Cash entries limited to ${MAX_CASH_ENTRIES}.` },
        { status: 400 },
      );
    }
    const result = validateCash(body.cash);
    if ('error' in result) {
      return Response.json({ error: result.error }, { status: 400 });
    }
    normalizedCash = result.cash;
  }

  // Persist whichever fields were provided. Both writes are best-effort
  // independent — if cash succeeds and holdings fails, the user keeps
  // the cash update. Acceptable for a non-financial app where neither
  // field has critical consistency requirements.
  if (normalizedHoldings !== null) {
    await store.setHoldings(user.id, normalizedHoldings);
  }
  if (normalizedCash !== null) {
    await store.setCash(user.id, normalizedCash);
  }

  return Response.json({
    holdings: normalizedHoldings ?? undefined,
    cash: normalizedCash ?? undefined,
  });
}

function validateHoldings(
  raw: NonNullable<PutBody['holdings']>,
): { holdings: PortfolioHolding[] } | { error: string } {
  const seen = new Set<string>();
  const normalized: PortfolioHolding[] = [];
  for (const r of raw) {
    if (typeof r !== 'object' || r === null) {
      return { error: 'Each holding must be an object.' };
    }
    if (typeof r.ticker !== 'string') {
      return { error: 'Each holding needs a string ticker.' };
    }
    const ticker = r.ticker.trim().toUpperCase();
    if (!TICKER_PATTERN.test(ticker)) {
      return { error: `Invalid ticker "${ticker}" — must be 1-10 letters.` };
    }
    const sharesNum = typeof r.shares === 'number' ? r.shares : Number(r.shares);
    if (!Number.isFinite(sharesNum) || sharesNum <= 0 || sharesNum > MAX_SHARES) {
      return {
        error: `Invalid shares for ${ticker}: must be a positive number ≤ ${MAX_SHARES}.`,
      };
    }
    if (seen.has(ticker)) {
      return { error: `Duplicate ticker ${ticker} — combine into one entry.` };
    }
    seen.add(ticker);
    normalized.push({ ticker, shares: sharesNum });
  }
  return { holdings: normalized };
}

function validateCash(
  raw: NonNullable<PutBody['cash']>,
): { cash: CashHolding[] } | { error: string } {
  const seenIds = new Set<string>();
  const normalized: CashHolding[] = [];
  for (const r of raw) {
    if (typeof r !== 'object' || r === null) {
      return { error: 'Each cash entry must be an object.' };
    }
    const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : null;
    if (!id) {
      return { error: 'Each cash entry needs a string id.' };
    }
    if (seenIds.has(id)) {
      return { error: `Duplicate cash entry id ${id}.` };
    }
    seenIds.add(id);

    const label =
      typeof r.label === 'string' ? r.label.trim().slice(0, MAX_LABEL_LENGTH) : '';
    if (!label) {
      return { error: 'Each cash entry needs a non-empty label.' };
    }

    const amountNum = typeof r.amount === 'number' ? r.amount : Number(r.amount);
    if (
      !Number.isFinite(amountNum) ||
      amountNum < 0 ||
      amountNum > MAX_CASH_AMOUNT
    ) {
      return {
        error: `Invalid amount for "${label}" — must be a non-negative number.`,
      };
    }

    const category = r.category;
    if (
      typeof category !== 'string' ||
      !VALID_CASH_CATEGORIES.has(category as CashCategory)
    ) {
      return {
        error: `Invalid category for "${label}" — must be cash, stablecoin, bond, or other.`,
      };
    }

    normalized.push({
      id,
      label,
      amount: amountNum,
      category: category as CashCategory,
    });
  }
  return { cash: normalized };
}

function computeTotals(
  holdings: EnrichedPortfolioHolding[],
  cash: CashHolding[],
): GetResponse['totals'] {
  if (holdings.length === 0 && cash.length === 0) {
    return {
      value: null,
      equityValue: null,
      cashValue: 0,
      dayChangeAmount: null,
      dayChangePercent: null,
      weightedSentiment: null,
    };
  }

  let totalEquityValue = 0;
  let totalPrevValue = 0;
  let weightedSentimentNumerator = 0;
  let weightedSentimentDenominator = 0;
  let anyEquityValue = false;
  let anyPrev = false;

  for (const h of holdings) {
    if (h.value != null) {
      totalEquityValue += h.value;
      anyEquityValue = true;
      weightedSentimentNumerator += h.value * h.sentimentScore;
      weightedSentimentDenominator += h.value;
    }
    if (h.value != null && h.prevClose != null) {
      totalPrevValue += h.prevClose * h.shares;
      anyPrev = true;
    }
  }

  // Cash totals — straightforward sum, no day-change because cash doesn't
  // have a quoted price. Cash contributes 0 to sentiment numerator (no
  // sentiment) but still counts in the denominator so a cash-heavy
  // portfolio shows a diluted (more conservative) sentiment number.
  let cashValue = 0;
  for (const c of cash) {
    cashValue += c.amount;
    weightedSentimentDenominator += c.amount;
    // Sentiment numerator gets 0 contribution — cash has no opinion.
  }

  const equityValue = anyEquityValue ? totalEquityValue : null;
  // Total value: equity + cash. Prefer to show *something* if either
  // half is known, only return null if BOTH are missing.
  const value =
    anyEquityValue || cashValue > 0
      ? (anyEquityValue ? totalEquityValue : 0) + cashValue
      : null;

  // Day change is equity-only — cash doesn't move day-over-day.
  const dayChangeAmount = anyPrev ? totalEquityValue - totalPrevValue : null;
  const dayChangePercent =
    anyPrev && totalPrevValue !== 0
      ? ((totalEquityValue - totalPrevValue) / totalPrevValue) * 100
      : null;

  const weightedSentiment =
    weightedSentimentDenominator > 0
      ? weightedSentimentNumerator / weightedSentimentDenominator
      : null;

  return {
    value,
    equityValue,
    cashValue,
    dayChangeAmount,
    dayChangePercent,
    weightedSentiment,
  };
}
