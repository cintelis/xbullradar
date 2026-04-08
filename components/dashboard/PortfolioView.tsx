'use client';

// Portfolio view — list of holdings with end-of-day prices, day change %,
// total value, and Grok sentiment per ticker. Inline + and × controls for
// adding/removing holdings (same pattern as the watchlist editor).
//
// Backend: /api/portfolio (GET enriches with prices via lib/prices.ts).
// Polygon Stocks Basic free tier — end-of-day prices only, NOT real-time.

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Plus, Wallet, X } from 'lucide-react';
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

const EMPTY_TOTALS: PortfolioApiResponse['totals'] = {
  value: null,
  dayChangeAmount: null,
  dayChangePercent: null,
  weightedSentiment: null,
};

export default function PortfolioView() {
  const [holdings, setHoldings] = useState<EnrichedPortfolioHolding[]>([]);
  const [totals, setTotals] = useState<PortfolioApiResponse['totals']>(EMPTY_TOTALS);
  const [pricesAsOfDate, setPricesAsOfDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newTicker, setNewTicker] = useState('');
  const [newShares, setNewShares] = useState('');
  const tickerInputRef = useRef<HTMLInputElement>(null);

  const applyResponse = useCallback((data: PortfolioApiResponse) => {
    // Sort by total value descending so the biggest position is on top.
    const sorted = [...(data.holdings ?? [])].sort((a, b) => {
      const av = a.value ?? 0;
      const bv = b.value ?? 0;
      return bv - av;
    });
    setHoldings(sorted);
    setTotals(data.totals ?? EMPTY_TOTALS);
    setPricesAsOfDate(data.pricesAsOfDate ?? null);
  }, []);

  // Initial load.
  useEffect(() => {
    fetch('/api/portfolio')
      .then((r) => r.json())
      .then((data) => applyResponse(data as PortfolioApiResponse))
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [applyResponse]);

  // Replace the entire holdings array server-side, then refetch the
  // enriched view so prices/totals stay in sync.
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
      // PUT returns just { holdings }; refetch GET to get enrichment + totals.
      const enriched = await fetch('/api/portfolio').then((r) => r.json());
      applyResponse(enriched as PortfolioApiResponse);
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
    if (holdings.some((h) => h.ticker === ticker)) {
      setError(`${ticker} is already in your portfolio. Remove it first to change the share count.`);
      return;
    }

    const next = [
      ...holdings.map((h) => ({ ticker: h.ticker, shares: h.shares })),
      { ticker, shares: sharesNum },
    ];
    try {
      await updateHoldings(next);
      setNewTicker('');
      setNewShares('');
      tickerInputRef.current?.focus();
    } catch {
      // Error surfaced via setError in updateHoldings.
    }
  }

  async function removeHolding(ticker: string) {
    const next = holdings
      .filter((h) => h.ticker !== ticker)
      .map((h) => ({ ticker: h.ticker, shares: h.shares }));
    try {
      await updateHoldings(next);
    } catch {
      // Error surfaced via setError.
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

      {/* Totals strip — only shown when there are holdings with prices. */}
      {holdings.length > 0 && totals.value != null && (
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
            placeholder="Ticker"
            disabled={mutating}
            maxLength={10}
            className="w-24 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm font-mono uppercase text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none disabled:opacity-50"
          />
          <input
            type="number"
            value={newShares}
            onChange={(e) => setNewShares(e.target.value)}
            placeholder="Shares"
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
      ) : holdings.length === 0 ? (
        <p className="text-sm text-zinc-500">
          Your portfolio is empty. Click <Plus className="inline h-3 w-3" /> above to
          add a holding.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-xs text-zinc-500">
            <tr>
              <th className="pb-2 text-left">Ticker</th>
              <th className="pb-2 text-right">Shares</th>
              <th className="pb-2 text-right">Close</th>
              <th className="pb-2 text-right">Day %</th>
              <th className="pb-2 text-right">Value</th>
              <th className="pb-2 text-right">Sentiment</th>
              <th className="pb-2"></th>
            </tr>
          </thead>
          <tbody>
            {holdings.map((h) => (
              <tr key={h.ticker} className="group border-t border-zinc-800/50">
                <td className="py-2 font-medium">{h.ticker}</td>
                <td className="py-2 text-right font-mono text-zinc-300">{h.shares}</td>
                <td className="py-2 text-right font-mono text-zinc-300">
                  {h.lastClose != null ? `$${h.lastClose.toFixed(2)}` : '—'}
                </td>
                <td
                  className={`py-2 text-right font-mono ${
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
                <td className="py-2 text-right font-mono text-zinc-200">
                  {h.value != null ? formatCurrency(h.value) : '—'}
                </td>
                <td
                  className={`py-2 text-right font-mono ${
                    h.sentimentScore > 0
                      ? 'text-green-400'
                      : h.sentimentScore < 0
                        ? 'text-red-400'
                        : 'text-zinc-500'
                  }`}
                >
                  {h.sentimentScore !== 0
                    ? `${h.sentimentScore > 0 ? '+' : ''}${h.sentimentScore.toFixed(2)}`
                    : '—'}
                </td>
                <td className="py-2 pl-2 text-right">
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
            ))}
          </tbody>
        </table>
      )}

      {holdings.length > 0 && (
        <p className="mt-3 text-[11px] text-zinc-600">
          Prices are end-of-day from Polygon, not real-time. Sentiment is from your
          watchlist scan. xBullRadar is a sentiment dashboard, not a brokerage.
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
