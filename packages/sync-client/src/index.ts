/**
 * `@mymehq/sync-client` — public entry point.
 *
 * Two import paths:
 *   - `@mymehq/sync-client`        — framework-agnostic core
 *   - `@mymehq/sync-client/react`  — React hooks + provider
 *
 * Vue / Svelte / vanilla adapters can drop into sibling subpaths later
 * without restructuring; the core is framework-free.
 */

export { MymeSyncClient } from "./client.js";
export type {
  MymeSyncClientOptions,
  StorageOption,
  PGliteAdapter,
  ServerEndpoints,
  InitialSyncMode,
  SyncLogger,
} from "./config.js";
export type { SyncState, SyncStateInfo } from "./sync/state.js";
export type {
  MutationKind,
  MutationDescriptor,
  SyncEventMap,
  SyncEventName,
  SyncEventEnvelope,
} from "./events/types.js";
export { SCHEMA_VERSION } from "./storage/schema.js";
