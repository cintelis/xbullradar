import { callGrokResponses, recentXSearchTool } from './grok';
import type { StockSentiment } from '@/types';

const SYSTEM_PROMPT_SINGLE = `You are XBullRadar, a real-time market sentiment analyst.
Use the x_search tool to pull recent public X (Twitter) posts about the given ticker
and reason over what real traders and accounts are saying RIGHT NOW. Weight engagement,
account credibility, and signal vs. noise.

Respond with ONLY a JSON object on a single line, no markdown, no prose:
{"score": <number from -1.0 to 1.0>, "reasoning": "<one or two sentences>"}

Score guide:
  -1.0 = extremely bearish, panic selling
  -0.5 = bearish
   0.0 = neutral / mixed
  +0.5 = bullish
  +1.0 = extremely bullish, euphoria`;

const SYSTEM_PROMPT_BATCH = `You are XBullRadar, a real-time market sentiment analyst.
Use the x_search tool to pull recent public X (Twitter) posts about EACH of the given
tickers in a single sweep, then score them all.

Respond with ONLY a JSON array on a single line, no markdown, no prose:
[{"ticker":"<TICKER>","score":<number from -1.0 to 1.0>,"reasoning":"<one short sentence>"}, ...]

Score guide:
  -1.0 = extremely bearish, panic selling
   0.0 = neutral / mixed
  +1.0 = extremely bullish, euphoria

Return one entry per requested ticker, in the same order they were given.`;

export async function analyzeTicker(
  ticker: string,
  previousResponseId?: string,
): Promise<StockSentiment> {
  const upper = ticker.toUpperCase();
  const prompt = `${SYSTEM_PROMPT_SINGLE}\n\nTicker: ${upper}`;

  const result = await callGrokResponses({
    input: prompt,
    previous_response_id: previousResponseId,
    temperature: 0.2,
    tools: [recentXSearchTool(1)],
  });

  const parsed = parseSentimentJson(result.output_text);

  return {
    ticker: upper,
    score: clampScore(parsed.score),
    reasoning: parsed.reasoning || '',
    responseId: result.id,
    citations: result.citations,
  };
}

/**
 * Score many tickers in a single Grok call. Cheaper + faster than N
 * individual calls. Uses grok-3-mini by default.
 */
export async function analyzeTickersBatch(
  tickers: string[],
): Promise<StockSentiment[]> {
  if (tickers.length === 0) return [];

  const upper = tickers.map((t) => t.toUpperCase());
  const prompt = `${SYSTEM_PROMPT_BATCH}\n\nTickers: ${upper.join(', ')}`;

  const result = await callGrokResponses({
    model: process.env.GROK_MODEL_FAST || 'grok-3-mini',
    input: prompt,
    temperature: 0.2,
    tools: [recentXSearchTool(1)],
  });

  const parsed = parseBatchSentimentJson(result.output_text);

  // Map back by ticker, filling missing entries with neutral fallbacks so
  // callers can rely on length === input length.
  const byTicker = new Map(parsed.map((p) => [p.ticker.toUpperCase(), p]));
  // Citations from a batch call cover all tickers in the sweep, so attach
  // the same list to every entry rather than trying to attribute them.
  return upper.map((ticker) => {
    const entry = byTicker.get(ticker);
    return {
      ticker,
      score: clampScore(entry?.score ?? 0),
      reasoning: entry?.reasoning ?? '',
      responseId: result.id,
      citations: result.citations,
    };
  });
}

function parseSentimentJson(text: string): { score: number; reasoning: string } {
  const match = text.match(/\{[\s\S]*?\}/);
  if (!match) {
    return { score: 0, reasoning: text.trim().slice(0, 280) };
  }
  try {
    const obj = JSON.parse(match[0]);
    return {
      score: typeof obj.score === 'number' ? obj.score : Number(obj.score) || 0,
      reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : '',
    };
  } catch {
    return { score: 0, reasoning: text.trim().slice(0, 280) };
  }
}

function parseBatchSentimentJson(
  text: string,
): Array<{ ticker: string; score: number; reasoning: string }> {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((row: any) => ({
        ticker: String(row?.ticker ?? '').toUpperCase(),
        score:
          typeof row?.score === 'number' ? row.score : Number(row?.score) || 0,
        reasoning: String(row?.reasoning ?? ''),
      }))
      .filter((row) => row.ticker.length > 0);
  } catch {
    return [];
  }
}

function clampScore(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(-1, Math.min(1, n));
}
