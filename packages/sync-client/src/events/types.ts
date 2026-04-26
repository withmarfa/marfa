/**
 * Typed event surface emitted by `MymeSyncClient`. Consumers subscribe
 * via `client.on(event, listener)` or iterate `client.events`.
 *
 * The shapes are deliberately rich: rejection events carry both the
 * local optimistic value and (when available) the server's view, so
 * the app can present a meaningful conflict UI without re-fetching.
 */

import type { Item, Edge } from "@mymehq/shared";

export type MutationKind =
  | "createItem"
  | "updateItem"
  | "deleteItem"
  | "restoreItem"
  | "transitionItem"
  | "purgeItem"
  | "createEdge"
  | "updateEdge"
  | "deleteEdge"
  | "setMetadata"
  | "mergeMetadata"
  | "addTags"
  | "removeTag"
  | "setExtension"
  | "deleteExtension"
  | "bulkItems"
  | "bulkEdges"
  | "bulkAction";

export interface MutationDescriptor {
  /** Stable client-generated UUIDv7. Doubles as the server-side `Idempotency-Key`. */
  id: string;
  kind: MutationKind;
  /** When the mutation was first enqueued. */
  enqueuedAt: Date;
}

export interface SyncEventMap {
  "sync.started": { at: Date };
  "sync.completed": { at: Date };
  "sync.failed": { at: Date; error: { code: string; message: string } };
  "mutation.queued": MutationDescriptor;
  "mutation.confirmed": MutationDescriptor & {
    /** Server-confirmed item / edge if applicable. */
    serverItem?: Item;
    serverEdge?: Edge;
  };
  "mutation.rejected": MutationDescriptor & {
    error: { code: string; message: string };
    /** What the app applied locally before the server rejected. */
    localValue: unknown;
    /** Server's current state, if returned in the rejection body. */
    serverValue?: unknown;
    attempts: number;
  };
  "mutation.dropped": MutationDescriptor & {
    reason: "cascade" | "permanent";
  };
  "auth.revoked": Record<string, never>;
  "schema.outdated": { localVersion: number; required: number };
}

export type SyncEventName = keyof SyncEventMap;

export interface SyncEventEnvelope<K extends SyncEventName = SyncEventName> {
  type: K;
  payload: SyncEventMap[K];
}
