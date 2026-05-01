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
 * SDK can refuse to re-publish at budget. Layer 1 doesn't filter by
 * subscription registry — every reactive-eligible event is forwarded;
 * the per-Integration Worker filters by integration_name in its
 * envelope. Filtering moves into the bridge in Layer 2 once
 * subscriptions are persisted on system.connection rows.
 */
import { subscribe, type ItemEventWithId } from "../pubsub.js";
import type { Storage } from "../storage/interface.js";

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
  integration_name: string | null; // null until Layer 2 wires registry
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

function createBridge(storage: Storage, config: BridgeConfig): BridgeRuntime {
  const fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
  let running = false;
  let stopRequested = false;

  return {
    start(): Promise<void> {
      if (running) return Promise.resolve();
      running = true;
      stopRequested = false;
      // Coordination lock ensures only one server instance runs the
      // drainer at a time. Other instances wait inside withJobLock.
      // The drainer is fire-and-forget: it lives for the process
      // lifetime; .catch() surfaces unexpected exits.
      void storage.coordination
        .withJobLock("reactive-run-bridge", async () => {
          for await (const event of subscribe()) {
            if (stopRequested) break;
            await sendEvent(event, config, fetchImpl);
          }
        })
        .catch((err: unknown) => {
          // Fail visibly — bridge errors cascade into ops alerting via
          // the existing logger when wired. Layer 1 surfaces via
          // process logs.
          console.error(
            "[reactive-run-bridge] drainer threw:",
            err instanceof Error ? err.message : String(err),
          );
        });
      return Promise.resolve();
    },
    stop(): void {
      stopRequested = true;
      running = false;
    },
  };
}

async function sendEvent(
  event: ItemEventWithId,
  config: BridgeConfig,
  fetchImpl: typeof fetch,
): Promise<void> {
  const body: QueueMessageBody = {
    kind: "item-event",
    integration_name: null,
    connection_id:
      (event.item.properties.connection_id as string | undefined) ?? "",
    tenant_id: event.tenantId,
    event_type: `item.${event.type}`,
    item_id: event.item.id,
    cycle: {
      originating_connection_id: event.originatingConnectionId ?? null,
      hop_count: event.hopCount ?? 0,
    },
    payload: { item: event.item, metadata: event.metadata },
  };
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
