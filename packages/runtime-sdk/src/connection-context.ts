/**
 * The handler-facing surface — a single object passed into every
 * registered handler that bundles the per-Connection facilities the
 * integration needs.
 *
 * Concrete construction lives in connection-context-builder.ts (called
 * by the queue consumer); this module is the type contract handlers
 * code against.
 */
import type { ConnectionClient } from "./connection-client.js";
import type { CursorStore } from "./cursor-store.js";
import type { ActivitySink } from "./activity.js";
import type { EchoSuppression } from "./echo-suppression.js";
import type { CycleMetadata } from "./types.js";

export interface ConnectionContext {
  /** Stable IDs for the run. */
  connection_id: string;
  integration_name: string;
  tenant_id?: string;

  /** Authenticated Myme API client scoped to this Connection. */
  myme: ConnectionClient;

  /** Read/write opaque cursor state from the per-Connection DO. */
  cursor: CursorStore;

  /** Emit `system.activity` rows attributed to this Connection. */
  activity: ActivitySink;

  /** Bidirectional-handling helpers (echo suppression, lag window). */
  echo: EchoSuppression;

  /** Hop budget metadata for this run, if it originated from an
   *  item-event. Schedule + webhook runs leave this null because they
   *  start a fresh hop chain. */
  cycle: CycleMetadata | null;
}
