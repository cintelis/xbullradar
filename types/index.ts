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

export interface PortfolioHolding {
  ticker: string;
  shares: number;
  value: number;
  changePercent: number;
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
