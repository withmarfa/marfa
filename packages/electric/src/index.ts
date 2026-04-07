// @myme/electric — Electric SQL sync layer for Myme.

// Re-export everything from the SDK for convenience
export * from "@myme/sdk";

// Sync client
export { MymeSyncClient } from "./sync-client.js";
export type { SyncClientConfig } from "./sync-client.js";

// Connection state
export { ConnectionStateManager } from "./electric/connection-state.js";
export type {
  ConnectionState,
  ConnectionStateListener,
} from "./electric/connection-state.js";

// Local storage (for advanced usage)
export { createLocalStorage } from "./local/storage.js";
export type { LocalStorage } from "./local/storage.js";

// Mutation queue
export { MutationQueue } from "./electric/mutation-queue.js";
