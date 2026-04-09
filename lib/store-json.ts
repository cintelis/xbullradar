// Local-dev persistence layer for xBullRadar.
//
// Writes to a JSON file at ./data/store.json (gitignored). Per-user as of
// Commit 2 — the on-disk schema is `{ users: { [userId]: UserData } }`.
// Works locally and on any Node host with a writable filesystem. Does NOT
// work on Vercel/Cloudflare serverless — those have ephemeral or no
// filesystem. For production, use UpstashStore (lib/store-upstash.ts).

import { promises as fs } from 'fs';
import path from 'path';
import type { CashHolding, PortfolioHolding, StockSentiment } from '@/types';
import type { Store, UserData } from './store-types';
import { DEFAULT_USER_DATA } from './store-types';

interface StoreData {
  users: Record<string, UserData>;
}

const EMPTY_STORE: StoreData = {
  users: {},
};

function cloneDefaultUserData(): UserData {
  return {
    watchlist: [...DEFAULT_USER_DATA.watchlist],
    holdings: DEFAULT_USER_DATA.holdings.map((h) => ({ ...h })),
    cash: [],
    lastSentiment: {},
  };
}

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
      const parsed = JSON.parse(raw);
      // Defensive: ensure { users: {} } shape even if file is partial.
      this.cache = { users: parsed?.users && typeof parsed.users === 'object' ? parsed.users : {} };
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        this.cache = JSON.parse(JSON.stringify(EMPTY_STORE));
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

  /**
   * Returns the user's data slot, creating it with defaults if it doesn't
   * exist yet. Caller must persist after mutation.
   *
   * Also fills in any missing fields on legacy users (e.g. existing on-
   * disk records that predate the `cash` field) so callers can assume the
   * full UserData shape.
   */
  private async ensureUser(userId: string): Promise<UserData> {
    const data = await this.load();
    if (!data.users[userId]) {
      data.users[userId] = cloneDefaultUserData();
      await this.persist();
    }
    const user = data.users[userId];
    // Backfill fields added after the original schema. Don't persist on
    // read — let the next mutation save the upgraded shape.
    if (!Array.isArray(user.cash)) user.cash = [];
    return user;
  }

  async getWatchlist(userId: string): Promise<string[]> {
    const user = await this.ensureUser(userId);
    return [...user.watchlist];
  }

  async setWatchlist(userId: string, tickers: string[]): Promise<void> {
    const user = await this.ensureUser(userId);
    user.watchlist = tickers.map((t) => t.toUpperCase());
    await this.persist();
  }

  async getHoldings(userId: string): Promise<PortfolioHolding[]> {
    const user = await this.ensureUser(userId);
    return user.holdings.map((h) => ({ ...h }));
  }

  async setHoldings(userId: string, holdings: PortfolioHolding[]): Promise<void> {
    const user = await this.ensureUser(userId);
    user.holdings = holdings.map((h) => ({ ...h }));
    await this.persist();
  }

  async getCash(userId: string): Promise<CashHolding[]> {
    const user = await this.ensureUser(userId);
    return user.cash.map((c) => ({ ...c }));
  }

  async setCash(userId: string, cash: CashHolding[]): Promise<void> {
    const user = await this.ensureUser(userId);
    user.cash = cash.map((c) => ({ ...c }));
    await this.persist();
  }

  async getLastSentiment(userId: string, ticker: string): Promise<StockSentiment | null> {
    const user = await this.ensureUser(userId);
    return user.lastSentiment[ticker.toUpperCase()] ?? null;
  }

  async setLastSentiment(userId: string, sentiment: StockSentiment): Promise<void> {
    const user = await this.ensureUser(userId);
    user.lastSentiment[sentiment.ticker.toUpperCase()] = { ...sentiment };
    await this.persist();
  }

  async getAllLastSentiments(userId: string): Promise<Record<string, StockSentiment>> {
    const user = await this.ensureUser(userId);
    return { ...user.lastSentiment };
  }

  async listUserIds(): Promise<string[]> {
    const data = await this.load();
    return Object.keys(data.users).filter((id) => id !== 'system');
  }
}
