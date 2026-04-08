'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Plus, RefreshCw, TrendingUp, X } from 'lucide-react';
import type { StockSentiment } from '@/types';

const TICKER_PATTERN = /^[A-Z]{1,10}$/;

export default function TrendingStocks() {
  const [rows, setRows] = useState<StockSentiment[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newTicker, setNewTicker] = useState('');
  const addInputRef = useRef<HTMLInputElement>(null);

  // Sort by absolute score so the most "interesting" movement (in either
  // direction) lands at the top.
  const applyResults = useCallback((results: StockSentiment[]) => {
    const sorted = [...results].sort(
      (a, b) => Math.abs(b.score) - Math.abs(a.score),
    );
    setRows(sorted);
  }, []);

  // Initial load: cheap GET reads last-known scores from disk (no Grok call).
  useEffect(() => {
    fetch('/api/sentiment/batch')
      .then((r) => r.json())
      .then((data) => {
        applyResults(data.results ?? []);
        if (data.results?.some((r: StockSentiment) => r.score !== 0)) {
          setLastUpdated(new Date());
        }
      })
      .finally(() => setLoading(false));
  }, [applyResults]);

  // Manual refresh: POST triggers a real Grok batch call and persists results
  // server-side. Costs ~one batch call + one x_search invocation.
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
      applyResults(data.results ?? []);
      setLastUpdated(new Date());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  }

  // Reload sentiment data without triggering a Grok call. Used after
  // mutating the watchlist so the table reflects the new shape.
  async function reloadSentiment() {
    const res = await fetch('/api/sentiment/batch');
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error || `HTTP ${res.status}`);
    }
    applyResults(data.results ?? []);
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
    if (rows.some((r) => r.ticker === ticker)) {
      setError(`${ticker} is already in your watchlist.`);
      return;
    }

    const newList = [...rows.map((r) => r.ticker), ticker];
    try {
      await updateWatchlist(newList);
      setNewTicker('');
      // Keep focus on the input so the user can add another ticker quickly.
      addInputRef.current?.focus();
    } catch {
      // Error already surfaced via setError in updateWatchlist.
    }
  }

  async function removeTicker(ticker: string) {
    const newList = rows.map((r) => r.ticker).filter((t) => t !== ticker);
    try {
      await updateWatchlist(newList);
    } catch {
      // Error already surfaced via setError.
    }
  }

  function startAdding() {
    setAdding(true);
    setError(null);
    // Focus the input on next paint, after it's mounted.
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
        <table className="w-full text-sm">
          <thead className="text-xs text-zinc-500">
            <tr>
              <th className="pb-2 text-left">Ticker</th>
              <th className="pb-2 text-left">Reasoning</th>
              <th className="pb-2 text-right">Sentiment</th>
              <th className="pb-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.ticker} className="group border-t border-zinc-800/50">
                <td className="py-2 font-medium">{row.ticker}</td>
                <td className="py-2 text-zinc-400">
                  <span className="line-clamp-1">{row.reasoning || '—'}</span>
                </td>
                <td
                  className={`py-2 text-right font-mono ${
                    row.score > 0 ? 'text-green-400' : row.score < 0 ? 'text-red-400' : 'text-zinc-500'
                  }`}
                >
                  {row.score > 0 ? '+' : ''}
                  {row.score.toFixed(2)}
                </td>
                <td className="py-2 pl-2 text-right">
                  <button
                    type="button"
                    onClick={() => removeTicker(row.ticker)}
                    disabled={mutating}
                    title={`Remove ${row.ticker}`}
                    aria-label={`Remove ${row.ticker} from watchlist`}
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
