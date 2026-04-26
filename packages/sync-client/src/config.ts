/**
 * Configuration types for `@mymehq/sync-client`.
 *
 * These are split from the `client.ts` class file so that React hooks
 * and the storage layer can import shared types without pulling in the
 * full client runtime.
 */

/**
 * Where the local PGlite store lives.
 *
 * - `'memory'` — RAM only, no persistence. Default. Good for tests.
 * - `'idb:<name>'` — IndexedDB (browser, Electron renderer).
 * - `'fs:<path>'` — Node filesystem (Electron main, Node).
 * - `{ adapter }` — caller-provided PGlite-compatible adapter for
 *   advanced wiring (custom WASM hosts, multi-process Electron).
 */
export type StorageOption =
  | "memory"
  | `idb:${string}`
  | `fs:${string}`
  | { adapter: PGliteAdapter };

/**
 * Minimal interface a custom storage adapter must implement. Only the
 * tiny surface the sync-client uses; the full PGlite type is exported
 * separately for consumers who want everything.
 */
export interface PGliteAdapter {
  /** Identifier used for diagnostics; not user-visible. */
  readonly id: string;
}

/**
 * Where the sync-client should send shape requests. The path layout
 * follows the Myme server's `/sync/shapes/:family` proxy.
 */
export interface ServerEndpoints {
  /** Base URL of the Myme HTTP API. e.g. `https://atlas.local:8602`. */
  apiUrl: string;
  /**
   * Base URL of the sync proxy. Defaults to `${apiUrl}/sync` — the
   * canonical shape served by the Myme server. Override only when
   * fronting Myme behind a non-default reverse proxy.
   */
  syncUrl?: string;
}

/**
 * Initial-sync mode for `MymeSyncClient.start()`. The two modes share
 * the eventual outcome — local PGlite ends up consistent with the
 * server — but differ in how aggressively bootstrap pulls server state
 * before considering startup complete.
 */
export type InitialSyncMode =
  /** Pull a full snapshot before resolving `start()`. */
  | "eager"
  /** Stream-only — start() resolves once shapes are subscribed. */
  | "lazy";

export interface MymeSyncClientOptions extends ServerEndpoints {
  /** API key (myme_k1_…). Sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string;
  /** Where the local PGlite database lives. Default: `'memory'`. */
  storage?: StorageOption;
  /** Override `globalThis.fetch`. Defaults to global. */
  fetch?: typeof fetch;
  /** `'eager'` (default) or `'lazy'`. */
  initialSync?: InitialSyncMode;
  /**
   * Stamped onto every queued mutation as `source`. Defaults to
   * `'@mymehq/sync-client'`. Apps that span multiple installs typically
   * pass an app-specific identifier so server-side audit can attribute.
   */
  source?: string;
  /** Logged on every queued mutation. Optional. */
  device?: string;
  /** Invoked when the server returns 401. App should re-auth. */
  onAuthRevoked?: () => void;
  /** Optional logger. Defaults to a no-op. */
  logger?: SyncLogger;
  /**
   * Whether `start()` also starts the read-path sync engine. Default
   * `true`. Set `false` for tests that exercise bootstrap behaviour
   * without spinning up a network-bound engine.
   */
  autoStartSync?: boolean;
}

export interface SyncLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export const noopLogger: SyncLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export const DEFAULT_SOURCE = "@mymehq/sync-client";
