// Shared types and defaults for all Store implementations.
// Kept in its own file so the JSON impl and the Upstash impl don't need
// to import each other.

import type { PortfolioHolding, StockSentiment } from '@/types';

export interface Store {
  getWatchlist(): Promise<string[]>;
  setWatchlist(tickers: string[]): Promise<void>;

  getHoldings(): Promise<PortfolioHolding[]>;
  setHoldings(holdings: PortfolioHolding[]): Promise<void>;

  getLastSentiment(ticker: string): Promise<StockSentiment | null>;
  setLastSentiment(sentiment: StockSentiment): Promise<void>;
  getAllLastSentiments(): Promise<Record<string, StockSentiment>>;
}

export interface StoreData {
  watchlist: string[];
  holdings: PortfolioHolding[];
  lastSentiment: Record<string, StockSentiment>;
}

export const DEFAULT_DATA: StoreData = {
  watchlist: ['NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMZN', 'META', 'GOOG'],
  holdings: [
    { ticker: 'NVDA', shares: 24, value: 14820, changePercent: 2.1, sentimentScore: 0 },
    { ticker: 'TSLA', shares: 10, value: 2410, changePercent: -0.8, sentimentScore: 0 },
    { ticker: 'AAPL', shares: 30, value: 6720, changePercent: 0.4, sentimentScore: 0 },
  ],
  lastSentiment: {},
};
