'use client';

// Exchange clock card — replaces the row of pills from the previous
// MarketStrip design. Shows ONE selected exchange in detail with:
//   - Big open/closed status indicator
//   - Live local time (updates every second)
//   - Trading hours
//   - Live countdown to next open/close
//
// Click the card header to toggle a dropdown of all available exchanges
// (FMP returns ~80 globally). Selection persisted in localStorage so the
// user's pick survives reloads and across devices on the same browser.
//
// Layout:
//   - Mobile: full-width card
//   - Desktop: sits above the chat panel in the right sidebar (~380px)

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Clock } from 'lucide-react';

interface ExchangeHours {
  exchange: string;
  name: string;
  openingHour: string;
  closingHour: string;
  timezone: string;
}

interface MarketsApiResponse {
  commodities: unknown;
  exchanges: ExchangeHours[];
  fetchedAt: string | null;
}

const STORAGE_KEY = 'xbr:selectedExchange';
const DEFAULT_EXCHANGE = 'NYSE';
const TICK_INTERVAL_MS = 1000; // refresh local time every second

export default function ExchangeClockCard() {
  const [exchanges, setExchanges] = useState<ExchangeHours[]>([]);
  const [selectedCode, setSelectedCode] = useState<string>(DEFAULT_EXCHANGE);
  const [now, setNow] = useState(() => new Date());
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [hydrated, setHydrated] = useState(false);

  // Hydrate the selected exchange from localStorage on mount.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) setSelectedCode(stored);
    } catch {
      // ignore — localStorage may be disabled
    }
    setHydrated(true);
  }, []);

  // Persist selection on change (post-hydration so the initial empty
  // state doesn't blow away the stored value).
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, selectedCode);
    } catch {
      // ignore
    }
  }, [selectedCode, hydrated]);

  // Fetch exchanges once on mount. /api/markets is cached server-side,
  // so this is essentially free.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/markets')
      .then((r) => r.json() as Promise<MarketsApiResponse>)
      .then((data) => {
        if (!cancelled && Array.isArray(data.exchanges)) {
          setExchanges(data.exchanges);
        }
      })
      .catch(() => {
        // Strip is decorative — silent fail keeps the page healthy.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Tick the local clock every second so the displayed time and
  // countdown stay current without re-fetching.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), TICK_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  // Click-outside / Escape to close the dropdown.
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const sortedExchanges = useMemo(
    () => [...exchanges].sort((a, b) => a.name.localeCompare(b.name)),
    [exchanges],
  );

  const selected = useMemo(
    () => exchanges.find((e) => e.exchange === selectedCode) ?? null,
    [exchanges, selectedCode],
  );

  return (
    <section
      ref={wrapperRef}
      className="relative rounded-2xl border border-zinc-800 bg-zinc-950"
    >
      {/* Header — click to toggle dropdown */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={exchanges.length === 0}
        className="flex w-full items-center justify-between gap-3 px-5 py-3 text-left transition hover:bg-zinc-900/40 disabled:cursor-not-allowed"
      >
        <div className="flex min-w-0 items-center gap-3">
          <Clock className="h-4 w-4 shrink-0 text-zinc-500" />
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wide text-zinc-500">
              {selected ? (
                <StatusLabel exchange={selected} now={now} />
              ) : (
                'Loading…'
              )}
            </p>
            <p className="truncate text-sm font-semibold text-zinc-100">
              {selected?.exchange ?? '—'}
            </p>
          </div>
        </div>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {/* Body — full details for the selected exchange */}
      {selected && (
        <div className="border-t border-zinc-800/60 px-5 py-4">
          <p className="mb-3 text-sm text-zinc-300">{selected.name}</p>
          <dl className="space-y-2 text-xs">
            <ClockRow label="Local time" value={formatLocalTime(selected.timezone, now)} mono />
            <ClockRow label="Opens" value={formatTime(selected.openingHour)} mono />
            <ClockRow label="Closes" value={formatTime(selected.closingHour)} mono />
          </dl>
          <CountdownLine exchange={selected} now={now} />
        </div>
      )}

      {/* Dropdown — list of all exchanges */}
      {open && (
        <div
          role="listbox"
          className="absolute left-0 right-0 top-full z-40 mt-2 max-h-80 overflow-auto rounded-xl border border-zinc-800 bg-zinc-950 shadow-xl shadow-black/40"
        >
          {sortedExchanges.length === 0 ? (
            <p className="px-4 py-3 text-sm text-zinc-500">No exchanges available.</p>
          ) : (
            sortedExchanges.map((ex) => {
              const isSelected = ex.exchange === selectedCode;
              const isOpenNow = isMarketOpenNow(ex, now);
              return (
                <button
                  key={ex.exchange}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => {
                    setSelectedCode(ex.exchange);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm transition hover:bg-zinc-900 ${
                    isSelected ? 'bg-zinc-900/60 text-zinc-100' : 'text-zinc-300'
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        isOpenNow ? 'bg-green-500' : 'bg-zinc-700'
                      }`}
                    />
                    <span className="w-12 shrink-0 font-mono text-[11px] text-zinc-500">
                      {ex.exchange}
                    </span>
                    <span className="truncate">{ex.name}</span>
                  </div>
                </button>
              );
            })
          )}
        </div>
      )}
    </section>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function StatusLabel({ exchange, now }: { exchange: ExchangeHours; now: Date }) {
  const isOpen = isMarketOpenNow(exchange, now);
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={`h-1.5 w-1.5 rounded-full ${isOpen ? 'bg-green-500' : 'bg-zinc-700'}`}
      />
      {isOpen ? 'Markets open' : 'Markets closed'}
    </span>
  );
}

function ClockRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-zinc-500">{label}</dt>
      <dd className={`text-zinc-200 ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}

function CountdownLine({ exchange, now }: { exchange: ExchangeHours; now: Date }) {
  const isOpen = isMarketOpenNow(exchange, now);
  const minutes = isOpen
    ? minutesUntilClose(exchange, now)
    : minutesUntilNextOpen(exchange, now);

  if (minutes == null) return null;

  return (
    <p className="mt-3 text-xs text-zinc-400">
      {isOpen ? 'Closes in ' : 'Opens in '}
      <span className="font-mono text-zinc-200">{formatDuration(minutes)}</span>
    </p>
  );
}

// ─── Time helpers ───────────────────────────────────────────────────────────

/**
 * Compute "is the market open right now" using the IANA timezone +
 * opening/closing hours from FMP. Closed on Sat/Sun. Doesn't handle
 * holidays (deferred — would need a holiday calendar).
 */
function isMarketOpenNow(exchange: ExchangeHours, now: Date): boolean {
  const local = exchangeLocalTime(exchange, now);
  if (local.weekday === 'Sat' || local.weekday === 'Sun') return false;

  const open = parseHourString(exchange.openingHour);
  const close = parseHourString(exchange.closingHour);
  const nowMinutes = local.hour * 60 + local.minute;
  const openMinutes = open.hour * 60 + open.minute;
  const closeMinutes = close.hour * 60 + close.minute;

  return nowMinutes >= openMinutes && nowMinutes < closeMinutes;
}

/**
 * Minutes from now until the exchange closes for the day (assumes the
 * market is currently open). Returns null if not currently open.
 */
function minutesUntilClose(exchange: ExchangeHours, now: Date): number | null {
  if (!isMarketOpenNow(exchange, now)) return null;
  const local = exchangeLocalTime(exchange, now);
  const close = parseHourString(exchange.closingHour);
  const nowMinutes = local.hour * 60 + local.minute;
  const closeMinutes = close.hour * 60 + close.minute;
  return Math.max(0, closeMinutes - nowMinutes);
}

/**
 * Minutes from now until the exchange next opens. Handles weekends by
 * walking forward day-by-day until we find a non-weekend.
 */
function minutesUntilNextOpen(exchange: ExchangeHours, now: Date): number | null {
  const local = exchangeLocalTime(exchange, now);
  const open = parseHourString(exchange.openingHour);
  const nowMinutes = local.hour * 60 + local.minute;
  const openMinutes = open.hour * 60 + open.minute;

  // Today, before open and not a weekend → opens today
  const isWeekend = local.weekday === 'Sat' || local.weekday === 'Sun';
  if (!isWeekend && nowMinutes < openMinutes) {
    return openMinutes - nowMinutes;
  }

  // Otherwise walk forward through days until we hit a weekday
  let daysAhead = 1;
  let nextWeekday = nextDay(local.weekday);
  while (nextWeekday === 'Sat' || nextWeekday === 'Sun') {
    daysAhead += 1;
    nextWeekday = nextDay(nextWeekday);
  }

  // Time until midnight today + days × 1440 min + opening minutes
  const minutesUntilEndOfToday = 24 * 60 - nowMinutes;
  const fullDaysInBetween = (daysAhead - 1) * 24 * 60;
  return minutesUntilEndOfToday + fullDaysInBetween + openMinutes;
}

const WEEKDAY_ORDER = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function nextDay(weekday: string): string {
  const idx = WEEKDAY_ORDER.indexOf(weekday);
  if (idx === -1) return weekday;
  return WEEKDAY_ORDER[(idx + 1) % 7];
}

interface LocalTime {
  weekday: string; // 'Mon' | 'Tue' | ...
  hour: number;    // 0-23
  minute: number;  // 0-59
}

function exchangeLocalTime(exchange: ExchangeHours, now: Date): LocalTime {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: exchange.timezone,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    weekday: 'short',
  });
  const parts = formatter.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    weekday: get('weekday'),
    hour: parseInt(get('hour'), 10) || 0,
    minute: parseInt(get('minute'), 10) || 0,
  };
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
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(now);
  } catch {
    return '—';
  }
}

/** "09:30 AM -04:00" → "09:30 AM" — strip the trailing offset. */
function formatTime(s: string): string {
  return s.replace(/\s*[-+]\d{2}:?\d{2}\s*$/, '').trim();
}

function formatDuration(totalMinutes: number): string {
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
