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
 * `system.connection` of kind `external-service-connector` whose
 * Integration manifest declares at least one `item-event` trigger. Each
 * inbound event fans out to one queue message per subscribing connection
 * with `integration_name` populated. Cache invalidation: a separate
 * subscriber listens for `system.connection` lifecycle events
 * (created/updated/deleted) and refreshes the affected entry. The
 * existing pubsub publishes these for every `items.create` /
 * `items.update` / `items.delete` so no new emission is needed.
 */
import { subscribe, type ItemEventWithId } from "../pubsub.js";
import type { Storage } from "../storage/interface.js";
import { validateManifest } from "../integrations/validate-manifest.js";

export interface BridgeConfig {
  queueUrl: string;
  apiToken: string;
  /** Per-batch send size; the producer endpoint accepts up to ~100. */
  batchSize?: number;
  /** Maximum send attempts before giving up on a batch. */
  maxAttempts?: number;
  /** Custom fetch (for tests). */
  fetch?: typeof fetch;
}

export interface BridgeRuntime {
  start(): Promise<void>;
  stop(): void;
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
    fetch: config?.fetch,
  });
}

/**
 * Inspect a connection's manifest and return a SubscriptionEntry when
 * the connection should receive item-event fanout. Returns null when:
 *   - The connection isn't an external-service-connector
 *   - The connection has no integration_ref
 *   - The integration_ref doesn't resolve to a system.integration
 *   - The manifest is invalid (validateManifest rejects it)
 *   - The manifest declares no `item-event` trigger
 *   - The connection is revoked (status !== "active")
 */
async function buildEntryForConnection(
  storage: Storage,
  connection: { id: string; properties: unknown },
): Promise<SubscriptionEntry | null> {
  const props = connection.properties as ConnectionProperties;
  if (props.kind !== "external-service-connector") return null;
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
  };
}

/**
 * Walk every system.connection item and build the initial subscription
 * map. Called at bridge startup. Cheap: the listing is bounded (one
 * page; integrations + connections are low-cardinality even at scale).
 */
async function loadSubscriptions(
  storage: Storage,
): Promise<Map<string, SubscriptionEntry>> {
  const out = new Map<string, SubscriptionEntry>();
  const connections = await storage.items.list({
    type: "system.connection",
    limit: 200,
  });
  for (const connection of connections.data) {
    const entry = await buildEntryForConnection(storage, {
      id: connection.id,
      properties: connection.properties,
    });
    if (entry) out.set(connection.id, entry);
  }
  return out;
}

function createBridge(storage: Storage, config: BridgeConfig): BridgeRuntime {
  const fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
  const subscriptions = new Map<string, SubscriptionEntry>();
  let running = false;
  let stopRequested = false;

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
    for await (const event of subscribe({
      typeFilter: "system.connection",
    })) {
      if (stopRequested) break;
      try {
        await refreshConnection(event.item.id);
      } catch (err) {
        console.error(
          "[reactive-run-bridge] cache invalidation failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
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
      void storage.coordination
        .withJobLock("reactive-run-bridge", async () => {
          // Cache invalidation runs alongside the drainer under the
          // same lock — only the elected instance maintains its map.
          void startInvalidationSubscriber();
          for await (const event of subscribe()) {
            if (stopRequested) break;
            await fanoutEvent(event, subscriptions, config, fetchImpl);
          }
        })
        .catch((err: unknown) => {
          console.error(
            "[reactive-run-bridge] drainer threw:",
            err instanceof Error ? err.message : String(err),
          );
        });
    },
    stop(): void {
      stopRequested = true;
      running = false;
      subscriptions.clear();
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
 * Tenant scoping: not enforced at the bridge layer in Layer 2. The
 * downstream Worker authenticates with a per-Connection runtime
 * credential (Layer 1's connection_id-stamped apiKeys row); cross-tenant
 * misuse fails at the Myme API permission gate. A future tightening
 * could fan out per tenant once `Item` exposes `tenant_id` on the
 * public type — tracked in the Backlog.
 */
async function fanoutEvent(
  event: ItemEventWithId,
  subscriptions: Map<string, SubscriptionEntry>,
  config: BridgeConfig,
  fetchImpl: typeof fetch,
): Promise<void> {
  for (const entry of subscriptions.values()) {
    if (entry.connection_id === event.originatingConnectionId) continue;
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
    await sendOne(body, config, fetchImpl);
  }
}

async function sendOne(
  body: QueueMessageBody,
  config: BridgeConfig,
  fetchImpl: typeof fetch,
): Promise<void> {
  const maxAttempts = config.maxAttempts ?? 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchImpl(config.queueUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body, contentType: "json" }),
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
      console.error(
        `[reactive-run-bridge] send attempt ${String(attempt)}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    // Exponential backoff: 100ms, 200ms, 400ms, ...
    await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt - 1)));
  }
}

// Test-only export: lets the test suite assert the lazy load + the
// invalidation subscriber against an injected storage.
export const __test_internals = {
  loadSubscriptions,
  buildEntryForConnection,
};
