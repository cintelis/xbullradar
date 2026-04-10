import { NextRequest } from 'next/server';
import { analyzeTicker } from '@/lib/sentiment';
import { callGrokResponses, recentXSearchTool } from '@/lib/grok';
import { getCurrentUser } from '@/lib/auth';
import { INVESTING_SYSTEM_PROMPT } from '@/lib/copilot/prompt';
import { loadPortfolioContext } from '@/lib/copilot/context';
import { isOnOndo } from '@/lib/ondo';
import type { CopilotRequest, CopilotResponse, CopilotUiAction } from '@/types';

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
    const reply = await routeIntent(message, user.id, body.previousResponseId);
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

/**
 * Words that signal the user is asking a *question* about a ticker rather
 * than just dropping a symbol for a sentiment scan. When any of these are
 * present we route through the conversational handler instead of collapsing
 * the message to a one-line sentiment template.
 */
const NUANCED_QUESTION_WORDS = [
  'why',
  'how',
  'should',
  'would',
  'could',
  'think',
  'thoughts',
  'opinion',
  'compare',
  'vs',
  'versus',
  'explain',
  'tell me',
  'analyze',
  'analyse',
  'worth',
  'overvalued',
  'undervalued',
  'cheap',
  'expensive',
  'moat',
  'risk',
  'thesis',
  'buffett',
  'lynch',
  'munger',
  'greenblatt',
  'damodaran',
  'value investor',
  'growth investor',
];

async function routeIntent(
  message: string,
  userId: string,
  previousResponseId?: string,
): Promise<CopilotResponse> {
  const lower = message.toLowerCase();

  // "What's hot" / "trending" still goes through the structured discover
  // handler because it surfaces an Act button card. Portfolio questions
  // used to have their own structured handler too, but the conversational
  // bot now loads the real portfolio snapshot and can answer those better,
  // so we let those fall through.
  if (
    lower.includes("what's hot") ||
    lower.includes('whats hot') ||
    lower.includes('trending') ||
    lower.includes('discover')
  ) {
    return handleDiscover(previousResponseId);
  }

  // Ticker pattern: $NVDA, NVDA, etc. Two routes from here:
  //   - Bare ticker / very short message → sentiment scan (structured)
  //   - Ticker inside a real question → conversational
  const tickerMatch = message.match(/\$?([A-Z]{2,5})\b/);
  const isNuanced = NUANCED_QUESTION_WORDS.some((w) => lower.includes(w));
  const wordCount = message.trim().split(/\s+/).length;

  if (tickerMatch && !isNuanced && wordCount <= 3) {
    return handleTicker(tickerMatch[1], previousResponseId);
  }

  // Everything else — questions with or without tickers — goes through the
  // conversational co-pilot with the investing system prompt.
  return handleConversational(message, userId, previousResponseId);
}

/**
 * Conversational mode — calls Grok directly with the investing system
 * prompt and lets it answer freely. Uses x_search so the bot can ground
 * its answer in recent X chatter when the question is time-sensitive.
 *
 * Loads the user's portfolio + cached signals and prepends them to the
 * message as a snapshot block, so the bot can reason over the user's
 * actual positions instead of speaking in generalities.
 */
async function handleConversational(
  message: string,
  userId: string,
  previousResponseId?: string,
): Promise<CopilotResponse> {
  const portfolioSnapshot = await loadPortfolioContext(userId).catch((err) => {
    console.warn('[copilot] portfolio context load failed', err);
    return null;
  });

  const fullInput = portfolioSnapshot
    ? `${portfolioSnapshot}\n\n---\n\nUser question: ${message}`
    : message;

  const result = await callGrokResponses({
    input: fullInput,
    instructions: INVESTING_SYSTEM_PROMPT,
    previous_response_id: previousResponseId,
    temperature: 0.4,
    tools: [recentXSearchTool(2), { type: 'web_search' }],
  });

  // Post-process: scan the bot's reply for ticker mentions that are
  // available on Ondo Finance. If found, attach a showActButton UI
  // action so the green "Act on {TICKER}on" CTA renders below the
  // reply. Picks the first Ondo-available ticker mentioned — if the
  // bot discussed multiple stocks, the most prominent one (mentioned
  // first) gets the button.
  const ui = extractOndoAction(result.output_text, message);

  return {
    message: result.output_text,
    ui,
    responseId: result.id,
    citations: result.citations,
  };
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

/**
 * Scan bot reply + user message for ticker mentions that are available
 * on Ondo Finance. Returns a showActButton UI action for the first
 * match, or undefined if no Ondo-available ticker was discussed.
 *
 * Detection: look for 1-5 uppercase letters that match stock tickers.
 * We check both the bot's reply and the user's original message (the
 * user might have asked "tell me about AMZN" and the bot responded
 * without repeating the ticker in uppercase). Priority: tickers in
 * the bot's reply first, then the user's message.
 *
 * We scan for patterns like $NVDA, NVDA, **NVDA**, but skip common
 * English words that look like tickers (A, I, AM, IS, IT, DO, etc.)
 * to avoid false positives.
 */
const TICKER_IN_TEXT = /\$?(?:\*{1,2})?([A-Z]{1,5})(?:\*{1,2})?\b/g;
const FALSE_POSITIVE_WORDS = new Set([
  'A', 'I', 'AM', 'AN', 'AS', 'AT', 'BE', 'BY', 'DO', 'GO', 'IF',
  'IN', 'IS', 'IT', 'MY', 'NO', 'OF', 'ON', 'OR', 'SO', 'TO', 'UP',
  'US', 'WE', 'ALL', 'AND', 'ARE', 'BUT', 'CAN', 'DID', 'FOR', 'GET',
  'GOT', 'HAS', 'HAD', 'HER', 'HIM', 'HIS', 'HOW', 'ITS', 'LET',
  'MAY', 'NEW', 'NOT', 'NOW', 'OLD', 'ONE', 'OUR', 'OUT', 'OWN',
  'SAY', 'SHE', 'THE', 'TOO', 'TWO', 'USE', 'WAY', 'WHO', 'WHY',
  'YES', 'YET', 'YOU', 'BUY', 'SELL', 'HOLD', 'CASH', 'BOND',
  'RICH', 'FAIR', 'CHEAP', 'ERP', 'ETF', 'IPO', 'CEO', 'CFO',
  'SEC', 'FED', 'GDP', 'CPI', 'NFP', 'YOY', 'QOQ',
]);

function extractOndoAction(
  botReply: string,
  userMessage: string,
): CopilotUiAction | undefined {
  // Search bot reply first, then user message.
  for (const text of [botReply, userMessage]) {
    for (const match of text.matchAll(TICKER_IN_TEXT)) {
      const ticker = match[1];
      if (FALSE_POSITIVE_WORDS.has(ticker)) continue;
      if (isOnOndo(ticker)) {
        return {
          type: 'showActButton',
          props: {
            ticker,
            ondoSymbol: `${ticker.toLowerCase()}on`,
            sentimentScore: 0, // not relevant here — button shows regardless
            reasoning: '',
          },
        };
      }
    }
  }
  return undefined;
}
