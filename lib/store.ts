// Persistence layer for xBullRadar.
//
// Default impl: JSON file at ./data/store.json (gitignored). Works locally
// and on any Node host (Vercel functions can use /tmp; Cloudflare Pages
// Functions need to swap this for KV/D1 — see the Store interface).
//
// To swap implementations, replace `defaultStore` at the bottom with a
// KV/D1 backed implementation that satisfies the Store interface.

import { promises as fs } from 'fs';
import path from 'path';
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

interface StoreData {
  watchlist: string[];
  holdings: PortfolioHolding[];
  lastSentiment: Record<string, StockSentiment>;
}

const DEFAULT_DATA: StoreData = {
  watchlist: ['NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMZN', 'META', 'GOOG'],
  holdings: [
    { ticker: 'NVDA', shares: 24, value: 14820, changePercent: 2.1, sentimentScore: 0 },
    { ticker: 'TSLA', shares: 10, value: 2410, changePercent: -0.8, sentimentScore: 0 },
    { ticker: 'AAPL', shares: 30, value: 6720, changePercent: 0.4, sentimentScore: 0 },
  ],
  lastSentiment: {},
};

class JsonFileStore implements Store {
  private readonly filePath: string;
  private cache: StoreData | null = null;
  private writePromise: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private async load(): Promise<StoreData> {
    if (this.cache) return this.cache;
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      this.cache = { ...DEFAULT_DATA, ...JSON.parse(raw) };
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        this.cache = { ...DEFAULT_DATA };
        await this.persist();
      } else {
        throw err;
      }
    }
    return this.cache!;
  }

  private async persist(): Promise<void> {
    // Serialize writes to avoid clobbering on concurrent updates.
    this.writePromise = this.writePromise.then(async () => {
      if (!this.cache) return;
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(this.cache, null, 2), 'utf-8');
    });
    return this.writePromise;
  }

  async getWatchlist(): Promise<string[]> {
    const data = await this.load();
    return [...data.watchlist];
  }

  async setWatchlist(tickers: string[]): Promise<void> {
    const data = await this.load();
    data.watchlist = tickers.map((t) => t.toUpperCase());
    await this.persist();
  }

  async getHoldings(): Promise<PortfolioHolding[]> {
    const data = await this.load();
    return data.holdings.map((h) => ({ ...h }));
  }

  async setHoldings(holdings: PortfolioHolding[]): Promise<void> {
    const data = await this.load();
    data.holdings = holdings.map((h) => ({ ...h }));
    await this.persist();
  }

  async getLastSentiment(ticker: string): Promise<StockSentiment | null> {
    const data = await this.load();
    return data.lastSentiment[ticker.toUpperCase()] ?? null;
  }

  async setLastSentiment(sentiment: StockSentiment): Promise<void> {
    const data = await this.load();
    data.lastSentiment[sentiment.ticker.toUpperCase()] = { ...sentiment };
    await this.persist();
  }

  async getAllLastSentiments(): Promise<Record<string, StockSentiment>> {
    const data = await this.load();
    return { ...data.lastSentiment };
  }
}

const storePath =
  process.env.XBULLRADAR_STORE_PATH ||
  path.join(process.cwd(), 'data', 'store.json');

export const store: Store = new JsonFileStore(storePath);
