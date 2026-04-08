'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Plus, RefreshCw, TrendingUp, X } from 'lucide-react';
import {
  CombinedBadge,
  SignalBadge,
  combineSignals,
  sentimentToSignal,
  type Signal,
  type CombinedSignal,
} from '@/components/dashboard/SignalBadge';
import type { StockSentiment } from '@/types';

const TICKER_PATTERN = /^[A-Z]{1,10}$/;

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
    signal: { signal: Signal } | null;
  }>;
}

interface RowState {
  sentiment: StockSentiment;
  technicalSignal: Signal | null;
  fundamentalSignal: Signal | null;
  combined: CombinedSignal | null;
}

export default function TrendingStocks() {
  const [rows, setRows] = useState<RowState[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newTicker, setNewTicker] = useState('');
  const addInputRef = useRef<HTMLInputElement>(null);

  const mergeRows = useCallback(
    (
      sentiments: StockSentiment[],
      technicalMap: Map<string, Signal | null>,
      fundamentalMap: Map<string, Signal | null>,
    ): RowState[] => {
      // Sort by absolute sentiment score so the most "interesting" movement
      // (in either direction) lands at the top.
      const sorted = [...sentiments].sort(
        (a, b) => Math.abs(b.score) - Math.abs(a.score),
      );
      return sorted.map((s) => {
        const upper = s.ticker.toUpperCase();
        const tech = technicalMap.get(upper) ?? null;
        const fund = fundamentalMap.get(upper) ?? null;
        const sentSignal = s.score !== 0 ? sentimentToSignal(s.score) : null;
        return {
          sentiment: s,
          technicalSignal: tech,
          fundamentalSignal: fund,
          combined: combineSignals(sentSignal, tech, fund),
        };
      });
    },
    [],
  );

  // Fetch /api/technicals + /api/fundamentals in parallel for the given
  // ticker set, returning two maps the merge step uses.
  const fetchSignals = useCallback(async (tickers: string[]) => {
    const techMap = new Map<string, Signal | null>();
    const fundMap = new Map<string, Signal | null>();
    if (tickers.length === 0) return { techMap, fundMap };
    const tickersParam = tickers.join(',');
    const [techRes, fundRes] = await Promise.allSettled([
      fetch(`/api/technicals?tickers=${tickersParam}`).then((r) => r.json() as Promise<TechnicalApiResponse>),
      fetch(`/api/fundamentals?tickers=${tickersParam}`).then((r) => r.json() as Promise<FundamentalApiResponse>),
    ]);
    if (techRes.status === 'fulfilled') {
      for (const r of techRes.value.results ?? []) {
        techMap.set(r.ticker.toUpperCase(), r.signal?.signal ?? null);
      }
    } else {
      console.warn('[trending] technicals fetch failed', techRes.reason);
    }
    if (fundRes.status === 'fulfilled') {
      for (const r of fundRes.value.results ?? []) {
        fundMap.set(r.ticker.toUpperCase(), r.signal?.signal ?? null);
      }
    } else {
      console.warn('[trending] fundamentals fetch failed', fundRes.reason);
    }
    return { techMap, fundMap };
  }, []);

  // Initial load: cheap GET reads last-known scores from disk (no Grok call).
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/sentiment/batch');
        const data = await res.json();
        const sentiments: StockSentiment[] = data.results ?? [];
        const tickers = sentiments.map((s) => s.ticker.toUpperCase());
        const { techMap, fundMap } = await fetchSignals(tickers);
        setRows(mergeRows(sentiments, techMap, fundMap));
        if (sentiments.some((r) => r.score !== 0)) {
          setLastUpdated(new Date());
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [fetchSignals, mergeRows]);

  // Manual refresh: POST triggers a real Grok batch call and persists results
  // server-side. Costs ~one batch call + one x_search invocation. Then re-pull
  // signals for the (possibly new) ticker set.
  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch('/api/sentiment/batch', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      const sentiments: StockSentiment[] = data.results ?? [];
      const tickers = sentiments.map((s) => s.ticker.toUpperCase());
      const { techMap, fundMap } = await fetchSignals(tickers);
      setRows(mergeRows(sentiments, techMap, fundMap));
      setLastUpdated(new Date());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  // Reload sentiment+signals data without triggering a Grok call. Used
  // after mutating the watchlist so the table reflects the new shape.
  async function reloadSentiment() {
    const res = await fetch('/api/sentiment/batch');
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    const sentiments: StockSentiment[] = data.results ?? [];
    const tickers = sentiments.map((s) => s.ticker.toUpperCase());
    const { techMap, fundMap } = await fetchSignals(tickers);
    setRows(mergeRows(sentiments, techMap, fundMap));
  }

  // Replace the entire watchlist server-side, then refetch the table data.
  async function updateWatchlist(tickers: string[]): Promise<void> {
    setMutating(true);
    setError(null);
    try {
      const res = await fetch('/api/watchlist', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tickers }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      await reloadSentiment();
    } catch (err) {
      setError((err as Error).message);
      throw err;
    } finally {
      setMutating(false);
    }
  }

  async function addTicker(e: FormEvent) {
    e.preventDefault();
    const ticker = newTicker.trim().toUpperCase();
    if (!ticker) return;
    if (!TICKER_PATTERN.test(ticker)) {
      setError(`"${newTicker.trim()}" is not a valid ticker. Use 1-10 letters only.`);
      return;
    }
    if (rows.some((r) => r.sentiment.ticker === ticker)) {
      setError(`${ticker} is already in your watchlist.`);
      return;
    }

    const newList = [...rows.map((r) => r.sentiment.ticker), ticker];
    try {
      await updateWatchlist(newList);
      setNewTicker('');
      addInputRef.current?.focus();
    } catch {
      // surfaced via setError
    }
  }

  async function removeTicker(ticker: string) {
    const newList = rows.map((r) => r.sentiment.ticker).filter((t) => t !== ticker);
    try {
      await updateWatchlist(newList);
    } catch {
      // surfaced via setError
    }
  }

  function startAdding() {
    setAdding(true);
    setError(null);
    setTimeout(() => addInputRef.current?.focus(), 0);
  }

  function cancelAdding() {
    setAdding(false);
    setNewTicker('');
    setError(null);
  }

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
      <header className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-green-500" />
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
            Your Watchlist
          </h2>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="text-xs text-zinc-600">
              Updated {formatRelative(lastUpdated)}
            </span>
          )}
          <button
            type="button"
            onClick={startAdding}
            disabled={adding || mutating || loading}
            title="Add ticker"
            aria-label="Add ticker to watchlist"
            className="rounded-md p-1.5 text-zinc-500 transition hover:bg-zinc-900 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <Plus className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing || loading || mutating}
            title="Re-score watchlist via Grok"
            aria-label="Refresh sentiment"
            className="rounded-md p-1.5 text-zinc-500 transition hover:bg-zinc-900 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      {adding && (
        <form onSubmit={addTicker} className="mb-3 flex items-center gap-2">
          <input
            ref={addInputRef}
            type="text"
            value={newTicker}
            onChange={(e) => setNewTicker(e.target.value.toUpperCase())}
            placeholder="e.g. AMZN"
            disabled={mutating}
            maxLength={10}
            className="flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm font-mono uppercase text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={mutating || !newTicker.trim()}
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
          Your watchlist is empty. Click <Plus className="inline h-3 w-3" /> above
          to add a ticker.
        </p>
      ) : (
        <>
          {/* Desktop table — table-fixed with explicit widths for the badge
              columns. Reasoning column has no <col> width set so it absorbs
              the leftover horizontal space and respects line-clamp-1 instead
              of expanding to fit the longest reasoning text. */}
          <table className="hidden w-full table-fixed text-sm md:table">
            <colgroup>
              <col className="w-20" /> {/* Ticker */}
              <col />                  {/* Reasoning — flexible */}
              <col className="w-24" /> {/* Sent */}
              <col className="w-24" /> {/* Tech */}
              <col className="w-24" /> {/* Fund */}
              <col className="w-32" /> {/* Combined */}
              <col className="w-10" /> {/* × */}
            </colgroup>
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="pb-2 pr-2 text-left">Ticker</th>
                <th className="pb-2 px-2 text-left">Reasoning</th>
                <th className="pb-2 px-2 text-right">Sent</th>
                <th className="pb-2 px-2 text-right">Tech</th>
                <th className="pb-2 px-2 text-right">Fund</th>
                <th className="pb-2 px-2 text-right">Combined</th>
                <th className="pb-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.sentiment.ticker} className="group border-t border-zinc-800/50">
                  <td className="py-2 pr-2 font-medium">{r.sentiment.ticker}</td>
                  <td className="py-2 px-2 text-zinc-400">
                    <span className="line-clamp-1">{r.sentiment.reasoning || '—'}</span>
                  </td>
                  <td className="py-2 px-2 text-right">
                    <SignalBadge
                      signal={r.sentiment.score !== 0 ? sentimentToSignal(r.sentiment.score) : null}
                      title={
                        r.sentiment.score !== 0
                          ? `Sentiment score: ${r.sentiment.score.toFixed(2)}`
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
                    <CombinedBadge signal={r.combined} />
                  </td>
                  <td className="py-2 text-right">
                    <button
                      type="button"
                      onClick={() => removeTicker(r.sentiment.ticker)}
                      disabled={mutating}
                      title={`Remove ${r.sentiment.ticker}`}
                      aria-label={`Remove ${r.sentiment.ticker} from watchlist`}
                      className="rounded p-1 text-zinc-700 opacity-0 transition hover:bg-zinc-900 hover:text-red-400 group-hover:opacity-100 disabled:cursor-not-allowed"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Mobile card layout — two rows per ticker */}
          <div className="space-y-3 md:hidden">
            {rows.map((r) => {
              const sentSig =
                r.sentiment.score !== 0 ? sentimentToSignal(r.sentiment.score) : null;
              return (
                <div
                  key={r.sentiment.ticker}
                  className="rounded-lg border border-zinc-800/50 bg-zinc-900/30 p-3"
                >
                  {/* Row 1: ticker + reasoning + combined */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-zinc-100">{r.sentiment.ticker}</p>
                      <p className="mt-0.5 line-clamp-2 text-xs text-zinc-500">
                        {r.sentiment.reasoning || '—'}
                      </p>
                    </div>
                    <CombinedBadge signal={r.combined} />
                  </div>
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
                    </div>
                    <button
                      type="button"
                      onClick={() => removeTicker(r.sentiment.ticker)}
                      disabled={mutating}
                      title={`Remove ${r.sentiment.ticker}`}
                      aria-label={`Remove ${r.sentiment.ticker} from watchlist`}
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
          Sentiment from Grok x_search. Technical signal aggregates SMA, EMA, RSI, MACD, and
          Bollinger Bands. Fundamental signal aggregates valuation, profitability, growth, and
          balance-sheet health from FMP data using absolute thresholds (not sector-relative).
          Combined is a majority vote across all three signals — informational only,{' '}
          <strong>not investment advice</strong>.
        </p>
      )}
    </section>
  );
}

function formatRelative(date: Date): string {
  const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}
