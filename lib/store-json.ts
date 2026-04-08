// Local-dev persistence layer for xBullRadar.
//
// Writes to a JSON file at ./data/store.json (gitignored). Works locally
// and on any Node host with a writable filesystem. Does NOT work on
// Vercel/Cloudflare serverless — those have ephemeral or no filesystem.
// For production, use UpstashStore (lib/store-upstash.ts) instead.

import { promises as fs } from 'fs';
import path from 'path';
import type { PortfolioHolding, StockSentiment } from '@/types';
import type { Store, StoreData } from './store-types';
import { DEFAULT_DATA } from './store-types';

export class JsonFileStore implements Store {
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
