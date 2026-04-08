// Technical analysis aggregation for xBullRadar.
//
// Computes 5 standard indicators (SMA, EMA, RSI, MACD, Bollinger Bands)
// from a series of daily closing prices and aggregates them into a single
// BUY / SELL / NEUTRAL signal via majority vote.
//
// All math is pure TypeScript — no external library. Polygon's TI endpoints
// would each be a separate API call per ticker, which would burn through
// the 5/min Stocks Basic rate limit. Computing locally lets us use a single
// historical-OHLC fetch per ticker (cached) and derive all indicators from
// that data.
//
// Aggregation rule: each indicator votes BUY/SELL/NEUTRAL. The final signal
// is whatever has 3 or more votes (out of 5). Otherwise NEUTRAL. Confidence
// is the fraction of indicators that agree with the winning side.

export type Signal = 'BUY' | 'SELL' | 'NEUTRAL';

export interface TechnicalIndicators {
  sma: Signal;        // SMA(50) vs SMA(200) cross — golden/death cross
  ema: Signal;        // EMA(12) vs EMA(26) cross
  rsi: Signal;        // RSI(14): <30 oversold (BUY), >70 overbought (SELL)
  macd: Signal;       // MACD line vs signal line
  bollinger: Signal;  // price relative to bands
}

export interface TechnicalSignal {
  signal: Signal;
  /** 0..1, fraction of indicators that voted with the winning side */
  confidence: number;
  indicators: TechnicalIndicators;
  /** True if there wasn't enough history (need at least ~26 days for MACD; ideally 200 for SMA(200)) */
  insufficient: boolean;
}

const SMA_FAST_PERIOD = 50;
const SMA_SLOW_PERIOD = 200;
const EMA_FAST_PERIOD = 12;
const EMA_SLOW_PERIOD = 26;
const MACD_SIGNAL_PERIOD = 9;
const RSI_PERIOD = 14;
const RSI_OVERSOLD = 30;
const RSI_OVERBOUGHT = 70;
const BOLLINGER_PERIOD = 20;
const BOLLINGER_STDEV = 2;
const MIN_HISTORY_FOR_FULL_SIGNAL = 26; // enough for EMA(26) + MACD signal line

// ─── Indicator math ─────────────────────────────────────────────────────────

/**
 * Simple moving average — straight arithmetic mean of the last N values.
 * Returns null if there aren't enough samples. Returned for the LAST window
 * only; we don't need a series.
 */
export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  let sum = 0;
  for (const v of slice) sum += v;
  return sum / period;
}

/**
 * Exponential moving average. Seeded with the SMA of the first `period`
 * values, then exponential decay applied to the rest. Returns the EMA at
 * the most recent point.
 */
export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  // Seed with SMA of the first `period` values
  let result = 0;
  for (let i = 0; i < period; i += 1) result += values[i] ?? 0;
  result /= period;
  // Iterate forward applying the EMA recurrence
  for (let i = period; i < values.length; i += 1) {
    result = (values[i] ?? 0) * k + result * (1 - k);
  }
  return result;
}

/**
 * Returns the EMA series across the entire input — needed for MACD because
 * MACD's signal line is itself an EMA of the MACD line, which means we need
 * a series of MACD values, not just the latest.
 */
function emaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let acc = 0;
  for (let i = 0; i < period; i += 1) acc += values[i] ?? 0;
  acc /= period;
  out[period - 1] = acc;
  for (let i = period; i < values.length; i += 1) {
    acc = (values[i] ?? 0) * k + acc * (1 - k);
    out[i] = acc;
  }
  return out;
}

/**
 * Relative Strength Index (Wilder's smoothing). Returns the RSI at the
 * most recent point. Range 0-100.
 *
 * Implementation uses the standard Wilder smoothing recurrence:
 *   avgGain[t] = (avgGain[t-1] * (period - 1) + gain[t]) / period
 *   avgLoss[t] = (avgLoss[t-1] * (period - 1) + loss[t]) / period
 *   RSI = 100 - (100 / (1 + avgGain / avgLoss))
 */
export function rsi(values: number[], period = RSI_PERIOD): number | null {
  if (values.length < period + 1) return null;

  // First period+1 values give us `period` price changes for the initial average
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = (values[i] ?? 0) - (values[i - 1] ?? 0);
    if (change > 0) gainSum += change;
    else lossSum -= change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  // Wilder smoothing for the remaining values
  for (let i = period + 1; i < values.length; i += 1) {
    const change = (values[i] ?? 0) - (values[i - 1] ?? 0);
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * MACD: difference between two EMAs (fast - slow), and a signal line which
 * is itself an EMA of that difference. Returns the latest values for both
 * lines, plus a histogram (macd - signal).
 *
 * Standard parameters: fast=12, slow=26, signal=9.
 */
export function macd(
  values: number[],
  fastPeriod = EMA_FAST_PERIOD,
  slowPeriod = EMA_SLOW_PERIOD,
  signalPeriod = MACD_SIGNAL_PERIOD,
): { macd: number; signal: number; histogram: number } | null {
  if (values.length < slowPeriod + signalPeriod) return null;
  const fastSeries = emaSeries(values, fastPeriod);
  const slowSeries = emaSeries(values, slowPeriod);
  const macdSeries: number[] = [];
  for (let i = 0; i < values.length; i += 1) {
    const f = fastSeries[i];
    const s = slowSeries[i];
    if (f != null && s != null) macdSeries.push(f - s);
  }
  if (macdSeries.length < signalPeriod) return null;
  const signal = ema(macdSeries, signalPeriod);
  const macdLatest = macdSeries[macdSeries.length - 1];
  if (macdLatest == null || signal == null) return null;
  return {
    macd: macdLatest,
    signal,
    histogram: macdLatest - signal,
  };
}

/**
 * Bollinger Bands: SMA(period) ± stdev(period) × multiplier. Returns the
 * latest band values plus the most recent close price for comparison.
 */
export function bollinger(
  values: number[],
  period = BOLLINGER_PERIOD,
  stdevMult = BOLLINGER_STDEV,
): { middle: number; upper: number; lower: number; latestClose: number } | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  let varianceSum = 0;
  for (const v of slice) {
    const d = v - middle;
    varianceSum += d * d;
  }
  const stdev = Math.sqrt(varianceSum / period);
  const latestClose = values[values.length - 1] ?? 0;
  return {
    middle,
    upper: middle + stdev * stdevMult,
    lower: middle - stdev * stdevMult,
    latestClose,
  };
}

// ─── Per-indicator signal classification ────────────────────────────────────

/**
 * SMA crossover: fast vs slow. Fast above slow → bullish (golden cross
 * regime). Fast below slow → bearish (death cross regime).
 *
 * If we don't have 200 days of history yet, fall back to whatever the
 * longest available SMA is — better to give SOME signal than none.
 */
function smaSignal(closes: number[]): Signal {
  const fast = sma(closes, SMA_FAST_PERIOD);
  const slow = sma(closes, SMA_SLOW_PERIOD);
  if (fast == null || slow == null) {
    // Fall back to a shorter pair if we don't have 200d history
    const shortFast = sma(closes, 20);
    const shortSlow = sma(closes, 50);
    if (shortFast == null || shortSlow == null) return 'NEUTRAL';
    if (shortFast > shortSlow * 1.005) return 'BUY';
    if (shortFast < shortSlow * 0.995) return 'SELL';
    return 'NEUTRAL';
  }
  // Add a 0.5% deadband around the cross to avoid flipping on noise
  if (fast > slow * 1.005) return 'BUY';
  if (fast < slow * 0.995) return 'SELL';
  return 'NEUTRAL';
}

function emaSignal(closes: number[]): Signal {
  const fast = ema(closes, EMA_FAST_PERIOD);
  const slow = ema(closes, EMA_SLOW_PERIOD);
  if (fast == null || slow == null) return 'NEUTRAL';
  if (fast > slow * 1.005) return 'BUY';
  if (fast < slow * 0.995) return 'SELL';
  return 'NEUTRAL';
}

function rsiSignal(closes: number[]): Signal {
  const value = rsi(closes);
  if (value == null) return 'NEUTRAL';
  if (value < RSI_OVERSOLD) return 'BUY'; // oversold = potential bounce
  if (value > RSI_OVERBOUGHT) return 'SELL'; // overbought = potential pullback
  return 'NEUTRAL';
}

function macdSignal(closes: number[]): Signal {
  const result = macd(closes);
  if (!result) return 'NEUTRAL';
  // Histogram positive = MACD above signal line = bullish momentum
  if (result.histogram > 0) return 'BUY';
  if (result.histogram < 0) return 'SELL';
  return 'NEUTRAL';
}

function bollingerSignal(closes: number[]): Signal {
  const bands = bollinger(closes);
  if (!bands) return 'NEUTRAL';
  // Below lower band = oversold = potential bounce (BUY)
  // Above upper band = overbought = potential pullback (SELL)
  if (bands.latestClose < bands.lower) return 'BUY';
  if (bands.latestClose > bands.upper) return 'SELL';
  return 'NEUTRAL';
}

// ─── Aggregation ────────────────────────────────────────────────────────────

/**
 * Computes all 5 indicators and aggregates them via majority vote.
 * Returns the aggregated signal plus the per-indicator breakdown so the UI
 * can explain the verdict ("4 of 5 indicators bullish").
 */
export function computeTechnicalSignal(closes: number[]): TechnicalSignal {
  const insufficient = closes.length < MIN_HISTORY_FOR_FULL_SIGNAL;

  const indicators: TechnicalIndicators = {
    sma: smaSignal(closes),
    ema: emaSignal(closes),
    rsi: rsiSignal(closes),
    macd: macdSignal(closes),
    bollinger: bollingerSignal(closes),
  };

  let buys = 0;
  let sells = 0;
  let neutrals = 0;
  for (const v of Object.values(indicators)) {
    if (v === 'BUY') buys += 1;
    else if (v === 'SELL') sells += 1;
    else neutrals += 1;
  }

  // Majority of 5: 3 or more wins. Otherwise NEUTRAL.
  let signal: Signal = 'NEUTRAL';
  let confidence = 0;
  if (buys >= 3) {
    signal = 'BUY';
    confidence = buys / 5;
  } else if (sells >= 3) {
    signal = 'SELL';
    confidence = sells / 5;
  } else {
    confidence = neutrals / 5;
  }

  return { signal, confidence, indicators, insufficient };
}
