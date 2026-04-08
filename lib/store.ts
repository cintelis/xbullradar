// Persistence layer router for xBullRadar.
//
// Picks an implementation based on env:
//   - UPSTASH_REDIS_REST_URL set → UpstashStore (production: Vercel + Upstash)
//   - otherwise                  → JsonFileStore (local dev only)
//
// Both implementations satisfy the same `Store` interface, defined in
// store-types.ts. Route handlers always import `store` from here and
// don't know which backend is in use.

import path from 'path';
import { JsonFileStore } from './store-json';
import { createUpstashStore } from './store-upstash';
import type { Store } from './store-types';

export type { Store } from './store-types';

function createStore(): Store {
  if (process.env.UPSTASH_REDIS_REST_URL) {
    return createUpstashStore();
  }
  const storePath =
    process.env.XBULLRADAR_STORE_PATH ||
    path.join(process.cwd(), 'data', 'store.json');
  return new JsonFileStore(storePath);
}

export const store: Store = createStore();
