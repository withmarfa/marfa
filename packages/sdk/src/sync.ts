// Sync entry point — re-exports everything from the main SDK plus sync additions.

// Main SDK exports
export * from "./index.js";

// Sync client
export { MymeSyncClient } from "./sync-client.js";
export type { SyncClientConfig } from "./sync-client.js";

// Connection state
export { ConnectionStateManager } from "./electric/connection-state.js";
export type { ConnectionState, ConnectionStateListener } from "./electric/connection-state.js";

// Local storage (for advanced usage)
export { createLocalStorage } from "./local/storage.js";
export type { LocalStorage } from "./local/storage.js";

// Mutation queue
export { MutationQueue } from "./electric/mutation-queue.js";
