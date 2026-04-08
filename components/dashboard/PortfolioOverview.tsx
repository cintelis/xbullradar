'use client';

import { useEffect, useState } from 'react';
import { Wallet } from 'lucide-react';
import type { PortfolioHolding } from '@/types';

export default function PortfolioOverview() {
  const [holdings, setHoldings] = useState<PortfolioHolding[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/portfolio')
      .then((r) => r.json())
      .then((data) => setHoldings(data.holdings ?? []))
      .finally(() => setLoading(false));
  }, []);

  const totalValue = holdings.reduce((sum, h) => sum + h.value, 0);

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
      <header className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Wallet className="h-4 w-4 text-green-500" />
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
            Portfolio
          </h2>
        </div>
        <span className="font-mono text-sm text-zinc-300">
          ${totalValue.toLocaleString()}
        </span>
      </header>

      {loading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : holdings.length === 0 ? (
        <p className="text-sm text-zinc-500">No holdings.</p>
      ) : (
        <ul className="space-y-3">
          {holdings.map((h) => (
            <li
              key={h.ticker}
              className="flex items-center justify-between border-b border-zinc-800/50 pb-2 last:border-0"
            >
              <div>
                <p className="font-medium">{h.ticker}</p>
                <p className="text-xs text-zinc-500">{h.shares} shares</p>
              </div>
              <div className="text-right">
                <p className="font-mono text-sm">${h.value.toLocaleString()}</p>
                <p
                  className={`text-xs font-mono ${
                    h.sentimentScore >= 0 ? 'text-green-400' : 'text-red-400'
                  }`}
                >
                  sentiment {h.sentimentScore > 0 ? '+' : ''}
                  {h.sentimentScore.toFixed(2)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
