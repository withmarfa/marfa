/**
 * Sync state surface — the typed view consumers observe via
 * `client.observeSyncState()` and the React `useSyncState()` hook.
 */

export type SyncState =
  /** Pre-`start()` or recovering. */
  | "starting"
  /** Online, queue empty, no shape changes pending. */
  | "idle"
  /** Online, draining the queue or streaming a snapshot. */
  | "syncing"
  /** Network or shape stream is down. Reads still work from PGlite. */
  | "offline"
  /** Unrecoverable (e.g. schema drift, auth revoked). */
  | "error";

export interface SyncStateInfo {
  state: SyncState;
  /** How many writes are waiting in the durable queue. */
  pendingMutations: number;
  /** ISO timestamp of the last successful full or incremental sync. */
  lastSyncedAt: Date | null;
  /**
   * Per-shape Electric handle/offset, useful for diagnostics. Keyed by
   * shape family ('items' / 'edges' / 'metadata').
   */
  shapeCursors: Record<string, { handle: string; offset: string } | null>;
  /** Set when `state === 'error'`. */
  error?: { code: string; message: string };
}

export const INITIAL_SYNC_STATE: SyncStateInfo = {
  state: "starting",
  pendingMutations: 0,
  lastSyncedAt: null,
  shapeCursors: { items: null, edges: null, metadata: null },
};
