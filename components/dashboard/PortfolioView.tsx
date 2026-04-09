'use client';

// Portfolio view — list of holdings with end-of-day prices, day change %,
// total value, and Grok sentiment per ticker. Inline + and × controls for
// adding/removing holdings (same pattern as the watchlist editor).
//
// Backend: /api/portfolio (GET enriches with prices via lib/prices.ts)
// + /api/technicals (per-ticker BUY/SELL/NEUTRAL aggregated from SMA/EMA/
// RSI/MACD/Bollinger via lib/technicals.ts).
//
// Polygon Stocks Basic free tier — end-of-day prices only, NOT real-time.

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Plus, Wallet, X } from 'lucide-react';
import {
  CombinedBadge,
  SignalBadge,
  combineSignals,
  sentimentToSignal,
  type Signal,
  type CombinedSignal,
} from '@/components/dashboard/SignalBadge';
import {
  EarningsBadge,
  type EarningsBeatRecord,
  type NextEarnings,
} from '@/components/dashboard/EarningsBadge';
import { ERPBadge } from '@/components/dashboard/ERPBadge';
import type { EnrichedPortfolioHolding } from '@/types';

const TICKER_PATTERN = /^[A-Z]{1,10}$/;

interface PortfolioApiResponse {
  holdings: EnrichedPortfolioHolding[];
  totals: {
    value: number | null;
    dayChangeAmount: number | null;
    dayChangePercent: number | null;
    weightedSentiment: number | null;
  };
  pricesAsOfDate: string | null;
}

interface TechnicalApiResponse {
  results: Array<{
    ticker: string;
    signal: { signal: Signal } | null;
    asOfDate: string | null;
  }>;
}

interface FundamentalApiResponse {
  results: Array<{
    ticker: string;
    signal: {
      signal: Signal;
      metrics?: { equityRiskPremium?: number | null };
    } | null;
  }>;
}

interface EarningsApiResponse {
  results: Array<{
    ticker: string;
    next: NextEarnings | null;
    recentBeats: EarningsBeatRecord[];
  }>;
}

const EMPTY_TOTALS: PortfolioApiResponse['totals'] = {
  value: null,
  dayChangeAmount: null,
  dayChangePercent: null,
  weightedSentiment: null,
};

interface RowState {
  holding: EnrichedPortfolioHolding;
  technicalSignal: Signal | null;
  fundamentalSignal: Signal | null;
  equityRiskPremium: number | null;
  combined: CombinedSignal | null;
  nextEarnings: NextEarnings | null;
  recentBeats: EarningsBeatRecord[];
}

export default function PortfolioView() {
  const [rows, setRows] = useState<RowState[]>([]);
  const [totals, setTotals] = useState<PortfolioApiResponse['totals']>(EMPTY_TOTALS);
  const [pricesAsOfDate, setPricesAsOfDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newTicker, setNewTicker] = useState('');
  const [newShares, setNewShares] = useState('');
  const tickerInputRef = useRef<HTMLInputElement>(null);

  // Fetch /api/portfolio + /api/technicals + /api/fundamentals in parallel
  // and merge all three into row state.
  const refreshAll = useCallback(async () => {
    const portfolio = (await fetch('/api/portfolio').then((r) => r.json())) as PortfolioApiResponse;

    const tickers = (portfolio.holdings ?? []).map((h) => h.ticker.toUpperCase());
    const technicalMap = new Map<string, Signal | null>();
    const fundamentalMap = new Map<string, Signal | null>();
    const erpMap = new Map<string, number | null>();
    const earningsMap = new Map<string, { next: NextEarnings | null; recentBeats: EarningsBeatRecord[] }>();

    if (tickers.length > 0) {
      const tickersParam = tickers.join(',');
      const [techRes, fundRes, earningsRes] = await Promise.allSettled([
        fetch(`/api/technicals?tickers=${tickersParam}`).then((r) => r.json() as Promise<TechnicalApiResponse>),
        fetch(`/api/fundamentals?tickers=${tickersParam}`).then((r) => r.json() as Promise<FundamentalApiResponse>),
        fetch(`/api/earnings?tickers=${tickersParam}`).then((r) => r.json() as Promise<EarningsApiResponse>),
      ]);

      if (techRes.status === 'fulfilled') {
        for (const r of techRes.value.results ?? []) {
          technicalMap.set(r.ticker.toUpperCase(), r.signal?.signal ?? null);
        }
      } else {
        console.warn('[portfolio] technicals fetch failed', techRes.reason);
      }
      if (fundRes.status === 'fulfilled') {
        for (const r of fundRes.value.results ?? []) {
          const upper = r.ticker.toUpperCase();
          fundamentalMap.set(upper, r.signal?.signal ?? null);
          erpMap.set(upper, r.signal?.metrics?.equityRiskPremium ?? null);
        }
      } else {
        console.warn('[portfolio] fundamentals fetch failed', fundRes.reason);
      }
      if (earningsRes.status === 'fulfilled') {
        for (const r of earningsRes.value.results ?? []) {
          earningsMap.set(r.ticker.toUpperCase(), {
            next: r.next ?? null,
            recentBeats: r.recentBeats ?? [],
          });
        }
      } else {
        console.warn('[portfolio] earnings fetch failed', earningsRes.reason);
      }
    }

    // Sort by total value descending so the biggest position is on top.
    const sorted = [...(portfolio.holdings ?? [])].sort((a, b) => {
      const av = a.value ?? 0;
      const bv = b.value ?? 0;
      return bv - av;
    });

    const merged: RowState[] = sorted.map((h) => {
      const upper = h.ticker.toUpperCase();
      const tech = technicalMap.get(upper) ?? null;
      const fund = fundamentalMap.get(upper) ?? null;
      const erp = erpMap.get(upper) ?? null;
      const earnings = earningsMap.get(upper);
      const sentSignal = h.sentimentScore !== 0 ? sentimentToSignal(h.sentimentScore) : null;
      const combined = combineSignals(sentSignal, tech, fund);
      return {
        holding: h,
        technicalSignal: tech,
        fundamentalSignal: fund,
        equityRiskPremium: erp,
        combined,
        nextEarnings: earnings?.next ?? null,
        recentBeats: earnings?.recentBeats ?? [],
      };
    });

    setRows(merged);
    setTotals(portfolio.totals ?? EMPTY_TOTALS);
    setPricesAsOfDate(portfolio.pricesAsOfDate ?? null);
  }, []);

  // Initial load
  useEffect(() => {
    refreshAll()
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [refreshAll]);

  // Replace the entire holdings array server-side, then refetch.
  async function updateHoldings(next: Array<{ ticker: string; shares: number }>): Promise<void> {
    setMutating(true);
    setError(null);
    try {
      const res = await fetch('/api/portfolio', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ holdings: next }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      await refreshAll();
    } catch (err) {
      setError((err as Error).message);
      throw err;
    } finally {
      setMutating(false);
    }
  }

  async function addHolding(e: FormEvent) {
    e.preventDefault();
    const ticker = newTicker.trim().toUpperCase();
    const sharesNum = Number(newShares.trim());

    if (!TICKER_PATTERN.test(ticker)) {
      setError(`"${newTicker.trim()}" is not a valid ticker. Use 1-10 letters.`);
      return;
    }
    if (!Number.isFinite(sharesNum) || sharesNum <= 0) {
      setError('Shares must be a positive number.');
      return;
    }
    if (rows.some((r) => r.holding.ticker === ticker)) {
      setError(`${ticker} is already in your portfolio. Remove it first to change the share count.`);
      return;
    }

    const next = [
      ...rows.map((r) => ({ ticker: r.holding.ticker, shares: r.holding.shares })),
      { ticker, shares: sharesNum },
    ];
    try {
      await updateHoldings(next);
      setNewTicker('');
      setNewShares('');
      tickerInputRef.current?.focus();
    } catch {
      // surfaced via setError
    }
  }

  async function removeHolding(ticker: string) {
    const next = rows
      .filter((r) => r.holding.ticker !== ticker)
      .map((r) => ({ ticker: r.holding.ticker, shares: r.holding.shares }));
    try {
      await updateHoldings(next);
    } catch {
      // surfaced via setError
    }
  }

  function startAdding() {
    setAdding(true);
    setError(null);
    setTimeout(() => tickerInputRef.current?.focus(), 0);
  }

  function cancelAdding() {
    setAdding(false);
    setNewTicker('');
    setNewShares('');
    setError(null);
  }

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
      <header className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Wallet className="h-4 w-4 text-green-500" />
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
            Your Portfolio
          </h2>
        </div>
        <div className="flex items-center gap-3">
          {pricesAsOfDate && (
            <span className="text-xs text-zinc-600" title="End-of-day prices from Polygon">
              Close {pricesAsOfDate}
            </span>
          )}
          <button
            type="button"
            onClick={startAdding}
            disabled={adding || mutating || loading}
            title="Add holding"
            aria-label="Add holding"
            className="rounded-md p-1.5 text-zinc-500 transition hover:bg-zinc-900 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* Totals strip */}
      {rows.length > 0 && totals.value != null && (
        <div className="mb-4 grid grid-cols-3 gap-3 rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3">
          <Totals label="Total value" value={formatCurrency(totals.value)} />
          <Totals
            label="Day change"
            value={formatChange(totals.dayChangeAmount, totals.dayChangePercent)}
            tone={
              totals.dayChangeAmount == null
                ? 'neutral'
                : totals.dayChangeAmount > 0
                  ? 'positive'
                  : totals.dayChangeAmount < 0
                    ? 'negative'
                    : 'neutral'
            }
          />
          <Totals
            label="Sentiment"
            value={
              totals.weightedSentiment != null
                ? `${totals.weightedSentiment > 0 ? '+' : ''}${totals.weightedSentiment.toFixed(2)}`
                : '—'
            }
            tone={
              totals.weightedSentiment == null
                ? 'neutral'
                : totals.weightedSentiment > 0.1
                  ? 'positive'
                  : totals.weightedSentiment < -0.1
                    ? 'negative'
                    : 'neutral'
            }
          />
        </div>
      )}

      {adding && (
        <form onSubmit={addHolding} className="mb-3 flex items-center gap-2">
          <input
            ref={tickerInputRef}
            type="text"
            value={newTicker}
            onChange={(e) => setNewTicker(e.target.value.toUpperCase())}
            placeholder="Ticker (e.g. AAPL)"
            title="Stock symbol — 1 to 10 letters"
            disabled={mutating}
            maxLength={10}
            className="w-36 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm font-mono uppercase text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none disabled:opacity-50"
          />
          <input
            type="number"
            value={newShares}
            onChange={(e) => setNewShares(e.target.value)}
            placeholder="How many shares you own (e.g. 10)"
            title="Number of shares you own — used to calculate position value and day change. Decimals OK for fractional shares."
            disabled={mutating}
            min={0}
            step="any"
            className="flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={mutating || !newTicker.trim() || !newShares.trim()}
            className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-green-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Add
          </button>
          <button
            type="button"
            onClick={cancelAdding}
            disabled={mutating}
            className="rounded-md p-1.5 text-zinc-500 transition hover:bg-zinc-900 hover:text-zinc-200 disabled:cursor-not-allowed"
            aria-label="Cancel"
          >
            <X className="h-4 w-4" />
          </button>
        </form>
      )}

      {error && (
        <p className="mb-3 rounded-md border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-400">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-zinc-500">
          Your portfolio is empty. Click <Plus className="inline h-3 w-3" /> above to
          add a holding.
        </p>
      ) : (
        <>
          {/* Desktop table — table-fixed + explicit widths so columns stay
              compact instead of spreading to fill the full-width card. mx-auto
              centers the table within its container. */}
          <table className="mx-auto hidden table-fixed text-sm md:table">
            <colgroup>
              <col className="w-20" /> {/* Ticker */}
              <col className="w-20" /> {/* Shares */}
              <col className="w-24" /> {/* Close */}
              <col className="w-20" /> {/* Day % */}
              <col className="w-28" /> {/* Value */}
              <col className="w-24" /> {/* Sent */}
              <col className="w-24" /> {/* Tech */}
              <col className="w-24" /> {/* Fund */}
              <col className="w-32" /> {/* ERP */}
              <col className="w-32" /> {/* Combined */}
              <col className="w-24" /> {/* Earnings */}
              <col className="w-10" /> {/* × */}
            </colgroup>
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="pb-2 pr-2 text-left">Ticker</th>
                <th className="pb-2 px-2 text-right">Shares</th>
                <th className="pb-2 px-2 text-right">Close</th>
                <th className="pb-2 px-2 text-right">Day %</th>
                <th className="pb-2 px-2 text-right">Value</th>
                <th className="pb-2 px-2 text-right">Sent</th>
                <th className="pb-2 px-2 text-right">Tech</th>
                <th className="pb-2 px-2 text-right">Fund</th>
                <th className="pb-2 px-2 text-right">ERP</th>
                <th className="pb-2 px-2 text-right">Combined</th>
                <th className="pb-2 px-2 text-right">Earnings</th>
                <th className="pb-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const h = r.holding;
                const sentSig = h.sentimentScore !== 0 ? sentimentToSignal(h.sentimentScore) : null;
                return (
                  <tr key={h.ticker} className="group border-t border-zinc-800/50">
                    <td className="py-2 pr-2 font-medium">{h.ticker}</td>
                    <td className="py-2 px-2 text-right font-mono text-zinc-300">{h.shares}</td>
                    <td className="py-2 px-2 text-right font-mono text-zinc-300">
                      {h.lastClose != null ? `$${h.lastClose.toFixed(2)}` : '—'}
                    </td>
                    <td
                      className={`py-2 px-2 text-right font-mono ${
                        h.dayChangePercent == null
                          ? 'text-zinc-500'
                          : h.dayChangePercent > 0
                            ? 'text-green-400'
                            : h.dayChangePercent < 0
                              ? 'text-red-400'
                              : 'text-zinc-500'
                      }`}
                    >
                      {h.dayChangePercent != null
                        ? `${h.dayChangePercent > 0 ? '+' : ''}${h.dayChangePercent.toFixed(2)}%`
                        : '—'}
                    </td>
                    <td className="py-2 px-2 text-right font-mono text-zinc-200">
                      {h.value != null ? formatCurrency(h.value) : '—'}
                    </td>
                    <td className="py-2 px-2 text-right">
                      <SignalBadge
                        signal={sentSig}
                        title={
                          h.sentimentScore !== 0
                            ? `Sentiment score: ${h.sentimentScore.toFixed(2)}`
                            : 'No sentiment scan yet'
                        }
                      />
                    </td>
                    <td className="py-2 px-2 text-right">
                      <SignalBadge
                        signal={r.technicalSignal}
                        title={
                          r.technicalSignal
                            ? `Technical: ${r.technicalSignal} (SMA/EMA/RSI/MACD/Bollinger majority)`
                            : 'Insufficient price history'
                        }
                      />
                    </td>
                    <td className="py-2 px-2 text-right">
                      <SignalBadge
                        signal={r.fundamentalSignal}
                        title={
                          r.fundamentalSignal
                            ? `Fundamentals: ${r.fundamentalSignal} (valuation, profitability, growth, health majority)`
                            : 'No fundamentals data yet'
                        }
                      />
                    </td>
                    <td className="py-2 px-2 text-right">
                      <ERPBadge erp={r.equityRiskPremium} />
                    </td>
                    <td className="py-2 px-2 text-right">
                      <CombinedBadge signal={r.combined} />
                    </td>
                    <td className="py-2 px-2 text-right">
                      <EarningsBadge next={r.nextEarnings} recentBeats={r.recentBeats} />
                    </td>
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        onClick={() => removeHolding(h.ticker)}
                        disabled={mutating}
                        title={`Remove ${h.ticker}`}
                        aria-label={`Remove ${h.ticker} from portfolio`}
                        className="rounded p-1 text-zinc-700 opacity-0 transition hover:bg-zinc-900 hover:text-red-400 group-hover:opacity-100 disabled:cursor-not-allowed"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Mobile card layout — two rows per holding */}
          <div className="space-y-3 md:hidden">
            {rows.map((r) => {
              const h = r.holding;
              const sentSig = h.sentimentScore !== 0 ? sentimentToSignal(h.sentimentScore) : null;
              return (
                <div
                  key={h.ticker}
                  className="rounded-lg border border-zinc-800/50 bg-zinc-900/30 p-3"
                >
                  {/* Row 1: ticker + value + combined + earnings */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <p className="font-semibold text-zinc-100">{h.ticker}</p>
                      <EarningsBadge next={r.nextEarnings} recentBeats={r.recentBeats} />
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="text-right">
                        <p className="font-mono text-sm text-zinc-100">
                          {h.value != null ? formatCurrency(h.value) : '—'}
                        </p>
                        <p
                          className={`font-mono text-xs ${
                            h.dayChangePercent == null
                              ? 'text-zinc-500'
                              : h.dayChangePercent > 0
                                ? 'text-green-400'
                                : h.dayChangePercent < 0
                                  ? 'text-red-400'
                                  : 'text-zinc-500'
                          }`}
                        >
                          {h.dayChangePercent != null
                            ? `${h.dayChangePercent > 0 ? '+' : ''}${h.dayChangePercent.toFixed(2)}%`
                            : '—'}
                        </p>
                      </div>
                      <CombinedBadge signal={r.combined} />
                    </div>
                  </div>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {h.shares} {h.shares === 1 ? 'share' : 'shares'}
                  </p>
                  {/* Row 2: individual signals + remove */}
                  <div className="mt-2 flex items-center justify-between gap-2 border-t border-zinc-800/40 pt-2">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-[10px] uppercase tracking-wide text-zinc-600">
                        Sent
                      </span>
                      <SignalBadge signal={sentSig} />
                      <span className="ml-1 text-[10px] uppercase tracking-wide text-zinc-600">
                        Tech
                      </span>
                      <SignalBadge signal={r.technicalSignal} />
                      <span className="ml-1 text-[10px] uppercase tracking-wide text-zinc-600">
                        Fund
                      </span>
                      <SignalBadge signal={r.fundamentalSignal} />
                      <span className="ml-1 text-[10px] uppercase tracking-wide text-zinc-600">
                        ERP
                      </span>
                      <ERPBadge erp={r.equityRiskPremium} />
                    </div>
                    <button
                      type="button"
                      onClick={() => removeHolding(h.ticker)}
                      disabled={mutating}
                      title={`Remove ${h.ticker}`}
                      aria-label={`Remove ${h.ticker} from portfolio`}
                      className="rounded p-1 text-zinc-600 transition hover:bg-zinc-900 hover:text-red-400 disabled:cursor-not-allowed"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {rows.length > 0 && (
        <p className="mt-3 text-[11px] text-zinc-600">
          Prices are end-of-day from Polygon, not real-time. Sentiment is from Grok x_search.
          Technical signal aggregates SMA, EMA, RSI, MACD, and Bollinger Bands. Fundamental
          signal aggregates valuation, profitability, growth, and balance-sheet health from FMP
          data using absolute thresholds (not sector-relative). Combined is a majority vote
          across all three signals — informational only, <strong>not investment advice</strong>.
        </p>
      )}
    </section>
  );
}

function Totals({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'positive' | 'negative' | 'neutral';
}) {
  const toneClass =
    tone === 'positive'
      ? 'text-green-400'
      : tone === 'negative'
        ? 'text-red-400'
        : 'text-zinc-200';
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`mt-0.5 font-mono text-sm font-semibold ${toneClass}`}>{value}</p>
    </div>
  );
}

function formatCurrency(value: number): string {
  if (Math.abs(value) >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(2)}M`;
  }
  if (Math.abs(value) >= 10_000) {
    return `$${(value / 1_000).toFixed(1)}k`;
  }
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatChange(amount: number | null, percent: number | null): string {
  if (amount == null) return '—';
  const sign = amount > 0 ? '+' : amount < 0 ? '−' : '';
  const absAmount = Math.abs(amount);
  const amountStr =
    absAmount >= 1_000_000
      ? `$${(absAmount / 1_000_000).toFixed(2)}M`
      : absAmount >= 1_000
        ? `$${(absAmount / 1_000).toFixed(1)}k`
        : `$${absAmount.toFixed(2)}`;
  const percentStr = percent != null ? ` (${percent > 0 ? '+' : ''}${percent.toFixed(2)}%)` : '';
  return `${sign}${amountStr}${percentStr}`;
}
