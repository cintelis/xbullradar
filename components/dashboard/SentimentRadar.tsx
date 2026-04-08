'use client';

import { useEffect, useState } from 'react';
import { Radar, RefreshCw } from 'lucide-react';
import type { StockSentiment } from '@/types';

function tone(score: number) {
  if (score > 0.5) return 'text-green-400';
  if (score > 0) return 'text-green-200';
  if (score > -0.5) return 'text-orange-300';
  return 'text-red-400';
}

export default function SentimentRadar() {
  const [rows, setRows] = useState<StockSentiment[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  async function load(fresh = false) {
    if (fresh) setRefreshing(true);
    else setLoading(true);
    try {
      const res = await fetch('/api/sentiment/batch', {
        method: fresh ? 'POST' : 'GET',
      });
      const data = await res.json();
      setRows(data.results ?? []);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    load(false);
  }, []);

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
      <header className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Radar className="h-4 w-4 text-green-500" />
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
            Sentiment Radar
          </h2>
        </div>
        <button
          onClick={() => load(true)}
          disabled={refreshing}
          className="text-zinc-500 hover:text-zinc-200 disabled:opacity-40"
          title="Re-score watchlist via Grok"
        >
          <RefreshCw
            className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`}
          />
        </button>
      </header>

      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-zinc-500">
          No data yet. Click refresh to score your watchlist.
        </p>
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => (
            <li
              key={row.ticker}
              className="flex items-center justify-between border-b border-zinc-800/50 pb-2 last:border-0"
            >
              <span className="font-medium">{row.ticker}</span>
              <span className={`font-mono text-sm ${tone(row.score)}`}>
                {row.score > 0 ? '+' : ''}
                {row.score.toFixed(2)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
