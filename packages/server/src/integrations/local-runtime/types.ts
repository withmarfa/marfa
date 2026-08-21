/**
 * Shared types for the local integrations runtime substrate.
 *
 * The in-process integration runtime replaces
 * the Cloudflare side of the dispatch loop (Workers + Queues + Durable
 * Objects + KV) with a Node-bundled equivalent backed by Postgres
 * (pg-boss) and `worker_thread` per-Integration handler pools. The
 * authoring surface (`@withmarfa/runtime-sdk`) is unchanged — integrations
 * import the same primitives and run on either substrate.
 */
import type {
  HandlerResult,
  QueueMessage,
  RuntimeCredential,
} from "@withmarfa/runtime-sdk";

/**
 * An integration registered with the local runtime supervisor. Built by
 * the boot phase from the in-tree integration `local.ts` entries:
 *
 *   - `dispatch` runs one queue message synchronously. The supervisor
 *     wraps the call with the advisory-lock + cursor-state plumbing.
 *   - `manifest` is read for the schedule cron + bidirectional handling
 *     (echo TTL).
 *   - `handlerModulePath` is the absolute path to the integration's
 *     handler entry — passed to the worker_thread so each thread can
 *     `await import()` the handlers once on startup.
 */
export interface LocalIntegrationRegistration {
  /** Manifest name. The supervisor uses this for queue naming + the
   *  envelope filter that drives the per-Integration handler pool. */
  name: string;
  /**
   * Path to the integration's per-substrate handler entry. The worker
   * thread `await import()`s this file before processing any messages.
   *
   * Tests register a `null` path and supply a `directDispatch` callback
   * instead — exercising the runtime substrate without spawning a worker
   * thread per integration.
   */
  handlerModulePath: string | null;
  /**
   * Test-only synchronous dispatch. When set, the supervisor skips the
   * worker_thread pool and calls this directly. Production registrations
   * leave it `undefined`.
   */
  directDispatch?: DirectDispatchFn;
  /** Manifest cron expression for schedule-driven integrations. Webhook /
   *  item-event-only integrations leave this `undefined` and the
   *  supervisor skips schedule registration. */
  scheduleCron?: string;
  /** Bidirectional handling block from the manifest — drives the echo
   *  suppression TTL for handler dispatch. */
  echo: { echo_ttl_seconds: number; lag_window_seconds?: number };
  /** Set of trigger kinds the manifest declares; drives queue routing
   *  (a webhook-only integration won't have schedule fanout). */
  triggerKinds: ReadonlySet<"schedule" | "webhook" | "item-event" | "manual">;
}

/**
 * Direct-dispatch callback shape — used by test registrations to bypass
 * the worker_thread pool while still exercising the supervisor's lock /
 * cursor plumbing.
 */
export type DirectDispatchFn = (
  request: WorkerDispatchRequest,
) => Promise<WorkerDispatchResponse>;

/**
 * Wire payload posted from the supervisor (main thread) into a
 * worker_thread for one queue message. Structured-clone safe — no
 * functions, no class instances, no DB handles. The worker rebuilds the
 * ConnectionContext locally from these primitives.
 */
export interface WorkerDispatchRequest {
  apiUrl: string;
  credential: RuntimeCredential;
  message: QueueMessage;
  integrationName: string;
  echo: { echo_ttl_seconds: number; lag_window_seconds?: number };
  /** Space id the credential is bound to (defense-in-depth filter
   *  inside the consumer). */
  spaceId?: string;
  /** SDK-level cycle hop ceiling. */
  hopBudget?: number;
  /** Snapshot of the connection's `connection.runtime.cursors` namespace
   *  at dispatch time. Per-Connection writes are journalled in the worker
   *  and replayed against the live extension by the supervisor on
   *  completion — same lock holds for the whole flow. */
  cursorSnapshot: Record<string, unknown>;
}

/**
 * Wire payload returned from the worker_thread back to the supervisor.
 * The handler's effect on per-Connection state is captured as a delta so
 * the supervisor can apply it under the same advisory lock that gated
 * the dispatch.
 */
export interface WorkerDispatchResponse {
  result: HandlerResult;
  /**
   * Cursor mutations the handler issued. The supervisor merges these
   * into the live `connection.runtime.cursors` extension before releasing
   * the lock; a missing key means no change, an explicit `null` value
   * means delete.
   */
  cursorUpdates: Record<string, unknown>;
  /**
   * Set of cursor keys that the handler explicitly deleted (distinguishes
   * delete from "set to null"). Replayed by the supervisor on commit.
   */
  cursorDeletes: string[];
  /**
   * Whether the worker threw before producing a HandlerResult. The
   * supervisor uses this to mirror Cloudflare's "throw on first attempt
   * → retry, throw on later attempt → permanent" semantics.
   */
  threw: boolean;
  thrownMessage?: string;
  thrownClassName?: string;
}

/**
 * Job payload pushed onto pg-boss for one (integration, connection)
 * dispatch unit. Carries the `QueueMessage` envelope plus the
 * integration_name tag so the consumer routes to the right registration.
 */
export interface SchedulerEnvelope {
  /** Always carried so the consumer can filter at dispatch time. */
  integration_name: string;
  message: QueueMessage;
}

/** Public surface of a running local runtime. */
export interface LocalRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Enqueue a job onto the queue for a given integration. Exposed so the
   * webhook route + reactive-bridge subscriber can push messages without
   * having to know about pg-boss directly.
   */
  enqueue(envelope: SchedulerEnvelope): Promise<void>;
  /**
   * Test-only synchronous dispatch path that hands a message to the
   * executor with cursor / lock plumbing applied. Bypasses pg-boss
   * entirely so tests don't need a queue worker tick. `attempt` stands
   * in for the queue's redelivery count.
   */
  dispatchForTest(
    envelope: SchedulerEnvelope,
    attempt?: number,
  ): Promise<HandlerResult>;
  /**
   * Look up an integration by name. Used by the webhook receipt route to
   * resolve `integration_name` → registration before enqueueing.
   */
  getRegistration(name: string): LocalIntegrationRegistration | undefined;
}
