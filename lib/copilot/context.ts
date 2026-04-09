// Portfolio context loader for the co-pilot bot. Builds a compact text
// snapshot of the user's holdings + cached signals (ERP, fundamental,
// technical, earnings, sentiment) so the conversational bot — text or
// voice — can reason over the user's actual positions instead of
// speaking in generalities.
//
// All data comes from per-ticker caches that are warmed nightly by the
// daily scan cron, so this is fast in practice (~150-300ms for a 10-stock
// portfolio). Cold cache hits are slower but rare.

import { store } from '@/lib/store';
import { getDailyPrices, getHistoricalCloses } from '@/lib/prices';
import { getFundamentalSignal } from '@/lib/fundamentals';
import { computeTechnicalSignal } from '@/lib/technicals';
import {
  getEarnings,
  getNextEarnings,
  getEarningsBeatRate,
} from '@/lib/earnings';

/**
 * Returns a markdown-formatted portfolio snapshot, or null if the user
 * has no holdings (the bot can still answer general questions in that
 * case).
 *
 * Token cost is roughly 80-120 tokens per holding, so a 10-stock
 * portfolio adds ~1k tokens to each conversational turn — cheap on Grok 4.
 */
export async function loadPortfolioContext(userId: string): Promise<string | null> {
  const [holdings, sentimentMap, prices] = await Promise.all([
    store.getHoldings(userId),
    store.getAllLastSentiments(userId),
    getDailyPrices().catch(() => null),
  ]);

  if (holdings.length === 0) return null;

  const enriched = await Promise.all(
    holdings.map(async (h) => {
      const ticker = h.ticker.toUpperCase();
      const [fund, history, earnings] = await Promise.all([
        getFundamentalSignal(ticker).catch(() => null),
        getHistoricalCloses(ticker).catch(() => null),
        getEarnings(ticker).catch(() => null),
      ]);
      const tech =
        history && history.closes.length > 0
          ? computeTechnicalSignal(history.closes)
          : null;
      const snapshot = prices?.prices[ticker] ?? null;
      const next = getNextEarnings(earnings);
      const beatRate = getEarningsBeatRate(earnings);
      const sent = sentimentMap[ticker]?.score ?? 0;
      return {
        ticker,
        shares: h.shares,
        close: snapshot?.close ?? null,
        dayChangePercent: snapshot?.dayChangePercent ?? null,
        sentiment: sent,
        fund,
        tech,
        nextEarningsDate: next?.date ?? null,
        beatRate,
      };
    }),
  );

  // Sort by position value descending so the biggest holdings appear
  // first — that's what the bot should anchor on when prioritizing.
  enriched.sort((a, b) => {
    const av = (a.close ?? 0) * a.shares;
    const bv = (b.close ?? 0) * b.shares;
    return bv - av;
  });

  let totalValue = 0;
  for (const r of enriched) {
    if (r.close != null) totalValue += r.close * r.shares;
  }

  const lines: string[] = [];
  lines.push('## Current portfolio snapshot');
  lines.push('');
  if (totalValue > 0) {
    lines.push(`Total portfolio value: $${formatNum(totalValue)}`);
    lines.push('');
  }
  lines.push('Holdings (sorted by position value):');
  for (const r of enriched) {
    const value = r.close != null ? r.close * r.shares : null;
    const pct = value != null && totalValue > 0 ? (value / totalValue) * 100 : null;
    const peStr = r.fund?.metrics.peRatio?.toFixed(1) ?? '—';
    const erp = r.fund?.metrics.equityRiskPremium;
    const erpStr =
      erp != null ? `${erp >= 0 ? '+' : ''}${erp.toFixed(1)}%` : '—';
    const fundStr = r.fund?.signal ?? '—';
    const techStr = r.tech?.signal ?? '—';
    const sentStr = r.sentiment !== 0 ? r.sentiment.toFixed(2) : 'unscored';
    const earningsStr = r.nextEarningsDate
      ? `next earnings ${r.nextEarningsDate}`
      : 'no upcoming earnings';
    const beatStr =
      r.beatRate != null ? `, ${Math.round(r.beatRate * 100)}% beat rate` : '';
    const dayStr =
      r.dayChangePercent != null
        ? ` day ${r.dayChangePercent > 0 ? '+' : ''}${r.dayChangePercent.toFixed(2)}%`
        : '';
    const closeStr = r.close != null ? ` @ $${r.close.toFixed(2)}` : '';
    const valueStr =
      value != null
        ? ` value $${formatNum(value)}${pct != null ? ` (${pct.toFixed(1)}% of book)` : ''}`
        : '';

    lines.push(
      `- ${r.ticker}: ${r.shares} sh${closeStr}${valueStr}${dayStr}`,
    );
    lines.push(
      `  P/E ${peStr}, ERP ${erpStr}, Fund ${fundStr}, Tech ${techStr}, sentiment ${sentStr}, ${earningsStr}${beatStr}`,
    );
  }

  return lines.join('\n');
}

function formatNum(value: number): string {
  if (Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return value.toFixed(0);
}
