/**
 * Reactive-run bridge — drains the in-process item-event stream and
 * forwards each event to the Cloudflare Queues HTTP producer endpoint
 * (the default transport for the hosted runtime).
 *
 * Self-hosters who don't have Cloudflare Queues can swap the transport
 * at the bridge layer — Postgres LISTEN/NOTIFY, in-process consumers,
 * or a polling integration runtime are the candidates.
 *
 * The bridge is OPT-IN: it only runs when both
 * `CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS` and `CLOUDFLARE_QUEUES_API_TOKEN`
 * are set. Self-hoster instances leave both unset and the bridge is a
 * no-op startup-time function. Server tests skip the bridge.
 *
 * Per-integration queues — each integration that declares an
 * `item-event` trigger has its own producer URL; the bridge resolves
 * `integration_name` → URL at fanout time. Cloudflare Queues only
 * allows one consumer per queue — a shared queue silently drops
 * messages addressed to any integration other than the
 * consumer-claiming Worker. The per-integration shape mirrors the
 * existing scheduled-poll + webhook-receipt families.
 *
 * Concurrency: the bridge is gated by
 * `coordination.withJobLock("reactive-run-bridge", ...)` so
 * multi-instance deployments only run one drainer.
 *
 * Cycle metadata flows through verbatim: the queue message envelope
 * carries `originating_connection_id` and `hop_count` so the
 * integration SDK can refuse to re-publish at budget.
 *
 * Subscription registry — the bridge maintains an in-memory map of
 * `connection_id → { integration_name, ... }` for every
 * `system.connection` of kind `integration` whose manifest declares at
 * least one `item-event` trigger. Each inbound event fans out to one
 * queue message per subscribing connection. Cache invalidation: a
 * separate subscriber listens for `system.connection` lifecycle events
 * (created/updated/deleted) and refreshes the affected entry.
 */
import type { Item } from "@withmarfa/shared";
import { Pool } from "undici";
import { publish, subscribe, type ItemEventWithId } from "../pubsub.js";
import type { Storage } from "../storage/interface.js";
import {
  buildEntryForConnection,
  buildQueueMessageBody,
  evaluateDispatch,
  type QueueMessageBody,
  type SubscriptionEntry,
} from "./envelope.js";

/**
 * Per-subscriber failure tracking thresholds.
 *
 * Two stages compose:
 *   - In-memory cooldown: absorbs transient blips. A subscriber that
 *     fails `COOLDOWN_THRESHOLD` consecutive event-loops (each loop is
 *     up to `maxAttempts` network retries) enters a `COOLDOWN_MS` quiet
 *     window during which the bridge skips dispatch silently. Reset on
 *     the next successful (2xx) publish. Cap stops indefinite extension
 *     if events keep firing.
 *   - Persistent terminal state: a subscriber that fails
 *     `ESCALATION_THRESHOLD` consecutive event-loops gets its underlying
 *     `system.connection` item flipped to `runtime_status: "failing"`,
 *     and a `system.activity` row of severity `action_required` is
 *     emitted. `buildEntryForConnection` then gates further dispatch out.
 *     Cleared via the cache-invalidation subscriber when an operator
 *     transitions `runtime_status` off `failing`.
 *
 * Counts are event-loops, not network attempts — one count represents
 * one full `sendOne` retry exhaustion (5 attempts + exponential backoff)
 * or one immediate 4xx rejection (both treated as failures).
 */
const COOLDOWN_THRESHOLD = 3;
const ESCALATION_THRESHOLD = 10;
const COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 5 * 60_000;
const UNMAPPED_ACTIVITY_RETRY_BASE_MS = 1_000;
const UNMAPPED_ACTIVITY_RETRY_MAX_MS = 60_000;
/** Fallback per-fetch send timeout when no `sendTimeoutMs` is supplied
 *  (test harnesses that build a partial `BridgeConfig`). Production wires
 *  `AppConfig.reactiveRunSendTimeoutMs` (env `MARFA_REACTIVE_RUN_SEND_TIMEOUT_MS`)
 *  through `index.ts`, so the operator-tunable value is the live one. */
const DEFAULT_SEND_TIMEOUT_MS = 5_000;

interface SubscriberFailureState {
  consecutiveFailures: number;
  /** Epoch ms after which the cooldown gate stops skipping. `null` when
   *  the subscriber is below the cooldown threshold. */
  cooldownUntil: number | null;
}

interface UnmappedActivityState {
  reported: boolean;
  inFlight: Promise<void> | null;
  consecutiveFailures: number;
  retryAfter: number;
}

/** Result discriminator for `sendOne`. Lets `fanoutEvent` distinguish
 *  success (reset failure counter) from rejection (don't reset) from
 *  exhaustion (escalate). */
type SendOneResult = "success" | "rejected";

export interface BridgeConfig {
  /**
   * Resolves the Cloudflare Queues producer URL for a given
   * `integration_name`. The bridge calls this for every fanout target.
   *
   * Return `null` for an unmapped integration — the bridge logs an
   * error, emits a one-time `action_required` `system.activity` row
   * (per integration per process lifetime), and skips dispatch. The
   * subscriber's failure ladder is NOT incremented because an unmapped
   * integration is a server-side env-config gap, not a connection
   * health issue.
   *
   * Production wiring reads `CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS`
   * (JSON map of `integration_name → producer URL`); tests pass a
   * function directly.
   */
  resolveQueueUrl: (integrationName: string) => string | null;
  apiToken: string;
  /** Per-batch send size; the producer endpoint accepts up to ~100. */
  batchSize?: number;
  /** Maximum send attempts before giving up on a batch. */
  maxAttempts?: number;
  /**
   * Per-fetch timeout in milliseconds for the queue producer call. A slow
   * Cloudflare Queues endpoint would otherwise stall the bridge during
   * fanout. Production wires this from
   * `AppConfig.reactiveRunSendTimeoutMs` (env
   * `MARFA_REACTIVE_RUN_SEND_TIMEOUT_MS`); unset falls back to
   * `DEFAULT_SEND_TIMEOUT_MS`. On timeout the failure is logged and
   * surfaced as `system.activity` of severity error, then fanout
   * continues to the next subscriber.
   */
  sendTimeoutMs?: number;
  /**
   * Consecutive `sendOne` rejections before the in-memory cooldown gate
   * arms. Each tick represents one exhausted retry loop (or one
   * immediate 4xx). Default 3.
   */
  failureCooldownThreshold?: number;
  /**
   * Consecutive `sendOne` rejections before the underlying
   * `system.connection` item is flipped to `runtime_status: "failing"`
   * and a `system.activity action_required` row is emitted. Default 10.
   */
  failureEscalationThreshold?: number;
  /**
   * Cooldown window (ms) the bridge skips dispatch after a subscriber
   * crosses `failureCooldownThreshold`. Default 60_000.
   */
  failureCooldownMs?: number;
  /**
   * Upper bound (ms from now) on cooldown extension when failures keep
   * arriving. Each new failure extends the window; this caps total
   * extension so a busy event stream can't push cooldown arbitrarily far
   * into the future. Default 5 minutes.
   */
  failureCooldownMaxMs?: number;
  /** Initial retry delay for a failed unmapped-integration activity write. */
  unmappedActivityRetryBaseMs?: number;
  /** Maximum retry delay for failed unmapped-integration activity writes. */
  unmappedActivityRetryMaxMs?: number;
  /** Epoch-millisecond clock override for deterministic alert-backoff tests. */
  unmappedActivityNow?: () => number;
  /** Custom fetch (for tests). */
  fetch?: typeof fetch;
}

export interface BridgeRuntime {
  start(): Promise<void>;
  /** Stop the drainer + invalidation subscriber and wait for the
   *  underlying coordination lock to release. Returns a Promise so
   *  callers (and tests) can wait for the cleanup to settle. */
  stop(): Promise<void>;
}

/**
 * Build a bridge runtime that connects the in-process pubsub to the
 * Cloudflare Queues HTTP producer. Returns null when the bridge env
 * vars are unset (self-hoster path).
 *
 * Two activation conditions, both must hold:
 *   1. `CLOUDFLARE_QUEUES_API_TOKEN` set (or `config.apiToken`).
 *   2. EITHER `config.resolveQueueUrl` supplied (test path), OR
 *      `CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS` parses into a non-empty
 *      JSON map.
 *
 * Unparseable env-var JSON logs an error and returns null — better to
 * boot the server with the bridge disabled (surfaces in the
 * `"Reactive-run bridge disabled"` log line + the empty activity
 * stream) than to boot with a half-built resolver that maps nothing.
 */
export function tryStartReactiveRunBridge(
  storage: Storage,
  config?: Partial<BridgeConfig>,
): BridgeRuntime | null {
  const resolveQueueUrl = config?.resolveQueueUrl ?? buildResolverFromEnv();
  const apiToken = config?.apiToken ?? process.env.CLOUDFLARE_QUEUES_API_TOKEN;
  if (!resolveQueueUrl || !apiToken) return null;
  return createBridge(storage, {
    resolveQueueUrl,
    apiToken,
    batchSize: config?.batchSize ?? 10,
    maxAttempts: config?.maxAttempts ?? 5,
    sendTimeoutMs: config?.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS,
    failureCooldownThreshold:
      config?.failureCooldownThreshold ?? COOLDOWN_THRESHOLD,
    failureEscalationThreshold:
      config?.failureEscalationThreshold ?? ESCALATION_THRESHOLD,
    failureCooldownMs: config?.failureCooldownMs ?? COOLDOWN_MS,
    failureCooldownMaxMs: config?.failureCooldownMaxMs ?? MAX_COOLDOWN_MS,
    unmappedActivityRetryBaseMs:
      config?.unmappedActivityRetryBaseMs ?? UNMAPPED_ACTIVITY_RETRY_BASE_MS,
    unmappedActivityRetryMaxMs:
      config?.unmappedActivityRetryMaxMs ?? UNMAPPED_ACTIVITY_RETRY_MAX_MS,
    unmappedActivityNow: config?.unmappedActivityNow ?? Date.now,
    fetch: config?.fetch,
  });
}

/**
 * Read `CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS` and build a resolver from
 * it. JSON map: `{ "integration.name": "https://..." }`.
 *
 * Returns null when:
 *   - The env var is unset or empty string (self-hoster path).
 *   - The env var is malformed JSON (logs error, treats as disabled).
 *   - The parsed value isn't a plain string-keyed string-valued object
 *     (logs error, treats as disabled).
 *   - The parsed map is empty (no point booting the bridge with no
 *     reachable integrations).
 *
 * Otherwise returns a function that consults the map.
 */
function buildResolverFromEnv():
  | ((integrationName: string) => string | null)
  | null {
  const raw = process.env.CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS;
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(
      "[reactive-run-bridge] CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS is not valid JSON; bridge disabled:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error(
      "[reactive-run-bridge] CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS must be a JSON object of integration_name → URL; bridge disabled",
    );
    return null;
  }
  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string" || value.length === 0) {
      console.error(
        `[reactive-run-bridge] CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS["${key}"] must be a non-empty string; entry ignored`,
      );
      continue;
    }
    map[key] = value;
  }
  if (Object.keys(map).length === 0) {
    console.error(
      "[reactive-run-bridge] CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS parsed to an empty map; bridge disabled",
    );
    return null;
  }
  return (integrationName: string) => map[integrationName] ?? null;
}

/**
 * Page size for `loadSubscriptions`. The cursor loop walks the full
 * `system.connection` set; this just bounds memory pressure per page.
 */
const SUBSCRIPTION_LOAD_PAGE_SIZE = 200;

/**
 * Walk every system.connection item and build the initial subscription
 * map. Called at bridge startup.
 *
 * Paginates via the storage cursor until exhausted so no connections
 * are silently dropped from fanout. Emits a subscription count at
 * startup so an operator can see what loaded.
 */
async function loadSubscriptions(
  storage: Storage,
): Promise<Map<string, SubscriptionEntry>> {
  const out = new Map<string, SubscriptionEntry>();
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = await storage.items.list({
      type: "system.connection",
      limit: SUBSCRIPTION_LOAD_PAGE_SIZE,
      cursor,
    });
    pages++;
    for (const connection of page.data) {
      const entry = await buildEntryForConnection(storage, {
        id: connection.id,
        state: connection.state,
        properties: connection.properties,
        tenant_id: connection.tenant_id ?? null,
      });
      if (entry) out.set(connection.id, entry);
    }
    if (!page.has_more || !page.cursor) break;
    cursor = page.cursor;
  }

  console.info(
    `[reactive-run-bridge] loaded ${String(out.size)} subscription(s) across ${String(pages)} page(s)`,
  );
  return out;
}

function createBridge(storage: Storage, config: BridgeConfig): BridgeRuntime {
  const fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
  // Bounded keep-alive Pool per queue ORIGIN. Per-integration queue URLs
  // may live at different origins, so the map is keyed by
  // `new URL(url).origin`. In practice every Cloudflare queue for a
  // given account shares the same `api.cloudflare.com` origin so the
  // map usually has one entry, but the shape supports multi-origin
  // without changes. Lazy creation: first send to a new origin spawns
  // its Pool; stop() closes them all.
  //
  // When config.fetch is injected (test path), bypass Pool entirely.
  const pools: Map<string, Pool> | null = config.fetch ? null : new Map();
  const ensurePool = (origin: string): Pool | null => {
    if (!pools) return null;
    let pool = pools.get(origin);
    if (pool) return pool;
    pool = new Pool(origin, {
      connections: 10,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 600_000,
      pipelining: 1,
    });
    pools.set(origin, pool);
    return pool;
  };
  // Per-tenant, per-integration state for "no queue URL mapped" activity
  // rows. Successful writes stay deduped for the process lifetime. Failed
  // writes use an in-flight gate plus bounded backoff so a busy event stream
  // cannot hammer storage while the alert surface is unhealthy.
  const unmappedActivityStates = new Map<string, UnmappedActivityState>();
  const subscriptions = new Map<string, SubscriptionEntry>();
  // Per-subscriber failure tracking. Lives alongside subscriptions and
  // shares its lifecycle — entries are cleaned up when a subscription
  // is dropped (cache invalidation), reset on a successful (2xx)
  // publish, and increment + cooldown + escalate on `sendOne` rejection.
  const subscriberFailures = new Map<string, SubscriberFailureState>();
  let running = false;
  let stopRequested = false;
  // References to the active subscribe iterators so `stop()` can
  // proactively close them — without this the `for await` loops would
  // hang on the next event, holding the coordination advisory lock
  // open until the process exits. The hang is invisible in single-
  // instance dev, but in tests (where each `it` reuses the same
  // storage) and in multi-instance hosted deploys it strands the lock.
  let drainerIter: AsyncIterator<unknown> | null = null;
  let invalidationIter: AsyncIterator<unknown> | null = null;
  // Resolved when the withJobLock-wrapped drainer fully exits and the
  // advisory lock is released. `stop()` awaits this so callers know the
  // bridge has fully unwound before they move on.
  let drainerExit: Promise<void> | null = null;

  /**
   * Refresh the subscription entry for one connection id. Called from
   * the cache-invalidation subscriber on system.connection lifecycle
   * events. Safe to call concurrently — the map ops are atomic and
   * the storage reads are idempotent.
   */
  const refreshConnection = async (connectionId: string): Promise<void> => {
    const item = await storage.items.get(connectionId);
    if (item?.type !== "system.connection") {
      subscriptions.delete(connectionId);
      subscriberFailures.delete(connectionId);
      return;
    }
    const entry = await buildEntryForConnection(storage, {
      id: item.id,
      state: item.state,
      properties: item.properties,
      tenant_id: item.tenant_id ?? null,
    });
    if (entry) {
      // Clear stale failure state when an operator clears runtime_status off
      // "failing" and the subscriber re-enters the registry.
      subscriberFailures.delete(connectionId);
      subscriptions.set(connectionId, entry);
    } else {
      subscriptions.delete(connectionId);
      subscriberFailures.delete(connectionId);
    }
  };

  /**
   * Tail the pubsub for system.connection lifecycle events and refresh
   * the in-memory map. Runs as a separate fire-and-forget loop alongside
   * the main drainer.
   */
  const startInvalidationSubscriber = async (): Promise<void> => {
    const iter = subscribe({
      typeFilter: "system.connection",
    })[Symbol.asyncIterator]();
    invalidationIter = iter;
    try {
      for (;;) {
        const next = await iter.next();
        if (next.done) break;
        if (stopRequested) break;
        try {
          await refreshConnection(next.value.item.id);
        } catch (err) {
          console.error(
            "[reactive-run-bridge] cache invalidation failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    } finally {
      invalidationIter = null;
    }
  };

  return {
    async start(): Promise<void> {
      if (running) return;
      running = true;
      stopRequested = false;
      // Eager load. Failure is non-fatal — events that arrive before
      // the cache loads are dropped (no subscribers yet); subsequent
      // events get the full registry.
      try {
        const initial = await loadSubscriptions(storage);
        for (const [id, entry] of initial) subscriptions.set(id, entry);
      } catch (err) {
        console.error(
          "[reactive-run-bridge] initial subscription load failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
      // Coordination lock ensures only one server instance runs the
      // drainer at a time. Other instances wait inside withJobLock.
      // The drainer is fire-and-forget: it lives for the process
      // lifetime; .catch() surfaces unexpected exits.
      drainerExit = storage.coordination
        .withJobLock("reactive-run-bridge", async () => {
          // Cache invalidation runs alongside the drainer under the
          // same lock — only the elected instance maintains its map.
          void startInvalidationSubscriber();
          const iter = subscribe()[Symbol.asyncIterator]();
          drainerIter = iter;
          try {
            for (;;) {
              const next = await iter.next();
              if (next.done) break;
              if (stopRequested) break;
              await fanoutEvent(
                next.value,
                subscriptions,
                subscriberFailures,
                unmappedActivityStates,
                refreshConnection,
                config,
                fetchImpl,
                ensurePool,
                storage,
              );
            }
          } finally {
            drainerIter = null;
          }
        })
        .catch((err: unknown) => {
          console.error(
            "[reactive-run-bridge] drainer threw:",
            err instanceof Error ? err.message : String(err),
          );
        })
        .then(() => undefined);
    },
    async stop(): Promise<void> {
      stopRequested = true;
      running = false;
      subscriptions.clear();
      subscriberFailures.clear();
      unmappedActivityStates.clear();
      // Wake the for-await loops by emitting synthetic events. Each
      // loop wakes, sees `stopRequested === true`, breaks. The
      // generator unwinds, `events.on(...)` detaches its listener, the
      // withJobLock unwraps, and the coordination advisory lock is
      // returned to the pool. Without this, calls to .return() on the
      // generator don't unblock the in-flight `next()` waiting on the
      // EventEmitter — the lock would stay held until the process
      // exited (invisible in single-instance dev; surfaces in tests
      // that reuse the same storage and in multi-instance deploys).
      try {
        await publish({
          type: "updated",
          item: {
            id: "stop-sentinel",
            type: "system.connection",
            state: "active",
            tier: "library",
            properties: {},
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            timestamp: new Date().toISOString(),
            version: 1,
            schema_version: 1,
            source: "stop-sentinel",
          } as unknown as ItemEventWithId["item"],
        });
      } catch {
        // Best-effort wakeup — never crash stop().
      }
      const drainer = drainerIter;
      const invalidation = invalidationIter;
      drainerIter = null;
      invalidationIter = null;
      const releases: Promise<unknown>[] = [];
      if (drainer?.return)
        releases.push(drainer.return().catch(() => undefined));
      if (invalidation?.return) {
        releases.push(invalidation.return().catch(() => undefined));
      }
      await Promise.all(releases);
      // Wait for the withJobLock-wrapped drainer to fully exit so the
      // advisory lock is back in the pool before stop() returns.
      const exit = drainerExit;
      drainerExit = null;
      if (exit) await exit;
      // Close every Pool last — after the drainer has stopped issuing
      // new requests. close() awaits in-flight, then destroys all
      // connections. Tests injecting config.fetch won't have any pools.
      if (pools) {
        await Promise.all(
          Array.from(pools.values()).map((p) =>
            p.close().catch(() => undefined),
          ),
        );
        pools.clear();
      }
    },
  };
}

/**
 * Send one queue message per subscribing connection.
 *
 * Self-events are always dropped — a connection never receives the
 * events it produced (cycle prevention is upstream via hop_count, but
 * this is the cheaper, earlier check).
 *
 * Tenant scoping: enforced at the bridge layer. Each subscription entry
 * carries its connection's `tenant_id`; the fanout loop drops events
 * whose `event.tenantId` doesn't match the subscriber's tenant. The
 * downstream Worker still authenticates with a per-Connection runtime
 * credential, so the API permission gate remains as the inner backstop
 * — and cross-tenant work doesn't pay the queue / Worker cost.
 * Single-tenant self-hosted: every connection and event are tenantless
 * (null), the gate trivially passes (null === null).
 *
 * Parallel fanout: subscribers receive concurrently via
 * `Promise.allSettled`. A sequential `await` per subscriber would let
 * a slow / wedged subscriber impose its full per-fetch timeout latency
 * on every other subscriber behind it. Parallel dispatch decouples
 * subscribers; per-subscriber retry, timeout, and error-isolation paths
 * apply inside each task. At very high subscriber counts (a few hundred
 * per tenant) we'd want bounded concurrency to avoid overwhelming
 * Cloudflare Queues; that's a separate optimization.
 */
async function fanoutEvent(
  event: ItemEventWithId,
  subscriptions: Map<string, SubscriptionEntry>,
  subscriberFailures: Map<string, SubscriberFailureState>,
  unmappedActivityStates: Map<string, UnmappedActivityState>,
  refreshConnection: (connectionId: string) => Promise<void>,
  config: BridgeConfig,
  fetchImpl: typeof fetch,
  ensurePool: (origin: string) => Pool | null,
  storage: Storage,
): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  const now = Date.now();
  for (const entry of subscriptions.values()) {
    // The bridge's per-subscriber gate (self-event + tenant) is shared
    // with `POST /connections/preview-event` via the `evaluateDispatch`
    // helper — same code, same semantics, two callers.
    if (!evaluateDispatch(event, entry).would_dispatch) continue;
    // Cooldown gate. A subscriber currently in cooldown is skipped
    // silently for this event (no `sendOne`, no log line, no
    // system.activity). Absorbs transient blips without polluting stderr
    // or filling the audit trail with retry storms. The next event past
    // `cooldownUntil` retries the subscriber; failure state is
    // preserved so a still-broken subscriber escalates further.
    const failureState = subscriberFailures.get(entry.connection_id);
    if (
      failureState?.cooldownUntil != null &&
      failureState.cooldownUntil > now
    ) {
      continue;
    }
    // Resolve the per-integration queue URL. An unmapped integration is
    // an env-config gap on the server, not a connection health issue:
    // log error, emit a one-time `action_required` activity row per
    // integration per process lifetime, skip dispatch for this event.
    // Subscriber failure ladder is intentionally NOT incremented — the
    // connection is fine; the env-var just hasn't been set yet.
    const queueUrl = config.resolveQueueUrl(entry.integration_name);
    if (queueUrl === null) {
      const activityTask = handleUnmappedIntegration(
        entry,
        event.tenantId,
        unmappedActivityStates,
        config,
        storage,
      );
      // The alert path carries its own rejection handling. Do not await it in
      // this event's fanout: a slow activity store must not hold mapped queue
      // sends, later events, or unrelated tenants behind it.
      if (activityTask) void activityTask;
      continue;
    }
    const body = buildQueueMessageBody(event, entry);
    // Each subscriber's send is wrapped in a per-fetch timeout and an
    // isolated try/catch. A slow / wedged Cloudflare Queues endpoint
    // for one subscriber doesn't break the rest. Each task is launched
    // immediately so subscribers fan out in parallel; allSettled below
    // waits for every one.
    const task = sendOne(body, queueUrl, config, fetchImpl, ensurePool).then(
      (result) => {
        if (result === "success") {
          subscriberFailures.delete(entry.connection_id);
        }
        // 4xx rejections leave failure state untouched — not a success,
        // but incrementing the ladder on a 4xx would re-trigger the retry storm.
      },
      async (err: unknown) => {
        await handleSubscriberFailure(
          entry,
          err,
          event,
          subscriberFailures,
          refreshConnection,
          config,
          storage,
        );
      },
    );
    tasks.push(task);
  }
  // allSettled: each task catches its own error internally, but allSettled
  // makes the intent explicit — wait for all subscribers before returning.
  await Promise.allSettled(tasks);
}

/**
 * Handle a fanout target whose integration has no queue URL mapped in
 * the bridge's resolver. Logged loudly every time; the operator-visible
 * `system.activity` row is deduped per tenant + integration. Writes are
 * idempotent across ambiguous outcomes and guarded by in-flight + backoff
 * state so a broken activity store cannot turn a busy event stream into a
 * write storm. Best-effort throughout; the bridge must never crash on an
 * env-config gap.
 */
function handleUnmappedIntegration(
  entry: SubscriptionEntry,
  tenantId: string | undefined,
  states: Map<string, UnmappedActivityState>,
  config: BridgeConfig,
  storage: Storage,
): Promise<void> | null {
  console.error(
    `[reactive-run-bridge] no queue URL mapped for integration "${entry.integration_name}" (connection ${entry.connection_id}); skipping dispatch — set CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS to include this integration`,
  );
  const key = unmappedActivityKey(tenantId, entry.integration_name);
  let state = states.get(key);
  if (!state) {
    state = {
      reported: false,
      inFlight: null,
      consecutiveFailures: 0,
      retryAfter: 0,
    };
    states.set(key, state);
  }

  const now = config.unmappedActivityNow?.() ?? Date.now();
  if (state.reported || state.inFlight || state.retryAfter > now) return null;

  const attempt = (async (): Promise<void> => {
    try {
      await writeUnmappedActivity(entry, tenantId, storage);
      state.reported = true;
      state.consecutiveFailures = 0;
      state.retryAfter = 0;
    } catch (err) {
      state.consecutiveFailures++;
      state.retryAfter =
        (config.unmappedActivityNow?.() ?? Date.now()) +
        computeUnmappedActivityRetryMs(
          state.consecutiveFailures,
          config.unmappedActivityRetryBaseMs ?? UNMAPPED_ACTIVITY_RETRY_BASE_MS,
          config.unmappedActivityRetryMaxMs ?? UNMAPPED_ACTIVITY_RETRY_MAX_MS,
        );
      console.error(
        `[reactive-run-bridge] unmapped-integration activity write failed for ${entry.integration_name}:`,
        err instanceof Error ? err.message : String(err),
      );
      // Don't crash the drainer over an activity-row write failure.
    } finally {
      state.inFlight = null;
    }
  })();
  state.inFlight = attempt;
  return attempt;
}

function unmappedActivityKey(
  tenantId: string | undefined,
  integrationName: string,
): string {
  return JSON.stringify([tenantId ?? null, integrationName]);
}

const UNMAPPED_ACTIVITY_SOURCE = "marfa/reactive-run-bridge";

function unmappedActivitySourceId(key: string): string {
  // The database uniqueness constraint is global across tenants, so the
  // tenant-inclusive key must remain part of source_id even though lookups
  // also pass tenantId for read isolation.
  return `unmapped-integration:${key}`;
}

function unmappedActivityProperties(entry: SubscriptionEntry): {
  connection_id: string;
  severity: "action_required";
  summary: string;
  detail: { integration_name: string; hint: string };
} {
  return {
    severity: "action_required",
    summary: `Integration "${entry.integration_name}" has no reactive-run queue URL mapped`,
    connection_id: entry.connection_id,
    detail: {
      integration_name: entry.integration_name,
      hint: "Add this integration to CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS and restart the server.",
    },
  };
}

function isMatchingUnmappedActivity(
  item: Item | null,
  tenantId: string | undefined,
  integrationName: string,
): boolean {
  if (
    item?.type !== "system.activity" ||
    (item.tenant_id ?? null) !== (tenantId ?? null)
  ) {
    return false;
  }
  const properties = item.properties as {
    severity?: string;
    summary?: string;
    detail?: { integration_name?: string; hint?: string };
  };
  return (
    properties.severity === "action_required" &&
    properties.summary ===
      `Integration "${integrationName}" has no reactive-run queue URL mapped` &&
    properties.detail?.integration_name === integrationName &&
    properties.detail.hint ===
      "Add this integration to CLOUDFLARE_QUEUES_REACTIVE_RUN_URLS and restart the server."
  );
}

async function writeUnmappedActivity(
  entry: SubscriptionEntry,
  tenantId: string | undefined,
  storage: Storage,
): Promise<void> {
  const key = unmappedActivityKey(tenantId, entry.integration_name);
  const sourceId = unmappedActivitySourceId(key);
  const existing = await storage.items.findBySourceId(
    UNMAPPED_ACTIVITY_SOURCE,
    sourceId,
    tenantId,
  );
  if (isMatchingUnmappedActivity(existing, tenantId, entry.integration_name)) {
    return;
  }
  if (existing) {
    throw new Error(
      `Natural-key collision for unmapped integration activity ${sourceId}`,
    );
  }

  try {
    await storage.items.create(
      {
        type: "system.activity",
        properties: unmappedActivityProperties(entry),
        source: UNMAPPED_ACTIVITY_SOURCE,
        source_id: sourceId,
      },
      tenantId,
    );
  } catch (createError) {
    // A transport/driver rejection does not prove the transaction failed.
    // Re-read the natural key and accept only the same tenant-scoped,
    // semantically identical alert; an unrelated collision remains a failure.
    const committed = await storage.items.findBySourceId(
      UNMAPPED_ACTIVITY_SOURCE,
      sourceId,
      tenantId,
    );
    if (
      isMatchingUnmappedActivity(committed, tenantId, entry.integration_name)
    ) {
      return;
    }
    throw createError;
  }
}

function computeUnmappedActivityRetryMs(
  consecutiveFailures: number,
  baseMs: number,
  maxMs: number,
): number {
  const exponent = Math.min(Math.max(consecutiveFailures - 1, 0), 30);
  return Math.min(baseMs * 2 ** exponent, maxMs);
}

/**
 * Handle a `sendOne` rejection: log, surface to operators via
 * `system.activity`, increment the in-memory failure counter, arm
 * cooldown at `COOLDOWN_THRESHOLD`, escalate to persistent
 * `runtime_status: failing` at `ESCALATION_THRESHOLD`. Best-effort
 * throughout: a follow-up storage write that fails must never crash
 * the drainer.
 */
/**
 * Cooldown window end for a failing subscriber. The window grows with each
 * consecutive failure past the cooldown threshold, so a subscriber that
 * fails every event escalates toward `cooldownMaxMs` rather than getting the
 * same short `cooldownMs` window each time, then saturates at the cap. The
 * counter resets to zero on the first success, which clears the cooldown.
 */
function computeCooldownUntil(
  consecutiveFailures: number,
  cooldownThreshold: number,
  cooldownMs: number,
  cooldownMaxMs: number,
  now: number,
): number {
  const steps = Math.max(1, consecutiveFailures - cooldownThreshold + 1);
  return now + Math.min(cooldownMs * steps, cooldownMaxMs);
}

async function handleSubscriberFailure(
  entry: SubscriptionEntry,
  err: unknown,
  event: ItemEventWithId,
  subscriberFailures: Map<string, SubscriberFailureState>,
  refreshConnection: (connectionId: string) => Promise<void>,
  config: BridgeConfig,
  storage: Storage,
): Promise<void> {
  const reason = err instanceof Error ? err.message : String(err);
  console.error(
    `[reactive-run-bridge] subscriber ${entry.connection_id} fanout failed:`,
    reason,
  );
  // system.activity write goes via storage directly (not publish()), so it
  // is invisible to the bridge's own subscribe() listener — no feedback loop.
  try {
    await storage.items.create(
      {
        type: "system.activity",
        properties: {
          severity: "error",
          summary: `Fanout to connection ${entry.connection_id} failed`,
          connection_id: entry.connection_id,
          detail: { reason, item_id: event.item.id },
        },
      },
      event.tenantId,
    );
  } catch {
    // Don't crash the drainer over a follow-up activity write.
  }

  const cooldownThreshold =
    config.failureCooldownThreshold ?? COOLDOWN_THRESHOLD;
  const escalationThreshold =
    config.failureEscalationThreshold ?? ESCALATION_THRESHOLD;
  const cooldownMs = config.failureCooldownMs ?? COOLDOWN_MS;
  const cooldownMaxMs = config.failureCooldownMaxMs ?? MAX_COOLDOWN_MS;
  const prev = subscriberFailures.get(entry.connection_id) ?? {
    consecutiveFailures: 0,
    cooldownUntil: null,
  };
  const consecutiveFailures = prev.consecutiveFailures + 1;
  let cooldownUntil = prev.cooldownUntil;
  if (consecutiveFailures >= cooldownThreshold) {
    cooldownUntil = computeCooldownUntil(
      consecutiveFailures,
      cooldownThreshold,
      cooldownMs,
      cooldownMaxMs,
      Date.now(),
    );
  }
  subscriberFailures.set(entry.connection_id, {
    consecutiveFailures,
    cooldownUntil,
  });

  // Persistent escalation: flip runtime_status to "failing" and emit
  // action_required. `buildEntryForConnection` then drops the subscriber
  // from the registry on the next refresh; recovery requires operator intervention.
  if (consecutiveFailures === escalationThreshold) {
    await markSubscriberFailing(
      storage,
      entry,
      reason,
      event.tenantId,
      escalationThreshold,
    );
    // Drop the subscriber from the in-memory registry now — the
    // persistent flip we just did doesn't fire a `publish()` event (it's
    // a storage-layer write only, same precedent as the per-event
    // system.activity row above), so the cache-invalidation subscriber
    // won't re-evaluate this connection until something else writes to
    // it. Without this drop, follow-up events would keep dispatching to
    // the dead subscriber until restart. Refresh re-reads the now-flipped
    // item, gets back `null` from buildEntryForConnection, and removes
    // the entry plus its failure bookkeeping.
    await refreshConnection(entry.connection_id);
  }
}

/**
 * Flip the connection's `runtime_status` to `failing` and emit a
 * `system.activity` row of severity `action_required`. Mirrors the
 * `markReauthRequired` pattern in `routes/connection-proxy.ts` —
 * best-effort, version-conflict tolerant, never throws.
 */
async function markSubscriberFailing(
  storage: Storage,
  entry: SubscriptionEntry,
  reason: string,
  tenantId: string | undefined,
  consecutiveFailures: number,
): Promise<void> {
  try {
    const connection = await storage.items.get(entry.connection_id);
    if (connection?.type !== "system.connection") return;
    const props = connection.properties as {
      kind?: string;
      runtime_status?: string;
    };
    // Only escalate `kind: integration` subscribers (the bridge's
    // universe) and skip if already terminal — avoids re-stamping or
    // duplicating the activity row on noisy ladders.
    if (props.kind !== "integration") return;
    if (props.runtime_status === "failing") return;
    await storage.items.update(
      entry.connection_id,
      {
        properties: {
          ...connection.properties,
          runtime_status: "failing",
          last_error_at: new Date().toISOString(),
        },
      },
      tenantId,
    );
  } catch (err) {
    // Best-effort — the per-event error row already informed operators.
    console.error(
      `[reactive-run-bridge] failed to mark subscriber ${entry.connection_id} failing:`,
      err instanceof Error ? err.message : String(err),
    );
  }
  // Emit the action_required activity row separately so a failed
  // items.update above doesn't block surface telemetry.
  try {
    await storage.items.create(
      {
        type: "system.activity",
        properties: {
          severity: "action_required",
          summary: `Subscriber ${entry.connection_id} marked failing after sustained dispatch failures`,
          connection_id: entry.connection_id,
          detail: {
            consecutive_failures: consecutiveFailures,
            integration_name: entry.integration_name,
            last_reason: reason,
          },
        },
      },
      tenantId,
    );
  } catch {
    // Don't crash the drainer over a follow-up activity write.
  }
}

async function sendOne(
  body: QueueMessageBody,
  queueUrl: string,
  config: BridgeConfig,
  fetchImpl: typeof fetch,
  ensurePool: (origin: string) => Pool | null,
): Promise<SendOneResult> {
  const maxAttempts = config.maxAttempts ?? 5;
  const timeoutMs = config.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  const url = new URL(queueUrl);
  // Pool is keyed by origin; lazy-create when the bridge first sends to
  // a previously-unseen origin. Same Pool serves every send to that
  // origin for the bridge's lifetime; stop() closes them all. In the
  // test path (config.fetch injected) ensurePool returns null and we
  // use the direct fetch branch below.
  const pool = ensurePool(url.origin);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      if (pool) {
        const res = await pool.request({
          path: url.pathname + url.search,
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ body, contentType: "json" }),
          signal: controller.signal,
        });
        // Must drain so the connection returns to the pool; skipping causes leaks.
        await res.body.dump();
        if (res.statusCode >= 200 && res.statusCode < 300) return "success";
        if (res.statusCode < 500) {
          console.error(
            `[reactive-run-bridge] non-retryable ${String(res.statusCode)} from queue`,
          );
          return "rejected";
        }
      } else {
        const res = await fetchImpl(queueUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ body, contentType: "json" }),
          signal: controller.signal,
        });
        if (res.ok) return "success";
        if (res.status < 500) {
          console.error(
            `[reactive-run-bridge] non-retryable ${String(res.status)} from queue`,
          );
          return "rejected";
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(
        `[reactive-run-bridge] send attempt ${String(attempt)}:`,
        reason,
      );
    } finally {
      clearTimeout(timeout);
    }
    // Exponential backoff: 100ms, 200ms, 400ms, ...
    await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt - 1)));
  }
  throw new Error(
    `[reactive-run-bridge] giving up after ${String(maxAttempts)} attempts`,
  );
}

// Test-only export: lets the test suite assert the lazy load + the
// invalidation subscriber against an injected storage.
export const __test_internals = {
  loadSubscriptions,
  buildEntryForConnection,
  computeCooldownUntil,
};
