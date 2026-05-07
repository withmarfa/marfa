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
import { publish, subscribe, type ItemEventWithId } from "../pubsub.js";
import type { Storage } from "../storage/interface.js";
import { validateManifest } from "../integrations/validate-manifest.js";

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
   * fanning out (T-013). Defaults to 5000ms; on timeout the failure is
   * logged and surfaced as `system.activity` of severity error, then
   * fanout continues to the next subscriber.
   */
  sendTimeoutMs?: number;
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

interface QueueMessageBody {
  kind: "item-event";
  integration_name: string;
  connection_id: string;
  tenant_id?: string;
  event_type: string;
  item_id: string;
  cycle: {
    originating_connection_id: string | null;
    hop_count: number;
  };
  payload: unknown;
}

interface SubscriptionEntry {
  connection_id: string;
  integration_name: string;
  /**
   * Tenant scope (T-042). Read from `connection.tenant_id` at registry-load
   * time so `fanoutEvent` can drop cross-tenant fanout before invoking
   * `sendOne`. Single-tenant self-hosted installs leave this null on every
   * connection — the gate trivially passes (null === null). Hosted multi-
   * tenant: the gate is the cheap-and-correct first guard ahead of the
   * downstream credential authorisation that catches the same condition
   * later.
   */
  tenant_id: string | null;
}

interface ConnectionProperties {
  kind?: string;
  integration_ref?: string;
  status?: string;
}

interface IntegrationProperties {
  manifest?: unknown;
}

interface ManifestTrigger {
  type: string;
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
    sendTimeoutMs: config?.sendTimeoutMs ?? 5000,
    fetch: config?.fetch,
  });
}

/**
 * Inspect a connection's manifest and return a SubscriptionEntry when
 * the connection should receive item-event fanout. Returns null when:
 *   - The connection isn't of kind `integration`
 *   - The connection has no integration_ref
 *   - The integration_ref doesn't resolve to a system.integration
 *   - The manifest is invalid (validateManifest rejects it)
 *   - The manifest declares no `item-event` trigger
 *   - The connection is revoked (status !== "active")
 */
async function buildEntryForConnection(
  storage: Storage,
  connection: { id: string; properties: unknown; tenant_id?: string | null },
): Promise<SubscriptionEntry | null> {
  const props = connection.properties as ConnectionProperties;
  if (props.kind !== "integration") return null;
  if (props.status && props.status !== "active") return null;
  const ref = props.integration_ref;
  if (!ref) return null;
  const integration = await storage.items.get(ref);
  if (integration?.type !== "system.integration") return null;
  const intProps = integration.properties as IntegrationProperties;
  const validated = validateManifest(intProps.manifest);
  if (!validated.ok) return null;
  const triggers = validated.manifest.triggers as ManifestTrigger[] | undefined;
  const hasItemEventTrigger =
    Array.isArray(triggers) && triggers.some((t) => t.type === "item-event");
  if (!hasItemEventTrigger) return null;
  return {
    connection_id: connection.id,
    integration_name: validated.manifest.name,
    // T-042: stamp the connection's tenant scope at registry-load time.
    // Read from the storage row directly — `Item.tenant_id` is now
    // populated by `rowToItem` in both dialects.
    tenant_id: connection.tenant_id ?? null,
  };
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
  const subscriptions = new Map<string, SubscriptionEntry>();
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
      return;
    }
    const entry = await buildEntryForConnection(storage, {
      id: item.id,
      properties: item.properties,
      tenant_id: item.tenant_id ?? null,
    });
    if (entry) {
      subscriptions.set(connectionId, entry);
    } else {
      subscriptions.delete(connectionId);
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
                config,
                fetchImpl,
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
            origin: "system",
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
  config: BridgeConfig,
  fetchImpl: typeof fetch,
  storage: Storage,
): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  // Normalise to null on both sides so single-tenant self-hosted (where
  // both event.tenantId and entry.tenant_id are typically `undefined`)
  // doesn't fall foul of `undefined !== null` and accidentally drop every
  // subscriber. Hosted multi-tenant: both sides carry strings; the
  // comparison is the explicit cross-tenant guard.
  const eventTenantId = event.tenantId ?? null;
  for (const entry of subscriptions.values()) {
    if (entry.connection_id === event.originatingConnectionId) continue;
    // T-042: cross-tenant fanout drops here, ahead of any queue-producer
    // work. Self-event filter stays as the first gate; tenant gate is the
    // second. Order matters only for code readability — a self-event from
    // tenant A can't be a tenant-B subscriber's event anyway.
    if ((entry.tenant_id ?? null) !== eventTenantId) continue;
    const body: QueueMessageBody = {
      kind: "item-event",
      integration_name: entry.integration_name,
      connection_id: entry.connection_id,
      tenant_id: event.tenantId,
      event_type: `item.${event.type}`,
      item_id: event.item.id,
      cycle: {
        originating_connection_id: event.originatingConnectionId ?? null,
        hop_count: event.hopCount ?? 0,
      },
      payload: { item: event.item, metadata: event.metadata },
    };
    // T-013: each subscriber's send is wrapped in a per-fetch timeout
    // and an isolated try/catch. A slow / wedged Cloudflare Queues
    // endpoint for one subscriber doesn't break the rest. T-036:
    // each task is launched immediately so subscribers fan out in
    // parallel; allSettled below waits for every one.
    const task = sendOne(body, config, fetchImpl).catch(
      async (err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(
          `[reactive-run-bridge] subscriber ${entry.connection_id} fanout failed:`,
          reason,
        );
        // Best-effort operator visibility — surface the failure as a
        // system.activity row for the affected connection.
        //
        // `storage.items.create` is the storage-layer call only; it does
        // NOT invoke `publish()` (publish is the route-layer's job in
        // `routes/items.ts`). So this write is invisible to the bridge's
        // own `subscribe()` listener — no loop. Same precedent as
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
      },
    );
    tasks.push(task);
  }
  // allSettled (not all): each task already catches its own error and
  // never rejects, but allSettled documents the intent — we wait for
  // every subscriber to finish (success or failure) before returning.
  await Promise.allSettled(tasks);
}

async function sendOne(
  body: QueueMessageBody,
  config: BridgeConfig,
  fetchImpl: typeof fetch,
): Promise<void> {
  const maxAttempts = config.maxAttempts ?? 5;
  const timeoutMs = config.sendTimeoutMs ?? 5000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      const res = await fetchImpl(config.queueUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body, contentType: "json" }),
        signal: controller.signal,
      });
      if (res.ok) return;
      // Retry on 5xx, give up on 4xx.
      if (res.status < 500) {
        console.error(
          `[reactive-run-bridge] non-retryable ${String(res.status)} from queue`,
        );
        return;
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
