'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, TrendingUp } from 'lucide-react';
import type { StockSentiment } from '@/types';

export default function TrendingStocks() {
  const [rows, setRows] = useState<StockSentiment[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
      <header className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-green-500" />
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
            Trending on X
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
            onClick={refresh}
            disabled={refreshing || loading}
            title="Re-score watchlist via Grok"
            aria-label="Refresh sentiment"
            className="rounded-md p-1.5 text-zinc-500 transition hover:bg-zinc-900 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <RefreshCw
              className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`}
            />
          </button>
        </div>
      </header>

      {error && (
        <p className="mb-3 rounded-md border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-400">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-zinc-500">No data yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-xs text-zinc-500">
            <tr>
              <th className="pb-2 text-left">Ticker</th>
              <th className="pb-2 text-left">Reasoning</th>
              <th className="pb-2 text-right">Sentiment</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.ticker} className="border-t border-zinc-800/50">
                <td className="py-2 font-medium">{row.ticker}</td>
                <td className="py-2 text-zinc-400">
                  <span className="line-clamp-1">{row.reasoning || '—'}</span>
                </td>
                <td
                  className={`py-2 text-right font-mono ${
                    row.score > 0 ? 'text-green-400' : 'text-red-400'
                  }`}
                >
                  {row.score > 0 ? '+' : ''}
                  {row.score.toFixed(2)}
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
