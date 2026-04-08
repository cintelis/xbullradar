// Persistence layer router for xBullRadar.
//
// Picks an implementation based on env:
//   - Any supported Upstash env var pair set → UpstashStore (production)
//   - otherwise                              → JsonFileStore (local dev)
//
// See `getUpstashConfig()` in store-upstash.ts for the list of accepted
// env var names — supports manual, integration-default, and custom-prefix
// setups so this works regardless of how Upstash was provisioned.
//
// Both implementations satisfy the same `Store` interface, defined in
// store-types.ts. Route handlers always import `store` from here and
// don't know which backend is in use.

import path from 'path';
import { JsonFileStore } from './store-json';
import { createUpstashStore, getUpstashConfig } from './store-upstash';
import type { Store } from './store-types';

export type { Store } from './store-types';

function createStore(): Store {
  if (getUpstashConfig()) {
    return createUpstashStore();
  }
  const storePath =
    process.env.XBULLRADAR_STORE_PATH ||
    path.join(process.cwd(), 'data', 'store.json');
  return new JsonFileStore(storePath);
}

export const store: Store = createStore();
