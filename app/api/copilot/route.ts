import { NextRequest } from 'next/server';
import { analyzeTicker } from '@/lib/sentiment';
import { getCurrentUser } from '@/lib/auth';
import type { CopilotRequest, CopilotResponse } from '@/types';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json(
      { message: 'Not authenticated' } satisfies CopilotResponse,
      { status: 401 },
    );
  }

  let body: CopilotRequest;
  try {
    body = (await request.json()) as CopilotRequest;
  } catch {
    return Response.json(
      { message: 'Invalid JSON body.' } satisfies CopilotResponse,
      { status: 400 },
    );
  }

  const message = (body.message || '').trim();
  if (message.length < 2) {
    return Response.json(
      { message: 'Please ask a question (at least 2 characters).' } satisfies CopilotResponse,
      { status: 400 },
    );
  }

  try {
    const reply = await routeIntent(message, body.previousResponseId);
    return Response.json(reply satisfies CopilotResponse);
  } catch (err) {
    console.error('[copilot] failed', err);
    return Response.json(
      {
        message: "Sorry, I'm having trouble reaching Grok right now. Please try again.",
      } satisfies CopilotResponse,
      { status: 500 },
    );
  }
}

async function routeIntent(
  message: string,
  previousResponseId?: string,
): Promise<CopilotResponse> {
  const lower = message.toLowerCase();

  if (lower.includes('portfolio') || lower.includes('my holdings')) {
    return handlePortfolio(previousResponseId);
  }

  if (
    lower.includes('hot') ||
    lower.includes('trending') ||
    lower.includes('discover')
  ) {
    return handleDiscover(previousResponseId);
  }

  // Ticker pattern: $NVDA, NVDA, etc. — 2-5 uppercase letters.
  const tickerMatch = message.match(/\$?([A-Z]{2,5})\b/);
  if (tickerMatch) {
    return handleTicker(tickerMatch[1], previousResponseId);
  }

  // Default fallback: treat as a general market question, point at NVDA.
  return handleTicker('NVDA', previousResponseId);
}

async function handleTicker(
  ticker: string,
  previousResponseId?: string,
): Promise<CopilotResponse> {
  const sentiment = await analyzeTicker(ticker, previousResponseId);

  if (sentiment.score > 0.5) {
    return {
      message: `🚀 Strong bullish sentiment on **${sentiment.ticker}** (${sentiment.score.toFixed(2)}). ${sentiment.reasoning}`,
      ui: {
        type: 'showActButton',
        props: {
          ticker: sentiment.ticker,
          ondoSymbol: `${sentiment.ticker.toLowerCase()}on`,
          sentimentScore: sentiment.score,
          reasoning: sentiment.reasoning,
        },
      },
      responseId: sentiment.responseId,
      citations: sentiment.citations,
    };
  }

  return {
    message: `Sentiment for **${sentiment.ticker}** is ${sentiment.score.toFixed(2)}. ${sentiment.reasoning}`,
    responseId: sentiment.responseId,
    citations: sentiment.citations,
  };
}

async function handlePortfolio(previousResponseId?: string): Promise<CopilotResponse> {
  // MVP placeholder: hard-coded watchlist. Later: pull from a real store.
  const watchlist = ['NVDA', 'TSLA', 'AAPL'];
  const results = await Promise.all(
    watchlist.map((t) => analyzeTicker(t, previousResponseId).catch(() => null)),
  );
  const valid = results.filter((r): r is NonNullable<typeof r> => r !== null);
  const top = valid.sort((a, b) => b.score - a.score)[0];

  if (top && top.score > 0.5) {
    return {
      message: `Across your watchlist (${watchlist.join(', ')}), **${top.ticker}** is the strongest right now at ${top.score.toFixed(2)}.`,
      ui: {
        type: 'showActButton',
        props: {
          ticker: top.ticker,
          ondoSymbol: `${top.ticker.toLowerCase()}on`,
          sentimentScore: top.score,
          reasoning: top.reasoning,
        },
      },
      responseId: top.responseId,
      citations: top.citations,
    };
  }

  return {
    message:
      top
        ? `No strong bullish signal in your watchlist right now. Top of the list: **${top.ticker}** at ${top.score.toFixed(2)}.`
        : 'Could not analyze your watchlist right now.',
    responseId: top?.responseId,
    citations: top?.citations,
  };
}

async function handleDiscover(previousResponseId?: string): Promise<CopilotResponse> {
  // MVP placeholder: a small candidate set. Later: real discovery via x_search.
  const candidates = ['NVDA', 'TSLA', 'AAPL', 'MSFT', 'META'];
  const results = await Promise.all(
    candidates.map((t) => analyzeTicker(t, previousResponseId).catch(() => null)),
  );
  const valid = results.filter((r): r is NonNullable<typeof r> => r !== null);
  const top = valid.sort((a, b) => b.score - a.score)[0];

  if (!top) {
    return { message: 'No tickers came back from discovery — try again in a moment.' };
  }

  return {
    message: `🔥 Trending bullish: **${top.ticker}** at ${top.score.toFixed(2)}. ${top.reasoning}`,
    ui:
      top.score > 0.5
        ? {
            type: 'showActButton',
            props: {
              ticker: top.ticker,
              ondoSymbol: `${top.ticker.toLowerCase()}on`,
              sentimentScore: top.score,
              reasoning: top.reasoning,
            },
          }
        : undefined,
    responseId: top.responseId,
    citations: top.citations,
  };
}
