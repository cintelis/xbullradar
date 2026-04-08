'use client';

import { useEffect, useState } from 'react';
import { TrendingUp } from 'lucide-react';
import type { StockSentiment } from '@/types';

export default function TrendingStocks() {
  const [rows, setRows] = useState<StockSentiment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/sentiment/batch')
      .then((r) => r.json())
      .then((data) => {
        // Sort by absolute score (most "interesting" movement first)
        const sorted = [...(data.results ?? [])].sort(
          (a, b) => Math.abs(b.score) - Math.abs(a.score),
        );
        setRows(sorted);
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
      <header className="mb-4 flex items-center gap-2">
        <TrendingUp className="h-4 w-4 text-green-500" />
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Trending on X
        </h2>
      </header>

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
