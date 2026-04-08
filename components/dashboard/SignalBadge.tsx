// Visual badges for signals (BUY / SELL / NEUTRAL) used by the portfolio
// and watchlist tables. Two flavors:
//
//   <SignalBadge>      — individual signal column (sentiment, technical, fundamental)
//   <CombinedBadge>    — the headline column. Visually emphasized: bigger,
//                        bordered, with optional MIXED state for divergence.

import { TrendingUp, TrendingDown, AlertTriangle } from 'lucide-react';

export type Signal = 'BUY' | 'SELL' | 'NEUTRAL';
export type CombinedSignal = 'STRONG_BUY' | 'BUY' | 'NEUTRAL' | 'SELL' | 'STRONG_SELL' | 'MIXED';

interface SignalBadgeProps {
  signal: Signal | null;
  /** Tooltip text — shown on hover, useful for explaining why */
  title?: string;
  /** When true, render as `—` instead of NEUTRAL (data unavailable) */
  unavailable?: boolean;
}

export function SignalBadge({ signal, title, unavailable = false }: SignalBadgeProps) {
  if (unavailable || signal == null) {
    return (
      <span
        title={title ?? 'No data'}
        className="inline-flex h-5 w-5 items-center justify-center text-zinc-700"
      >
        —
      </span>
    );
  }

  const config = {
    BUY: {
      Icon: TrendingUp as typeof TrendingUp | null,
      bg: 'bg-green-500/15',
      border: 'border-green-500/30',
      text: 'text-green-400',
      label: 'BUY',
    },
    SELL: {
      Icon: TrendingDown as typeof TrendingUp | null,
      bg: 'bg-red-500/15',
      border: 'border-red-500/30',
      text: 'text-red-400',
      label: 'SELL',
    },
    NEUTRAL: {
      // No icon — the word alone is clear, the minus sign was redundant.
      Icon: null as typeof TrendingUp | null,
      bg: 'bg-zinc-500/10',
      border: 'border-zinc-700/50',
      text: 'text-zinc-500',
      label: 'NEUTRAL',
    },
  }[signal];

  const { Icon, bg, border, text, label } = config;

  return (
    <span
      title={title ?? label}
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${bg} ${border} ${text}`}
    >
      {Icon && <Icon className="h-2.5 w-2.5" />}
      {label}
    </span>
  );
}

// ─── Combined badge ─────────────────────────────────────────────────────────

interface CombinedBadgeProps {
  signal: CombinedSignal | null;
  title?: string;
  unavailable?: boolean;
}

type IconComponent = typeof TrendingUp;

const COMBINED_CONFIG: Record<
  CombinedSignal,
  { Icon: IconComponent | null; bg: string; border: string; text: string; label: string }
> = {
  STRONG_BUY: {
    Icon: TrendingUp,
    bg: 'bg-green-500/25',
    border: 'border-green-400/60',
    text: 'text-green-300',
    label: 'STRONG BUY',
  },
  BUY: {
    Icon: TrendingUp,
    bg: 'bg-green-500/15',
    border: 'border-green-500/40',
    text: 'text-green-400',
    label: 'BUY',
  },
  NEUTRAL: {
    // No icon — the word alone is clear, the minus sign was redundant.
    Icon: null,
    bg: 'bg-zinc-500/10',
    border: 'border-zinc-700/60',
    text: 'text-zinc-400',
    label: 'NEUTRAL',
  },
  SELL: {
    Icon: TrendingDown,
    bg: 'bg-red-500/15',
    border: 'border-red-500/40',
    text: 'text-red-400',
    label: 'SELL',
  },
  STRONG_SELL: {
    Icon: TrendingDown,
    bg: 'bg-red-500/25',
    border: 'border-red-400/60',
    text: 'text-red-300',
    label: 'STRONG SELL',
  },
  MIXED: {
    Icon: AlertTriangle,
    bg: 'bg-amber-500/15',
    border: 'border-amber-500/40',
    text: 'text-amber-400',
    label: 'MIXED',
  },
};

export function CombinedBadge({ signal, title, unavailable = false }: CombinedBadgeProps) {
  if (unavailable || signal == null) {
    return (
      <span
        title={title ?? 'No data yet'}
        className="inline-flex items-center justify-center rounded-md border border-zinc-800 bg-zinc-900/40 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-700"
      >
        —
      </span>
    );
  }

  const { Icon, bg, border, text, label } = COMBINED_CONFIG[signal];
  return (
    <span
      title={title ?? label}
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-bold uppercase tracking-wide ${bg} ${border} ${text}`}
    >
      {Icon && <Icon className="h-3 w-3" />}
      {label}
    </span>
  );
}

// ─── Combined signal aggregation logic ──────────────────────────────────────
//
// 2-way (sentiment + technical) for the technicals sprint.
// 3-way (+ fundamental) when the fundamentals sprint lands — same module,
// just an additional input. Keeping the function signature flexible.

/** Convert a numeric sentiment score (-1..+1) into a categorical signal. */
export function sentimentToSignal(score: number, threshold = 0.3): Signal {
  if (score > threshold) return 'BUY';
  if (score < -threshold) return 'SELL';
  return 'NEUTRAL';
}

/**
 * Combine sentiment + technical signals into a single verdict.
 *
 * Rules:
 *   - All inputs BUY → STRONG_BUY
 *   - Majority BUY → BUY
 *   - All inputs SELL → STRONG_SELL
 *   - Majority SELL → SELL
 *   - Mixed (BUY + SELL together) → MIXED (highlighted as the "interesting" case)
 *   - All NEUTRAL or majority NEUTRAL → NEUTRAL
 *
 * Input null = signal unavailable, ignored in the count. If all inputs are
 * null, return null.
 */
export function combineSignals(...signals: (Signal | null)[]): CombinedSignal | null {
  const valid = signals.filter((s): s is Signal => s != null);
  if (valid.length === 0) return null;

  let buys = 0;
  let sells = 0;
  let neutrals = 0;
  for (const s of valid) {
    if (s === 'BUY') buys += 1;
    else if (s === 'SELL') sells += 1;
    else neutrals += 1;
  }

  const total = valid.length;

  // Disagreement case — at least one BUY and at least one SELL among inputs.
  // This is the "interesting" case the chat panel can explain.
  if (buys > 0 && sells > 0) return 'MIXED';

  // Unanimous agreement
  if (buys === total) return total >= 3 ? 'STRONG_BUY' : 'BUY';
  if (sells === total) return total >= 3 ? 'STRONG_SELL' : 'SELL';

  // Majority (all non-disagreeing)
  if (buys > neutrals && buys > sells) return 'BUY';
  if (sells > neutrals && sells > buys) return 'SELL';

  return 'NEUTRAL';
}
