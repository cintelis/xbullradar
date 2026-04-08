'use client';

// Bloomberg-style strip below the TopBar:
//   left ~70%: scrolling commodities ticker tape (auto-marquee)
//   right ~30%: global exchange hours pills (NYSE / LSE / FSX / HKSE / TSE / ASX)
//
// Backend: /api/markets (cached server-side via lib/markets.ts).
// Polls every 5 minutes for fresh data (the cache itself has a 6h TTL so
// most polls are no-ops on the server).
//
// "Is market open" is computed CLIENT-SIDE every minute from current time
// + IANA timezone + opening/closing hours. We don't trust FMP's stale
// `isMarketOpen` flag — by display time it's already drifted.

import { useEffect, useMemo, useState } from 'react';

interface CommodityQuote {
  symbol: string;
  label: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  previousClose: number | null;
}

interface ExchangeHours {
  exchange: string;
  name: string;
  openingHour: string;
  closingHour: string;
  timezone: string;
}

interface MarketsApiResponse {
  commodities: CommodityQuote[];
  exchanges: ExchangeHours[];
  fetchedAt: string | null;
}

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const CLOCK_INTERVAL_MS = 30 * 1000;    // recompute "is open" every 30s

// Subset of exchanges to surface on the right side of the strip. Picked
// for global timezone coverage (Asia → Europe → Americas → Pacific) so
// at almost any hour at least one is showing green.
const FEATURED_EXCHANGES = ['NYSE', 'LSE', 'FSX', 'HKSE', 'TSE', 'ASX'];

export default function MarketStrip() {
  const [data, setData] = useState<MarketsApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => new Date());

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

  // Tick the local clock every 30s so the market open/closed pills update
  // as exchanges open and close throughout the day without needing a fresh
  // network fetch.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), CLOCK_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const featuredExchanges = useMemo(() => {
    if (!data?.exchanges) return [];
    const map = new Map(data.exchanges.map((e) => [e.exchange, e]));
    return FEATURED_EXCHANGES.map((code) => map.get(code)).filter((e): e is ExchangeHours => !!e);
  }, [data]);

  return (
    <div className="flex h-10 items-stretch border-b border-zinc-800 bg-zinc-950 text-xs">
      {/* Scrolling commodity ticker tape — left side, takes available space */}
      <div className="flex min-w-0 flex-1 items-center overflow-hidden">
        {loading ? (
          <span className="px-4 text-zinc-600">Loading markets…</span>
        ) : data?.commodities && data.commodities.length > 0 ? (
          <Marquee items={data.commodities} />
        ) : (
          <span className="px-4 text-zinc-600">Markets data unavailable</span>
        )}
      </div>

      {/* Market hours pills — right side, fixed width on desktop, hidden on
          smallest screens to keep the strip from wrapping. */}
      <div className="hidden shrink-0 items-center gap-2 border-l border-zinc-800 px-3 md:flex">
        {featuredExchanges.length === 0 ? (
          <span className="text-zinc-600">—</span>
        ) : (
          featuredExchanges.map((ex) => (
            <ExchangePill key={ex.exchange} exchange={ex} now={now} />
          ))
        )}
      </div>
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

// ─── Exchange pills + client-side market hours computation ──────────────────

function ExchangePill({ exchange, now }: { exchange: ExchangeHours; now: Date }) {
  const isOpen = isMarketOpenNow(exchange, now);
  const dotClass = isOpen ? 'bg-green-500' : 'bg-zinc-700';
  const titleHours = `${exchange.openingHour} – ${exchange.closingHour}`;
  const titleTz = exchange.timezone.split('/').pop() ?? exchange.timezone;
  const fullTitle = `${exchange.name}\n${titleHours} (${titleTz})\nLocal time: ${formatLocalTime(exchange.timezone, now)}`;

  return (
    <span
      title={fullTitle}
      className="inline-flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-300"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
      {exchange.exchange}
    </span>
  );
}

/**
 * Compute "is the market open right now" for a given exchange. Uses the
 * IANA timezone + opening/closing hours from FMP. Closed on Sat/Sun.
 *
 * Limitation: doesn't handle holidays. The display will be wrong on
 * Christmas, Thanksgiving, etc. — those are rare enough to defer to a
 * future enhancement (would need a holiday calendar from FMP or a static
 * lookup table).
 */
function isMarketOpenNow(exchange: ExchangeHours, now: Date): boolean {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: exchange.timezone,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    weekday: 'short',
  });
  const parts = formatter.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';

  const weekday = get('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return false;

  const hour = parseInt(get('hour'), 10);
  const minute = parseInt(get('minute'), 10);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return false;

  const open = parseHourString(exchange.openingHour);
  const close = parseHourString(exchange.closingHour);

  const nowMinutes = hour * 60 + minute;
  const openMinutes = open.hour * 60 + open.minute;
  const closeMinutes = close.hour * 60 + close.minute;

  return nowMinutes >= openMinutes && nowMinutes < closeMinutes;
}

/** Parse "09:30 AM -04:00" → { hour: 9, minute: 30 } in 24-hour. */
function parseHourString(s: string): { hour: number; minute: number } {
  const match = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!match) return { hour: 0, minute: 0 };
  let hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  const ampm = match[3].toUpperCase();
  if (ampm === 'PM' && hour < 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  return { hour, minute };
}

function formatLocalTime(timezone: string, now: Date): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).format(now);
  } catch {
    return '';
  }
}
