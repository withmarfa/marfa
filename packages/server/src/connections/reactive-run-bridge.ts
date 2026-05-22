/**
 * Reactive-run bridge — drains the in-process item-event stream and
 * forwards each event to the Cloudflare Queues HTTP producer endpoint
 * (Layer 1 default transport for the hosted runtime).
 *
 * SELF-HOSTER SWAP POINT: Layer 2 (install pipeline) is where the
 * bridge transport becomes pluggable for self-hosters who don't have
 * Cloudflare Queues — Postgres LISTEN/NOTIFY, in-process consumers, or
 * a polling integration runtime are the candidates. Don't add the
 * abstraction now; just file the comment so the swap point is obvious.
 *
 * The bridge is OPT-IN: it only runs when both
 * `CLOUDFLARE_QUEUES_REACTIVE_RUN_URL` and `CLOUDFLARE_QUEUES_API_TOKEN`
 * are set. Self-hoster instances leave both unset and the bridge is a
 * no-op startup-time function. Server tests skip the bridge.
 *
 * Concurrency: a single worker drains the subscription and posts to
 * Cloudflare Queues. The bridge is gated by
 * `coordination.withJobLock("reactive-run-bridge", ...)` so multi-
 * instance deployments only run one drainer.
 *
 * Cycle metadata flows through verbatim: the queue message envelope
 * carries `originating_connection_id` and `hop_count` so the integration
 * SDK can refuse to re-publish at budget.
 *
 * Layer 2 PR 3 — subscription registry. The bridge maintains an
 * in-memory map of `connection_id → { integration_name, ... }` for every
 * `system.connection` of kind `integration` whose
 * Integration manifest declares at least one `item-event` trigger. Each
 * inbound event fans out to one queue message per subscribing connection
 * with `integration_name` populated. Cache invalidation: a separate
 * subscriber listens for `system.connection` lifecycle events
 * (created/updated/deleted) and refreshes the affected entry. The
 * existing pubsub publishes these for every `items.create` /
 * `items.update` / `items.delete` so no new emission is needed.
 */
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
 * T-171 — Per-subscriber failure tracking thresholds.
 *
 * Two layers compose:
 *   - Layer 1 (in-memory cooldown): absorb transient blips. A subscriber
 *     that fails `COOLDOWN_THRESHOLD` consecutive event-loops (each loop
 *     is up to `maxAttempts` network retries) enters a `COOLDOWN_MS`
 *     quiet window during which the bridge skips dispatch silently.
 *     Reset on the next successful (2xx) publish. Cap stops indefinite
 *     extension if events keep firing.
 *   - Layer 2 (persistent terminal state): a subscriber that fails
 *     `ESCALATION_THRESHOLD` consecutive event-loops gets its underlying
 *     `system.connection` item flipped to `runtime_status: "failing"`,
 *     and a `system.activity` row of severity `action_required` is
 *     emitted. `buildEntryForConnection` then gates further dispatch out.
 *     Cleared via the cache-invalidation subscriber when an operator
 *     transitions `runtime_status` off `failing`.
 *
 * Counts are event-loops, not network attempts — one count represents
 * one full `sendOne` retry exhaustion (5 attempts + exponential backoff)
 * or one immediate 4xx rejection (T-171 treats both as failures).
 */
const COOLDOWN_THRESHOLD = 3;
const ESCALATION_THRESHOLD = 10;
const COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 5 * 60_000;
/** Fallback per-fetch send timeout when no `sendTimeoutMs` is supplied
 *  (test harnesses that build a partial `BridgeConfig`). Production wires
 *  `AppConfig.reactiveRunSendTimeoutMs` (env `MYME_REACTIVE_RUN_SEND_TIMEOUT_MS`)
 *  through `index.ts`, so the operator-tunable value is the live one. */
const DEFAULT_SEND_TIMEOUT_MS = 5_000;

interface SubscriberFailureState {
  consecutiveFailures: number;
  /** Epoch ms after which the cooldown gate stops skipping. `null` when
   *  the subscriber is below the cooldown threshold. */
  cooldownUntil: number | null;
}

/** Result discriminator for `sendOne`. Lets `fanoutEvent` distinguish
 *  success (reset failure counter) from rejection (don't reset) from
 *  exhaustion (escalate). */
type SendOneResult = "success" | "rejected";

export interface BridgeConfig {
  queueUrl: string;
  apiToken: string;
  /** Per-batch send size; the producer endpoint accepts up to ~100. */
  batchSize?: number;
  /** Maximum send attempts before giving up on a batch. */
  maxAttempts?: number;
  /**
   * Per-fetch timeout in milliseconds for the queue producer call. A slow
   * Cloudflare Queues endpoint would otherwise stall the bridge while
   * fanning out (T-013). Production wires this from
   * `AppConfig.reactiveRunSendTimeoutMs` (env `MYME_REACTIVE_RUN_SEND_TIMEOUT_MS`);
   * unset falls back to `DEFAULT_SEND_TIMEOUT_MS`. On timeout the failure
   * is logged and surfaced as `system.activity` of severity error, then
   * fanout continues to the next subscriber.
   */
  sendTimeoutMs?: number;
  /**
   * T-171 — consecutive `sendOne` rejections before the in-memory
   * cooldown gate arms. Each `consecutiveFailures` tick represents one
   * exhausted retry loop (or one immediate 4xx). Default 3.
   */
  failureCooldownThreshold?: number;
  /**
   * T-171 — consecutive `sendOne` rejections before the underlying
   * `system.connection` item is flipped to `runtime_status: "failing"`
   * and a `system.activity action_required` row is emitted. Default 10.
   */
  failureEscalationThreshold?: number;
  /**
   * T-171 — cooldown window (ms) the bridge skips dispatch after a
   * subscriber crosses `failureCooldownThreshold`. Default 60_000.
   */
  failureCooldownMs?: number;
  /**
   * T-171 — upper bound (ms from now) on cooldown extension when failures
   * keep arriving. Each new failure extends the window; this caps total
   * extension so a busy event stream can't push cooldown arbitrarily far
   * into the future. Default 5 minutes.
   */
  failureCooldownMaxMs?: number;
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
 */
export function tryStartReactiveRunBridge(
  storage: Storage,
  config?: Partial<BridgeConfig>,
): BridgeRuntime | null {
  const queueUrl =
    config?.queueUrl ?? process.env.CLOUDFLARE_QUEUES_REACTIVE_RUN_URL;
  const apiToken = config?.apiToken ?? process.env.CLOUDFLARE_QUEUES_API_TOKEN;
  if (!queueUrl || !apiToken) return null;
  return createBridge(storage, {
    queueUrl,
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
    fetch: config?.fetch,
  });
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
 * T-013: paginate via the storage cursor until exhausted. The previous
 * single-page read silently dropped any tenant's 201st+ connection from
 * fanout — the comment claimed it was "bounded ... low-cardinality even
 * at scale" but this was a soft 200-cap with no warning, no metric, no
 * log. Now we walk every page and emit a per-tenant subscription count
 * at startup so an operator can see what loaded.
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

  // Operational visibility — without this an operator can't tell the
  // bridge has loaded all of the tenant's subscriptions vs. silently
  // capped them at the page size (the pre-T-013 bug).
  console.info(
    `[reactive-run-bridge] loaded ${String(out.size)} subscription(s) across ${String(pages)} page(s)`,
  );
  return out;
}

function createBridge(storage: Storage, config: BridgeConfig): BridgeRuntime {
  const fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
  // T-135: bounded keep-alive Pool to the queue origin. Caps concurrent
  // TCP connections at 10 regardless of subscriber fanout count, which
  // prevents the connection storm that exhausted Atlas's ephemeral port
  // range under sustained load (see T-133 root cause). When config.fetch
  // is injected (test path), bypass Pool entirely so existing tests keep
  // working with their mocked fetch. Pool lifetime = bridge lifetime;
  // closed in stop() below.
  const pool: Pool | null = config.fetch
    ? null
    : new Pool(new URL(config.queueUrl).origin, {
        connections: 10,
        keepAliveTimeout: 30_000,
        keepAliveMaxTimeout: 600_000,
        pipelining: 1,
      });
  const subscriptions = new Map<string, SubscriptionEntry>();
  // T-171: per-subscriber failure tracking. Lives alongside subscriptions
  // and shares its lifecycle — entries are cleaned up when a subscription
  // is dropped (cache invalidation), reset on a successful (2xx) publish,
  // and increment + cooldown + escalate on `sendOne` rejection.
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
      // T-171: when a subscriber re-enters the registry (e.g. operator
      // flips runtime_status off "failing"), clear any stale failure
      // bookkeeping so dispatch starts fresh.
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
                refreshConnection,
                config,
                fetchImpl,
                pool,
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
      // Close the Pool last — after the drainer has stopped issuing
      // new requests. close() awaits in-flight, then destroys all
      // connections. Tests injecting config.fetch won't have a Pool.
      if (pool) await pool.close();
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
 * Tenant scoping (T-042): enforced at the bridge layer. Each subscription
 * entry carries its connection's `tenant_id`; the fanout loop drops events
 * whose `event.tenantId` doesn't match the subscriber's tenant. The
 * downstream Worker still authenticates with a per-Connection runtime
 * credential, so the API permission gate remains as the inner backstop —
 * but cross-tenant work no longer pays the queue / Worker cost. Single-
 * tenant self-hosted: every connection and event are tenantless (null),
 * the gate trivially passes (null === null), no behaviour change.
 *
 * T-036 (parallel fanout): subscribers receive concurrently via
 * `Promise.allSettled`. The pre-T-036 shape was a sequential `await`
 * per subscriber — a slow / wedged subscriber whose 5s per-fetch
 * timeout (T-013) was firing imposed that latency on every other
 * subscriber waiting behind it. Parallel dispatch decouples
 * subscribers; per-subscriber retry, timeout, and error-isolation
 * paths from T-013 are preserved inside each task. At very high
 * subscriber counts (a few hundred per tenant) we'd want bounded
 * concurrency to avoid overwhelming Cloudflare Queues; that's a
 * separate optimisation worth filing if/when needed.
 */
async function fanoutEvent(
  event: ItemEventWithId,
  subscriptions: Map<string, SubscriptionEntry>,
  subscriberFailures: Map<string, SubscriberFailureState>,
  refreshConnection: (connectionId: string) => Promise<void>,
  config: BridgeConfig,
  fetchImpl: typeof fetch,
  pool: Pool | null,
  storage: Storage,
): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  const now = Date.now();
  for (const entry of subscriptions.values()) {
    // The bridge's per-subscriber gate (self-event + tenant) is shared
    // with `POST /connections/preview-event` via the `evaluateDispatch`
    // helper — same code, same semantics, two callers.
    if (!evaluateDispatch(event, entry).would_dispatch) continue;
    // T-171 Layer 1 — cooldown gate. A subscriber currently in cooldown
    // is skipped silently for this event (no `sendOne`, no log line, no
    // system.activity). Absorbs transient blips without polluting stderr
    // or filling the audit trail with retry storms. The next event past
    // `cooldownUntil` retries the subscriber; the failure state is
    // preserved so a still-broken subscriber escalates further.
    const failureState = subscriberFailures.get(entry.connection_id);
    if (
      failureState?.cooldownUntil != null &&
      failureState.cooldownUntil > now
    ) {
      continue;
    }
    const body = buildQueueMessageBody(event, entry);
    // T-013: each subscriber's send is wrapped in a per-fetch timeout
    // and an isolated try/catch. A slow / wedged Cloudflare Queues
    // endpoint for one subscriber doesn't break the rest. T-036:
    // each task is launched immediately so subscribers fan out in
    // parallel; allSettled below waits for every one.
    const task = sendOne(body, config, fetchImpl, pool).then(
      (result) => {
        if (result === "success") {
          // T-171: a successful publish resets the failure ladder. The
          // next failure starts at 1 again rather than picking up from
          // wherever we'd accumulated to.
          subscriberFailures.delete(entry.connection_id);
        }
        // 4xx rejections (`result === "rejected"`) intentionally leave
        // the failure state untouched — they aren't success, but they
        // also don't repeat the retry storm that drove this ticket.
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
  // allSettled (not all): each task already catches its own error and
  // never rejects, but allSettled documents the intent — we wait for
  // every subscriber to finish (success or failure) before returning.
  await Promise.allSettled(tasks);
}

/**
 * T-171 — handle a `sendOne` rejection: log, surface to operators via
 * `system.activity`, increment the in-memory counter, arm cooldown at
 * `COOLDOWN_THRESHOLD`, escalate to persistent `runtime_status: failing`
 * at `ESCALATION_THRESHOLD`.
 *
 * Best-effort throughout: a follow-up storage write that fails must
 * never crash the drainer.
 */
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
  // Operator-visible per-event row (severity error) — historical behaviour.
  // The system.activity write is the storage-layer call only; it does
  // NOT invoke `publish()` (publish is the route-layer's job in
  // `routes/items.ts`). So this write is invisible to the bridge's own
  // `subscribe()` listener — no loop. Same precedent as
  // `defaultCycleDetectionWiring`'s overflow hook in `pubsub.ts`.
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

  // T-171 failure-ladder bookkeeping.
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
    // Each subsequent failure within the cooldown extends the window,
    // capped at cooldownMaxMs from now so events that keep firing
    // don't push the window arbitrarily far into the future.
    const now = Date.now();
    cooldownUntil = Math.min(now + cooldownMs, now + cooldownMaxMs);
  }
  subscriberFailures.set(entry.connection_id, {
    consecutiveFailures,
    cooldownUntil,
  });

  // T-171 Layer 2 — persistent escalation. Once we cross the
  // escalation threshold of consecutive event-loop failures, flip the
  // underlying connection item to `runtime_status: failing` and emit a
  // single action_required activity row. `buildEntryForConnection` then
  // drops the subscriber from the registry on the next refresh; recovery
  // requires an operator to clear the field.
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
  config: BridgeConfig,
  fetchImpl: typeof fetch,
  pool: Pool | null,
): Promise<SendOneResult> {
  const maxAttempts = config.maxAttempts ?? 5;
  const timeoutMs = config.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  const url = new URL(config.queueUrl);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      if (pool) {
        // Production path — bounded keep-alive Pool. Connections reused
        // across fanouts; subscriber concurrency capped at the Pool's
        // `connections` value regardless of fanout breadth.
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
        // Drain the body so the connection returns to the pool cleanly.
        // Without this, connections leak and the Pool eventually wedges.
        await res.body.dump();
        if (res.statusCode >= 200 && res.statusCode < 300) return "success";
        // Retry on 5xx, give up on 4xx.
        if (res.statusCode < 500) {
          console.error(
            `[reactive-run-bridge] non-retryable ${String(res.statusCode)} from queue`,
          );
          return "rejected";
        }
      } else {
        // Test path — config.fetch injected. Pool bypassed.
        const res = await fetchImpl(config.queueUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ body, contentType: "json" }),
          signal: controller.signal,
        });
        if (res.ok) return "success";
        // Retry on 5xx, give up on 4xx.
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
};
