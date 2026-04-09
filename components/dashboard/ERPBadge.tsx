// Equity Risk Premium badge for the portfolio + watchlist tables.
//
// ERP = earnings yield − 10Y treasury yield, in percentage points.
// Tells you whether the stock offers more or less yield than the
// "risk-free" alternative of holding US treasuries — a classic stocks-
// vs-bonds sanity check.
//
// Thresholds:
//   ERP > 4%   🟢 CHEAP   stock yields meaningfully more than bonds
//   ERP 2-4%   ⚪ FAIR    stock priced about right vs bonds
//   ERP < 2%   🔴 RICH    stock yields less premium than bonds — expensive
//
// These are reasonable defaults — historically the US equity risk premium
// has averaged ~4-5%, so >4% is cheap territory and <2% means you're
// barely compensated for the extra risk of holding stocks.

import { TrendingDown, TrendingUp, Minus } from 'lucide-react';

interface ERPBadgeProps {
  /** Equity Risk Premium in percentage points (e.g. 3.45 = 3.45%) */
  erp: number | null;
}

const CHEAP_THRESHOLD = 4;
const RICH_THRESHOLD = 2;

export function ERPBadge({ erp }: ERPBadgeProps) {
  if (erp == null) {
    return (
      <span title="No P/E or 10Y yield available" className="text-zinc-700">
        —
      </span>
    );
  }

  const config = classify(erp);
  const sign = erp >= 0 ? '+' : '';
  const tooltip = buildTooltip(erp, config.label);

  return (
    <span
      title={tooltip}
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${config.toneClass}`}
    >
      <config.Icon className="h-2.5 w-2.5" />
      {config.label}
      <span className="ml-0.5 font-mono text-zinc-300">
        {sign}
        {erp.toFixed(1)}%
      </span>
    </span>
  );
}

function classify(erp: number): {
  label: string;
  toneClass: string;
  Icon: typeof TrendingUp;
} {
  if (erp > CHEAP_THRESHOLD) {
    return {
      label: 'CHEAP',
      toneClass: 'bg-green-500/15 border-green-500/40 text-green-400',
      Icon: TrendingUp,
    };
  }
  if (erp < RICH_THRESHOLD) {
    return {
      label: 'RICH',
      toneClass: 'bg-red-500/15 border-red-500/40 text-red-400',
      Icon: TrendingDown,
    };
  }
  return {
    label: 'FAIR',
    toneClass: 'bg-zinc-500/10 border-zinc-700/60 text-zinc-400',
    Icon: Minus,
  };
}

function buildTooltip(erp: number, label: string): string {
  const lines = [
    `Equity Risk Premium: ${erp >= 0 ? '+' : ''}${erp.toFixed(2)}%`,
    `(stock earnings yield minus 10Y Treasury yield)`,
    '',
  ];
  if (label === 'CHEAP') {
    lines.push(`> ${CHEAP_THRESHOLD}% premium = stock yields meaningfully more`);
    lines.push('than bonds. Cheap vs the risk-free alternative.');
  } else if (label === 'RICH') {
    lines.push(`< ${RICH_THRESHOLD}% premium = stock yields less than bonds.`);
    lines.push('Expensive vs the risk-free alternative.');
  } else {
    lines.push(`${RICH_THRESHOLD}-${CHEAP_THRESHOLD}% premium = priced about right`);
    lines.push('vs bonds. Historical US average is ~4-5%.');
  }
  return lines.join('\n');
}
