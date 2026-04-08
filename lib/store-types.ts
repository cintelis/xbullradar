// Shared types and defaults for all Store implementations.
//
// As of Commit 2 (per-user data refactor), every method on the Store
// interface takes a `userId`. Each user has their own watchlist, holdings,
// and last-sentiment map. New users are seeded with DEFAULT_USER_DATA on
// first access.

import type { PortfolioHolding, StockSentiment } from '@/types';

export interface Store {
  getWatchlist(userId: string): Promise<string[]>;
  setWatchlist(userId: string, tickers: string[]): Promise<void>;

  getHoldings(userId: string): Promise<PortfolioHolding[]>;
  setHoldings(userId: string, holdings: PortfolioHolding[]): Promise<void>;

  getLastSentiment(userId: string, ticker: string): Promise<StockSentiment | null>;
  setLastSentiment(userId: string, sentiment: StockSentiment): Promise<void>;
  getAllLastSentiments(userId: string): Promise<Record<string, StockSentiment>>;

  /**
   * Enumerate all userIds that have ever stored data. Used by the daily
   * scan cron to iterate over every user's watchlist. Implementations
   * SHOULD NOT include the system user in this list — that's a transient
   * placeholder until Commit 4 fully wires real users.
   */
  listUserIds(): Promise<string[]>;
}

/**
 * Per-user data shape. Used as both the JsonFileStore on-disk schema and
 * as a logical grouping inside UpstashStore (which splits each field into
 * its own Redis key).
 */
export interface UserData {
  watchlist: string[];
  holdings: PortfolioHolding[];
  lastSentiment: Record<string, StockSentiment>;
}

/**
 * Default seed for any new user. Pre-populates the watchlist so the
 * dashboard isn't empty on first sign-in. Holdings start empty — the
 * PortfolioOverview component is hidden until a real holdings input UI
 * exists (Phase 2).
 */
export const DEFAULT_USER_DATA: UserData = {
  watchlist: ['NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMZN', 'META', 'GOOG'],
  holdings: [],
  lastSentiment: {},
};
