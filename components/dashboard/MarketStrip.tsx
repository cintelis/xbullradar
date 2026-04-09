'use client';

// Scrolling commodities + indexes ticker tape below the TopBar.
//
// Used to also include 6 exchange-hours pills on the right side, but
// those moved into the new ExchangeClockCard component (rendered in the
// dashboard sidebar) which shows a single selectable exchange in detail.
// This component is now just the marquee.
//
// Backend: /api/markets (cached server-side via lib/markets.ts).
// Polls every 5 minutes for fresh data (the cache itself has a 6h TTL so
// most polls are no-ops on the server).

import { useEffect, useState } from 'react';

interface CommodityQuote {
  symbol: string;
  label: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  previousClose: number | null;
}

interface MarketsApiResponse {
  commodities: CommodityQuote[];
  exchanges: unknown;
  fetchedAt: string | null;
}

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export default function MarketStrip() {
  const [data, setData] = useState<MarketsApiResponse | null>(null);
  const [loading, setLoading] = useState(true);

  // Initial fetch + 5-minute polling
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/markets');
        if (!res.ok) return;
        const json = (await res.json()) as MarketsApiResponse;
        if (!cancelled) setData(json);
      } catch {
        // Silent — ticker strip is decorative, don't crash the page over it
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const id = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="flex h-10 items-center overflow-hidden border-b border-zinc-800 bg-zinc-950 text-xs">
      {loading ? (
        <span className="px-4 text-zinc-600">Loading markets…</span>
      ) : data?.commodities && data.commodities.length > 0 ? (
        <Marquee items={data.commodities} />
      ) : (
        <span className="px-4 text-zinc-600">Markets data unavailable</span>
      )}
    </div>
  );
}

// ─── Marquee ────────────────────────────────────────────────────────────────

function Marquee({ items }: { items: CommodityQuote[] }) {
  // Render the items twice back-to-back so the CSS animation can loop
  // seamlessly without a visible reset point. Animation duration scales
  // with item count so longer tapes scroll at the same perceptual speed.
  const duration = Math.max(40, items.length * 5);

  return (
    <div className="flex w-full overflow-hidden">
      <div
        className="marquee-track flex shrink-0 items-center"
        style={{ animationDuration: `${duration}s` }}
      >
        {items.map((item, i) => (
          <TickerItem key={`a-${i}`} item={item} />
        ))}
        {items.map((item, i) => (
          <TickerItem key={`b-${i}`} item={item} />
        ))}
      </div>
    </div>
  );
}

function TickerItem({ item }: { item: CommodityQuote }) {
  const isUp = item.changePercent > 0;
  const isDown = item.changePercent < 0;
  const colorClass = isUp
    ? 'text-green-400'
    : isDown
      ? 'text-red-400'
      : 'text-zinc-400';
  const arrow = isUp ? '▲' : isDown ? '▼' : '—';

  return (
    <div className="flex shrink-0 items-center gap-2 px-4 font-mono">
      <span className="font-semibold text-zinc-300">{item.label}</span>
      <span className="text-zinc-200">${formatPrice(item.price)}</span>
      <span className={colorClass}>
        {arrow} {item.changePercent > 0 ? '+' : ''}
        {item.changePercent.toFixed(2)}%
      </span>
      <span className="text-zinc-700">|</span>
    </div>
  );
}

function formatPrice(price: number): string {
  if (price >= 10000) return price.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (price >= 100) return price.toFixed(1);
  return price.toFixed(2);
}

// (Exchange pills + client-side market-hours computation moved to
// components/dashboard/ExchangeClockCard.tsx — that component shows ONE
// selected exchange in detail with a dropdown to switch.)
