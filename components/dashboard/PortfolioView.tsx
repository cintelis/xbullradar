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
import { ChevronDown, ChevronUp, Coins, Plus, Wallet, X } from 'lucide-react';
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
import type {
  CashCategory,
  CashHolding,
  EnrichedPortfolioHolding,
} from '@/types';

const TICKER_PATTERN = /^[A-Z]{1,10}$/;

interface PortfolioApiResponse {
  holdings: EnrichedPortfolioHolding[];
  cash: CashHolding[];
  totals: {
    value: number | null;
    equityValue: number | null;
    cashValue: number;
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
  equityValue: null,
  cashValue: 0,
  dayChangeAmount: null,
  dayChangePercent: null,
  weightedSentiment: null,
};

const CASH_CATEGORY_LABELS: Record<CashCategory, string> = {
  cash: 'Cash',
  stablecoin: 'Stablecoin',
  bond: 'Bond',
  other: 'Other',
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
  const [cash, setCash] = useState<CashHolding[]>([]);
  const [totals, setTotals] = useState<PortfolioApiResponse['totals']>(EMPTY_TOTALS);
  const [pricesAsOfDate, setPricesAsOfDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newTicker, setNewTicker] = useState('');
  const [newShares, setNewShares] = useState('');
  const tickerInputRef = useRef<HTMLInputElement>(null);

  // Cash & equivalents collapsible section state. Defaults to collapsed
  // so the section doesn't add visual clutter for users who haven't yet
  // added any cash entries — but auto-expands ONCE on the initial load
  // if we see a non-empty cash array. After that the user is in control,
  // tracked via the cashAutoExpandedRef so a refresh after editing
  // doesn't re-pop the section open.
  const [cashExpanded, setCashExpanded] = useState(false);
  const cashAutoExpandedRef = useRef(false);
  const [addingCash, setAddingCash] = useState(false);
  const [newCashLabel, setNewCashLabel] = useState('');
  const [newCashAmount, setNewCashAmount] = useState('');
  const [newCashCategory, setNewCashCategory] = useState<CashCategory>('cash');
  const cashLabelInputRef = useRef<HTMLInputElement>(null);

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
    setCash(portfolio.cash ?? []);
    if (
      !cashAutoExpandedRef.current &&
      (portfolio.cash ?? []).length > 0
    ) {
      // First load with existing cash entries → auto-expand once. After
      // this fires, cashAutoExpandedRef stays true so subsequent
      // refreshAll calls don't fight the user's manual toggle.
      cashAutoExpandedRef.current = true;
      setCashExpanded(true);
    }
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

  // Replace the entire cash array server-side, then refetch.
  async function updateCash(next: CashHolding[]): Promise<void> {
    setMutating(true);
    setError(null);
    try {
      const res = await fetch('/api/portfolio', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cash: next }),
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

  async function addCashEntry(e: FormEvent) {
    e.preventDefault();
    const label = newCashLabel.trim();
    const amount = Number(newCashAmount.trim());

    if (!label) {
      setError('Cash entry needs a label.');
      return;
    }
    if (!Number.isFinite(amount) || amount < 0) {
      setError('Cash amount must be a non-negative number.');
      return;
    }

    const next: CashHolding[] = [
      ...cash,
      {
        // Random id is fine — we don't need cryptographic uniqueness, just
        // a stable React key + a way to address the entry on remove.
        id: `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        label,
        amount,
        category: newCashCategory,
      },
    ];
    try {
      await updateCash(next);
      setNewCashLabel('');
      setNewCashAmount('');
      // Keep the same category selected so adding multiple stablecoin
      // entries in a row doesn't require re-picking the dropdown.
      cashLabelInputRef.current?.focus();
    } catch {
      // surfaced via setError
    }
  }

  async function removeCashEntry(id: string) {
    const next = cash.filter((c) => c.id !== id);
    try {
      await updateCash(next);
    } catch {
      // surfaced via setError
    }
  }

  function startAddingCash() {
    setAddingCash(true);
    setCashExpanded(true);
    setError(null);
    setTimeout(() => cashLabelInputRef.current?.focus(), 0);
  }

  function cancelAddingCash() {
    setAddingCash(false);
    setNewCashLabel('');
    setNewCashAmount('');
    setError(null);
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

      {/* Totals strip — value-weighted aggregates across the portfolio.
          ERP is the "Fed Model applied to a portfolio" — tells you whether
          your equity exposure as a whole is well-compensated vs holding
          treasuries. Same thresholds as the per-stock ERP badge:
          > 4% CHEAP, 2-4% FAIR, < 2% RICH. */}
      {(rows.length > 0 || cash.length > 0) && totals.value != null && (() => {
        const portfolioERP = computeWeightedErp(rows, cash);
        return (
          <div className="mb-4 grid grid-cols-2 gap-3 rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3 md:grid-cols-4">
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
              label="Portfolio ERP"
              title="Value-weighted Equity Risk Premium across all holdings (Fed Model). Above 4% = cheap vs bonds, 2-4% = fair, below 2% = rich. Cash and holdings without P/E are excluded."
              value={
                portfolioERP != null
                  ? `${portfolioERP >= 0 ? '+' : ''}${portfolioERP.toFixed(1)}%`
                  : '—'
              }
              tone={
                portfolioERP == null
                  ? 'neutral'
                  : portfolioERP > 4
                    ? 'positive'
                    : portfolioERP < 2
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
        );
      })()}

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
      ) : rows.length === 0 && cash.length === 0 ? (
        <p className="text-sm text-zinc-500">
          Your portfolio is empty. Click <Plus className="inline h-3 w-3" /> above to
          add a holding, or open the Cash & Equivalents section below to add cash.
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

      {/* Cash & Equivalents — collapsible section. Always rendered (even
          when empty) so the user has a clear way to start adding cash.
          Defaults collapsed; auto-expands if there are existing entries
          (handled in refreshAll). */}
      <CashSection
        cash={cash}
        expanded={cashExpanded}
        onToggle={() => setCashExpanded((v) => !v)}
        adding={addingCash}
        mutating={mutating}
        loading={loading}
        newCashLabel={newCashLabel}
        newCashAmount={newCashAmount}
        newCashCategory={newCashCategory}
        labelInputRef={cashLabelInputRef}
        onLabelChange={setNewCashLabel}
        onAmountChange={setNewCashAmount}
        onCategoryChange={setNewCashCategory}
        onStartAdding={startAddingCash}
        onCancelAdding={cancelAddingCash}
        onSubmit={addCashEntry}
        onRemove={removeCashEntry}
        totalCashValue={totals.cashValue}
        totalValue={totals.value}
      />

      {(rows.length > 0 || cash.length > 0) && (
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
  title,
}: {
  label: string;
  value: string;
  tone?: 'positive' | 'negative' | 'neutral';
  /** Optional native tooltip explaining what the metric is. */
  title?: string;
}) {
  const toneClass =
    tone === 'positive'
      ? 'text-green-400'
      : tone === 'negative'
        ? 'text-red-400'
        : 'text-zinc-200';
  return (
    <div title={title}>
      <p className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`mt-0.5 font-mono text-sm font-semibold ${toneClass}`}>{value}</p>
    </div>
  );
}

/**
 * Value-weighted Equity Risk Premium across the portfolio.
 *
 * Equity holdings contribute their value × ERP to the numerator and value
 * to the denominator (only when ERP is defined — names with no P/E are
 * skipped from both sides).
 *
 * Cash entries contribute 0 to the numerator (cash earns approximately
 * the risk-free rate, so its ERP is ~0) but their full value to the
 * denominator. This is the right behaviour: a cash-heavy portfolio
 * shows a diluted ERP that correctly reflects "you're not actually
 * being compensated for risk on most of your book".
 *
 * Returns null if both denominators are zero (no equity with ERP and
 * no cash).
 */
// ─── Cash & Equivalents collapsible section ─────────────────────────────

interface CashSectionProps {
  cash: CashHolding[];
  expanded: boolean;
  onToggle: () => void;
  adding: boolean;
  mutating: boolean;
  loading: boolean;
  newCashLabel: string;
  newCashAmount: string;
  newCashCategory: CashCategory;
  labelInputRef: React.RefObject<HTMLInputElement | null>;
  onLabelChange: (v: string) => void;
  onAmountChange: (v: string) => void;
  onCategoryChange: (v: CashCategory) => void;
  onStartAdding: () => void;
  onCancelAdding: () => void;
  onSubmit: (e: FormEvent) => void;
  onRemove: (id: string) => void;
  totalCashValue: number;
  totalValue: number | null;
}

function CashSection(props: CashSectionProps) {
  const {
    cash,
    expanded,
    onToggle,
    adding,
    mutating,
    loading,
    newCashLabel,
    newCashAmount,
    newCashCategory,
    labelInputRef,
    onLabelChange,
    onAmountChange,
    onCategoryChange,
    onStartAdding,
    onCancelAdding,
    onSubmit,
    onRemove,
    totalCashValue,
    totalValue,
  } = props;

  const cashAllocPct =
    totalValue != null && totalValue > 0 && totalCashValue > 0
      ? (totalCashValue / totalValue) * 100
      : null;

  return (
    <div className="mt-4 rounded-lg border border-zinc-800/60 bg-zinc-900/30">
      {/* Collapsible header — click anywhere on the row toggles expand. */}
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-zinc-900/50"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2">
          <Coins className="h-4 w-4 text-amber-500" />
          <span className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
            Cash & Equivalents
          </span>
          {cash.length > 0 && (
            <span className="rounded-full bg-zinc-800 px-2 py-0.5 font-mono text-[10px] text-zinc-400">
              {cash.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {totalCashValue > 0 && (
            <span className="font-mono text-xs text-zinc-300">
              {formatCurrency(totalCashValue)}
              {cashAllocPct != null && (
                <span className="ml-1 text-zinc-600">
                  ({cashAllocPct.toFixed(0)}%)
                </span>
              )}
            </span>
          )}
          {expanded ? (
            <ChevronUp className="h-4 w-4 text-zinc-500" />
          ) : (
            <ChevronDown className="h-4 w-4 text-zinc-500" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-zinc-800/60 p-4">
          {/* Add row + add form */}
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs text-zinc-500">
              Cash, stablecoins, bond holdings, or anything that earns roughly the
              risk-free rate.
            </p>
            {!adding && (
              <button
                type="button"
                onClick={onStartAdding}
                disabled={mutating || loading}
                title="Add cash entry"
                aria-label="Add cash entry"
                className="rounded-md p-1.5 text-zinc-500 transition hover:bg-zinc-900 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-30"
              >
                <Plus className="h-4 w-4" />
              </button>
            )}
          </div>

          {adding && (
            <form onSubmit={onSubmit} className="mb-3 flex flex-wrap items-center gap-2">
              <input
                ref={labelInputRef}
                type="text"
                value={newCashLabel}
                onChange={(e) => onLabelChange(e.target.value)}
                placeholder="Label (e.g. Schwab brokerage)"
                title="Where this cash lives — for your own reference."
                disabled={mutating}
                maxLength={60}
                className="min-w-40 flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none disabled:opacity-50"
              />
              <input
                type="number"
                value={newCashAmount}
                onChange={(e) => onAmountChange(e.target.value)}
                placeholder="Amount in USD"
                title="USD value of this entry."
                disabled={mutating}
                min={0}
                step="any"
                className="w-36 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none disabled:opacity-50"
              />
              <select
                value={newCashCategory}
                onChange={(e) => onCategoryChange(e.target.value as CashCategory)}
                disabled={mutating}
                title="Category — for grouping in the export and the bot snapshot."
                className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 focus:border-zinc-600 focus:outline-none disabled:opacity-50"
              >
                <option value="cash">Cash</option>
                <option value="stablecoin">Stablecoin</option>
                <option value="bond">Bond</option>
                <option value="other">Other</option>
              </select>
              <button
                type="submit"
                disabled={mutating || !newCashLabel.trim() || !newCashAmount.trim()}
                className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-green-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Add
              </button>
              <button
                type="button"
                onClick={onCancelAdding}
                disabled={mutating}
                className="rounded-md p-1.5 text-zinc-500 transition hover:bg-zinc-900 hover:text-zinc-200 disabled:cursor-not-allowed"
                aria-label="Cancel"
              >
                <X className="h-4 w-4" />
              </button>
            </form>
          )}

          {cash.length === 0 ? (
            <p className="text-xs text-zinc-600">
              No cash entries yet. Add one to dilute the Portfolio ERP correctly
              and give the chat bot a complete picture of your allocation.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-800/50">
              {cash.map((c) => {
                const pct =
                  totalValue != null && totalValue > 0
                    ? (c.amount / totalValue) * 100
                    : null;
                return (
                  <li
                    key={c.id}
                    className="group flex items-center justify-between gap-3 py-2 text-sm"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <span
                        className="rounded-md border border-zinc-800 bg-zinc-900/60 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-zinc-400"
                        title={`Category: ${CASH_CATEGORY_LABELS[c.category]}`}
                      >
                        {CASH_CATEGORY_LABELS[c.category]}
                      </span>
                      <span className="truncate text-zinc-200">{c.label}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-zinc-200">
                        {formatCurrency(c.amount)}
                      </span>
                      {pct != null && (
                        <span className="font-mono text-xs text-zinc-600">
                          {pct.toFixed(1)}%
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => onRemove(c.id)}
                        disabled={mutating}
                        title={`Remove ${c.label}`}
                        aria-label={`Remove ${c.label}`}
                        className="rounded p-1 text-zinc-700 opacity-0 transition hover:bg-zinc-900 hover:text-red-400 group-hover:opacity-100 disabled:cursor-not-allowed"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function computeWeightedErp(
  rows: RowState[],
  cash: CashHolding[],
): number | null {
  let numerator = 0;
  let denominator = 0;
  for (const r of rows) {
    if (r.holding.value != null && r.equityRiskPremium != null) {
      numerator += r.holding.value * r.equityRiskPremium;
      denominator += r.holding.value;
    }
  }
  for (const c of cash) {
    // Cash contributes 0 × value to numerator (omitted) and value to denominator.
    denominator += c.amount;
  }
  return denominator > 0 ? numerator / denominator : null;
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
