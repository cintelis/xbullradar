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
//
// As of Commit 2 (per-user refactor), every Store method takes a userId.
// Until Commit 4 wires real authenticated users into the route handlers,
// the existing routes pass SYSTEM_USER_ID as a temporary placeholder so
// the live deploy keeps working without disruption.

import path from 'path';
import { JsonFileStore } from './store-json';
import { createUpstashStore, getUpstashConfig } from './store-upstash';
import type { Store } from './store-types';

export type { Store } from './store-types';

/**
 * Temporary placeholder user ID used by route handlers that haven't been
 * wired to authenticated sessions yet. Removed entirely in Commit 4 once
 * every route reads `userId` from the session.
 *
 * `listUserIds()` excludes this ID so the daily scan cron doesn't keep
 * scanning a phantom user after real users sign in.
 */
export const SYSTEM_USER_ID = 'system';

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
