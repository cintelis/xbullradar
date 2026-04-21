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
 * Live on-chain price snapshot for a tokenized Ondo asset. Returned by
 * GET /api/ondo/asset?ticker=X and used to show the tokenized vs
 * underlying stock price alongside the premium/discount spread.
 *
 * premiumPct is a raw percentage (e.g. 0.028 = +0.028%, not 2.8%).
 */
export interface OndoAssetData {
  ondoSymbol: string;
  ticker: string;
  tokenPrice: number;
  stockPrice: number;
  premiumPct: number;
  timestamp: number;
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
 * Non-equity entries the user holds — cash, stablecoins, bonds, anything
 * that isn't a tradeable ticker. Each entry is just a USD value with a
 * label and category. We don't compute price or day-change for these
 * because they don't have a market quote (cash IS the price).
 *
 * Treated by the portfolio totals as having an Equity Risk Premium of
 * exactly 0 — they earn approximately the risk-free rate (money-market
 * yields, on-chain stablecoin yields like Aave/Ondo, treasury yields)
 * which is the same thing the ERP formula subtracts. Including cash in
 * the portfolio ERP correctly drags it toward zero, so a 50% cash
 * portfolio shows roughly half the equity-only ERP.
 *
 * Direct bond holdings (e.g. you own a $10k 5-year T-note) are tracked
 * with category 'bond' but get the same ERP=0 treatment for now. Bond
 * ETFs (TLT, SGOV, AGG, etc.) should be tracked as regular holdings,
 * not cash entries — they have prices and sentiment.
 */
export type CashCategory = 'cash' | 'stablecoin' | 'bond' | 'other';

export interface CashHolding {
  /** Stable id for React keys + edit/remove operations. */
  id: string;
  /** User-supplied label, e.g. "Schwab brokerage", "USDC wallet", "5Y T-note". */
  label: string;
  /** USD value of the entry. Always positive. */
  amount: number;
  category: CashCategory;
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
