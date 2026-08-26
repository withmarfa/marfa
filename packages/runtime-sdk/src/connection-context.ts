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
import type { MappingResolver } from "./mapping.js";
import type { CycleMetadata } from "./types.js";
import type { Budget } from "./budget.js";

export interface ConnectionContext {
  /** Stable IDs for the run. */
  connection_id: string;
  integration_name: string;
  space_id?: string;

  /** Authenticated Marfa API client scoped to this Connection. */
  marfa: ConnectionClient;

  /** Read/write opaque cursor state from the connection's runtime
   *  storage. */
  cursor: CursorStore;

  /** Emit `system.activity` rows attributed to this Connection. */
  activity: ActivitySink;

  /** Bidirectional-handling helpers (echo suppression, lag window). */
  echo: EchoSuppression;

  /** The per-connection user-mapping resolver. Handlers present each
   *  upstream-faithful record before building its write; the answer is
   *  the user's routing, the family fallthrough, or a counted skip. */
  mapping: MappingResolver;

  /** Hop budget metadata for this run, if it originated from an
   *  item-event. Schedule + webhook runs leave this null because they
   *  start a fresh hop chain. */
  cycle: CycleMetadata | null;

  /** How much of this dispatch's allowance is left, and the signal that
   *  fires when it runs out. Poll `shouldYield` between units of work. */
  budget: Budget;
}
