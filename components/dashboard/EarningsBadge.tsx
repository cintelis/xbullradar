// Small "earnings in N days" badge for the portfolio + watchlist tables.
//
// Hidden when there's no upcoming earnings within 30 days — most of the
// time the column is empty (no noise), the badge only appears when it's
// actionable. The threshold of 30 days is arbitrary but matches the
// "this is the next thing on my radar" mental model.
//
// Visual scale:
//   - Today: bright orange "🔔 TODAY" — strongest call to attention
//   - Tomorrow: amber "in 1d"
//   - 2-7 days: yellow "in Nd"
//   - 8-30 days: zinc "in Nd"
//   - >30 days OR null: hidden entirely

import { Calendar } from 'lucide-react';

export interface NextEarnings {
  date: string;
  daysAway: number;
  epsEstimated: number | null;
  revenueEstimated: number | null;
}

export interface EarningsBeatRecord {
  date: string;
  epsActual: number;
  epsEstimated: number;
  surprise: number;
  beat: boolean;
}

interface EarningsBadgeProps {
  next: NextEarnings | null;
  /** Recent reported quarters — shown in the tooltip as a beat/miss summary */
  recentBeats?: EarningsBeatRecord[];
  /** Hide when more than this many days away. Default 30. */
  hideAfterDays?: number;
}

export function EarningsBadge({
  next,
  recentBeats = [],
  hideAfterDays = 30,
}: EarningsBadgeProps) {
  if (!next || next.daysAway > hideAfterDays) {
    return <span className="text-zinc-700">—</span>;
  }

  const { label, toneClass, animate } = formatEarningsLabel(next.daysAway);
  const tooltip = buildTooltip(next, recentBeats);

  return (
    <span
      title={tooltip}
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${toneClass}`}
    >
      <Calendar className={`h-2.5 w-2.5 ${animate ? 'animate-pulse' : ''}`} />
      {label}
    </span>
  );
}

function formatEarningsLabel(daysAway: number): {
  label: string;
  toneClass: string;
  animate: boolean;
} {
  if (daysAway === 0) {
    return {
      label: 'TODAY',
      toneClass: 'bg-orange-500/20 border-orange-500/50 text-orange-300',
      animate: true,
    };
  }
  if (daysAway === 1) {
    return {
      label: 'TMRW',
      toneClass: 'bg-amber-500/20 border-amber-500/50 text-amber-300',
      animate: false,
    };
  }
  if (daysAway <= 7) {
    return {
      label: `IN ${daysAway}D`,
      toneClass: 'bg-yellow-500/15 border-yellow-500/40 text-yellow-300',
      animate: false,
    };
  }
  return {
    label: `IN ${daysAway}D`,
    toneClass: 'bg-zinc-800 border-zinc-700/60 text-zinc-400',
    animate: false,
  };
}

function buildTooltip(next: NextEarnings, recentBeats: EarningsBeatRecord[]): string {
  const lines: string[] = [];
  lines.push(`Next earnings: ${next.date} (${next.daysAway === 0 ? 'today' : next.daysAway === 1 ? 'tomorrow' : `${next.daysAway} days away`})`);
  if (next.epsEstimated != null) {
    lines.push(`Consensus EPS: ${next.epsEstimated.toFixed(2)}`);
  }
  if (next.revenueEstimated != null) {
    lines.push(`Consensus revenue: ${formatBigNumber(next.revenueEstimated)}`);
  }
  if (recentBeats.length > 0) {
    const beats = recentBeats.filter((r) => r.beat).length;
    lines.push('');
    lines.push(`Last ${recentBeats.length} quarters: ${beats}/${recentBeats.length} beats`);
    for (const r of recentBeats.slice(0, 3)) {
      const sign = r.surprise >= 0 ? '+' : '';
      lines.push(
        `  ${r.date}: ${r.epsActual.toFixed(2)} vs est ${r.epsEstimated.toFixed(2)} (${sign}${r.surprise.toFixed(2)}) ${r.beat ? '✓' : '✗'}`,
      );
    }
  }
  return lines.join('\n');
}

function formatBigNumber(n: number): string {
  if (Math.abs(n) >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(0)}M`;
  return `$${n.toLocaleString('en-US')}`;
}
