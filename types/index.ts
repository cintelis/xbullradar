// Shared domain types for xBullRadar.

export interface StockSentiment {
  ticker: string;
  score: number;        // -1.0 (bearish) to +1.0 (bullish)
  reasoning: string;
  responseId?: string;  // Grok Responses API previous_response_id for stateful turns
  citations?: string[]; // URLs Grok grounded the sentiment on (X posts, web pages)
}

export interface OndoTokenizedAsset {
  ticker: string;
  ondoSymbol: string;       // e.g. "nvdaon"
  sentimentScore: number;
  reasoning?: string;
  currentPrice?: number;
  name?: string;
}

/**
 * Persisted portfolio holding — the source-of-truth shape stored in Upstash
 * (or JsonFileStore in dev). Just ticker + shares; everything else is
 * computed at read time from the price + sentiment caches.
 *
 * No cost basis for MVP — see project_polygon_features.md memory note.
 */
export interface PortfolioHolding {
  ticker: string;
  shares: number;
}

/**
 * Enriched holding returned by the /api/portfolio GET endpoint. Adds the
 * computed fields the UI needs: end-of-day price, day change %, total
 * value, and the latest Grok sentiment score.
 *
 * All computed fields are nullable: a ticker might not be in the price
 * cache (typo, new IPO, non-US-listed) and might not have a recent
 * sentiment scan (just-added watchlist entry).
 */
export interface EnrichedPortfolioHolding extends PortfolioHolding {
  /** End-of-day close price for the most recent trading day. Null if missing from price cache. */
  lastClose: number | null;
  /** Previous trading day close. Null if missing or only one day of data. */
  prevClose: number | null;
  /** Day-over-day percent change. Null if either close is missing. */
  dayChangePercent: number | null;
  /** shares × lastClose. Null if lastClose is missing. */
  value: number | null;
  /** Latest Grok sentiment score from the user's watchlist scan, or 0 if not scanned yet. */
  sentimentScore: number;
}

// === Copilot wire shape (server -> client) ===
// Flat, intentionally NOT CopilotKit's GraphQL/AG-UI envelope.
// The custom CopilotChat component renders `ui` inline when present.
export type CopilotUiAction =
  | {
      type: 'showActButton';
      props: {
        ticker: string;
        ondoSymbol: string;
        sentimentScore: number;
        reasoning?: string;
      };
    };

export interface CopilotResponse {
  message: string;
  ui?: CopilotUiAction;
  responseId?: string;
  citations?: string[];
}

export interface CopilotRequest {
  message: string;
  previousResponseId?: string;
}
