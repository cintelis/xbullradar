// Webhook alerts. Fires Slack/Discord-compatible JSON to ALERT_WEBHOOK_URL
// when a ticker's sentiment score crosses a configured threshold compared
// to its last known score.
//
// Crossing rules (configurable via env):
//   BULLISH_THRESHOLD (default 0.5):  alert when score crosses upward over this
//   BEARISH_THRESHOLD (default -0.5): alert when score crosses downward under this
//
// Slack and Discord both accept `{text: "..."}` so a single payload format
// works for either.

import type { StockSentiment } from '@/types';

export interface AlertContext {
  current: StockSentiment;
  previous: StockSentiment | null;
}

export type AlertKind = 'bullish-cross' | 'bearish-cross' | 'flip';

export interface Alert {
  kind: AlertKind;
  ticker: string;
  previousScore: number | null;
  currentScore: number;
  reasoning: string;
}

export function detectAlert({ current, previous }: AlertContext): Alert | null {
  const bullish = Number(process.env.BULLISH_THRESHOLD ?? 0.5);
  const bearish = Number(process.env.BEARISH_THRESHOLD ?? -0.5);

  const prev = previous?.score ?? null;
  const cur = current.score;

  // First-ever observation: only alert if it lands strongly bullish/bearish
  // out of the gate.
  if (prev === null) {
    if (cur >= bullish) {
      return alert('bullish-cross', current, prev);
    }
    if (cur <= bearish) {
      return alert('bearish-cross', current, prev);
    }
    return null;
  }

  // Bullish threshold crossing (upward)
  if (prev < bullish && cur >= bullish) {
    return alert('bullish-cross', current, prev);
  }
  // Bearish threshold crossing (downward)
  if (prev > bearish && cur <= bearish) {
    return alert('bearish-cross', current, prev);
  }
  // Sign flip (neutral middle, but a meaningful directional change)
  if (Math.sign(prev) !== Math.sign(cur) && Math.abs(cur - prev) >= 0.4) {
    return alert('flip', current, prev);
  }
  return null;
}

function alert(kind: AlertKind, current: StockSentiment, prev: number | null): Alert {
  return {
    kind,
    ticker: current.ticker,
    previousScore: prev,
    currentScore: current.score,
    reasoning: current.reasoning,
  };
}

export async function sendAlert(alert: Alert): Promise<void> {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;

  const emoji =
    alert.kind === 'bullish-cross' ? '🚀' : alert.kind === 'bearish-cross' ? '🔻' : '↔️';
  const direction =
    alert.kind === 'bullish-cross'
      ? 'crossed BULLISH'
      : alert.kind === 'bearish-cross'
        ? 'crossed BEARISH'
        : 'flipped sentiment';

  const prevText =
    alert.previousScore === null ? 'new' : alert.previousScore.toFixed(2);

  const text = `${emoji} *${alert.ticker}* ${direction} (${prevText} → ${alert.currentScore.toFixed(2)})\n${alert.reasoning}`;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        // Discord also accepts `content`. Slack ignores it.
        content: text,
      }),
    });
  } catch (err) {
    console.error('[alerts] webhook failed', err);
  }
}
