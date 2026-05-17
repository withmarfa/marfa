/**
 * Shared Worker bootstrap for per-Integration Workers. Wires:
 *
 *   1. The queue handler — Cloudflare delivers batches from the
 *      shared `myme-{webhook-receipt,scheduled-poll,reactive-run}`
 *      queues, this helper builds `ConsumerEnvironment` and calls
 *      `consumeBatch`.
 *   2. The fetch handler — routes `POST /arm-schedule?connection_id=X`
 *      to the per-Connection DO so the install pipeline (via the
 *      control plane) can arm the first alarm.
 *
 * Per-integration `worker.ts` files become a 5-line file: register
 * handlers, call `createIntegrationWorker(...)`, re-export
 * `PerConnectionState`.
 */
import {
  consumeBatch,
  type ConsumerEnvironment,
  type DlqProducer,
} from "../queue-consumer.js";
import type { PerConnectionAlarmEnv } from "./per-connection-state.js";
import type { QueueMessage, RuntimeCredential } from "../types.js";
import { verifyHandler } from "../verify-handler.js";

/**
 * Worker `env` shape this helper expects. Integrations may extend it
 * with their own bindings; the helper is generic over any superset.
 */
export interface IntegrationWorkerEnv extends PerConnectionAlarmEnv {
  /** DO namespace for `PerConnectionState`. */
  PER_CONNECTION_STATE: DurableObjectNamespace;
  /** Base URL of the Myme server (e.g. `https://staging.myme.so`). */
  MYME_API_URL: string;
  /**
   * Base URL of the runtime-control Worker. The lease broker hangs
   * off `${MYME_RUNTIME_CONTROL_URL}/lease/:connection_id/runtime`.
   */
  MYME_RUNTIME_CONTROL_URL: string;
  /**
   * Long-lived broker key (`is_platform: true` admin) the Worker
   * presents to the control plane to mint per-Connection runtime
   * credentials. Never leaves the Worker.
   */
  MYME_RUNTIME_BROKER_KEY: string;
  /**
   * Optional DLQ producer bindings (T-103). Wire whichever DLQ queues
   * the Worker's main consumers spill into; the wrapper routes by
   * message kind so an integration that consumes multiple queue
   * families gets the matching DLQ for each. Bindings are declared
   * per-env in the integration's `wrangler.toml` as
   * `[[env.<env>.queues.producers]]` pointing at the relevant DLQ.
   *
   * When a binding is unset, the wrapper falls through to its pre-T-103
   * permanent-failure path (ack + activity emit only).
   */
  WEBHOOK_RECEIPT_DLQ_QUEUE?: DlqProducer;
  SCHEDULED_POLL_DLQ_QUEUE?: DlqProducer;
  REACTIVE_RUN_DLQ_QUEUE?: DlqProducer;
}

/**
 * Manifest-derived static config the bootstrap helper needs. Pulled
 * out of the manifest at module load by the integration's own code.
 */
export interface IntegrationWorkerConfig {
  /** Manifest's `name` (envelope filter). */
  integrationName: string;
  /** Manifest's `bidirectional_handling`, defaults are fine. */
  echo: { echo_ttl_seconds: number; lag_window_seconds?: number };
}

export interface IntegrationWorkerExport<E> {
  fetch(request: Request, env: E, ctx: ExecutionContext): Promise<Response>;
  queue(batch: MessageBatch<QueueMessage>, env: E): Promise<void>;
}

/**
 * Mint a runtime credential by calling the control plane's lease
 * broker. Cached on the per-Connection DO for ≤ 5 min by the SDK
 * caller — this function unconditionally hits the broker.
 */
async function mintCredentialViaBroker(
  env: IntegrationWorkerEnv,
  connectionId: string,
): Promise<RuntimeCredential> {
  const url = `${env.MYME_RUNTIME_CONTROL_URL}/lease/${connectionId}/runtime`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.MYME_RUNTIME_BROKER_KEY}`,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `lease broker returned ${String(res.status)}: ${body.slice(0, 256)}`,
    );
  }
  const parsed: RuntimeCredential = await res.json();
  return parsed;
}

/**
 * Build the standard `{ fetch, queue }` Worker default export. The
 * caller is responsible for `registerScheduleHandler` /
 * `registerWebhookHandler` / `registerItemEventHandler` calls before
 * this runs.
 *
 * Exported for unit-testing the env→consumer wiring (specifically the
 * `dlqProducerFor` kind→binding map added in T-103); not part of the
 * public Worker bootstrap surface.
 */
export function buildConsumerEnv(
  env: IntegrationWorkerEnv,
  config: IntegrationWorkerConfig,
): ConsumerEnvironment {
  return {
    apiUrl: env.MYME_API_URL,
    integrationName: config.integrationName,
    echo: config.echo,
    storageFor(connectionId: string) {
      const stub = env.PER_CONNECTION_STATE.get(
        env.PER_CONNECTION_STATE.idFromName(connectionId),
      );
      // The SDK's cursor + echo + idempotency helpers consume the
      // CursorStorageAdapter shape directly; the DO's internal
      // PerConnectionStateCore exposes that subset of
      // DurableObjectStorage. We can't reach into the DO from
      // outside, so we hand back a façade that proxies each KV
      // call through a request to the DO's fetch handler — but
      // since the queue message dispatches the handler INSIDE the
      // DO would be cleaner. For Layer 3 we keep the SDK helpers
      // running in the Worker isolate (matches the in-memory test
      // harness shape) and reach into the DO state only through
      // setAlarm / setNextRunAt on the alarm path. Storage proxy
      // below is simple per-key over fetch.
      return makeStorageProxy(stub);
    },
    mintCredential: (connectionId: string) =>
      mintCredentialViaBroker(env, connectionId),
    dlqProducerFor: (kind) => {
      switch (kind) {
        case "webhook":
          return env.WEBHOOK_RECEIPT_DLQ_QUEUE ?? null;
        case "schedule":
          return env.SCHEDULED_POLL_DLQ_QUEUE ?? null;
        case "item-event":
          return env.REACTIVE_RUN_DLQ_QUEUE ?? null;
        default: {
          // Exhaustiveness — adding a new `QueueMessage["kind"]` without
          // a matching DLQ binding case is a compile-time error.
          const _exhaustive: never = kind;
          return _exhaustive;
        }
      }
    },
  };
}

export function createIntegrationWorker<
  E extends IntegrationWorkerEnv = IntegrationWorkerEnv,
>(config: IntegrationWorkerConfig): IntegrationWorkerExport<E> {
  return {
    async fetch(request: Request, env: E, ctx: ExecutionContext) {
      void ctx;
      const url = new URL(request.url);
      // The control plane hits this from a service binding to arm the
      // schedule alarm on a specific connection at install time.
      if (url.pathname === "/arm-schedule" && request.method === "POST") {
        const connectionId = url.searchParams.get("connection_id");
        if (!connectionId) {
          return Response.json(
            { ok: false, reason: "missing_connection_id" },
            { status: 400 },
          );
        }
        const stub = env.PER_CONNECTION_STATE.get(
          env.PER_CONNECTION_STATE.idFromName(connectionId),
        );
        const innerUrl = new URL(request.url);
        innerUrl.pathname = "/arm-schedule";
        innerUrl.search = "";
        return stub.fetch(new Request(innerUrl.toString(), { method: "POST" }));
      }
      // T-082: synchronous one-shot dispatch from the runtime-control
      // verify route. Reuses the same ConsumerEnvironment the queue
      // consumer builds so the handler runs against the real per-
      // Connection runtime credential and writes through the same
      // Myme client — verify is real-handler, real-writes.
      if (url.pathname === "/verify" && request.method === "POST") {
        const consumerEnv = buildConsumerEnv(env, config);
        return verifyHandler(consumerEnv, request);
      }
      return Response.json({
        ok: true,
        integration: config.integrationName,
        message:
          "Per-Integration Worker. Queue + DO traffic only; HTTP surface limited to /arm-schedule and /verify.",
      });
    },
    async queue(batch: MessageBatch<QueueMessage>, env: E) {
      const consumerEnv = buildConsumerEnv(env, config);
      // Cloudflare types `MessageBatch.messages` as readonly; consumeBatch
      // takes a mutable array. The function never mutates the array — slice
      // produces a fresh mutable copy.
      await consumeBatch(consumerEnv, batch.messages.slice());
    },
  };
}

/**
 * Storage façade that proxies KV operations into the per-Connection
 * DO via its `fetch` interface. The DO exposes `/storage/get`,
 * `/storage/put`, `/storage/delete` so the queue-running consumer
 * isolate can read + mutate per-Connection state without owning the
 * DO directly.
 */
function makeStorageProxy(stub: DurableObjectStub) {
  const send = async (
    op: "get" | "put" | "delete",
    key: string,
    value?: unknown,
  ) => {
    const url = new URL("https://do.invalid/storage");
    url.searchParams.set("op", op);
    url.searchParams.set("key", key);
    const init: RequestInit = { method: "POST" };
    if (op === "put" && value !== undefined) {
      init.body = JSON.stringify({ value });
      init.headers = { "content-type": "application/json" };
    }
    const res = await stub.fetch(new Request(url.toString(), init));
    if (!res.ok) {
      throw new Error(`DO storage ${op} ${key} returned ${String(res.status)}`);
    }
    return res;
  };
  return {
    async get(key: string) {
      const res = await send("get", key);
      const body: { value: unknown } = await res.json();
      return body.value;
    },
    async put(key: string, value: unknown) {
      await send("put", key, value);
    },
    async delete(key: string) {
      await send("delete", key);
    },
  };
}
