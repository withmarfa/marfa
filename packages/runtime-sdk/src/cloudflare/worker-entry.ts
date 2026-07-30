/**
 * Shared Worker bootstrap for per-Integration Workers. Wires:
 *
 *   1. The queue handler — Cloudflare delivers batches from the
 *      shared `marfa-{webhook-receipt,scheduled-poll,reactive-run}`
 *      queues, this helper builds `ConsumerEnvironment` and calls
 *      `consumeBatch`.
 *   2. The fetch handler — routes `POST /arm-schedule?connection_id=X`
 *      and `POST /disarm-schedule?connection_id=X` to the per-Connection
 *      DO so the install and uninstall pipelines (via the control plane)
 *      can arm and cancel the alarm, and `POST /verify` for the control
 *      plane's synchronous one-shot dispatch.
 *
 * The entire fetch surface requires this Worker's own identity key,
 * checked once before routing (see `broker-auth.ts`). Unknown paths 404
 * rather than falling through to the banner, so a caller cannot mistake
 * a route this deployment does not have for a successful operation.
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
import { ConnectionGoneError } from "../errors.js";
import { verifyHandler } from "../verify-handler.js";
import { brokerAuthFailure } from "./broker-auth.js";
import { INTEGRATION_NAME_HEADER } from "@withmarfa/shared";

/**
 * Worker `env` shape this helper expects. Integrations may extend it
 * with their own bindings; the helper is generic over any superset.
 */
export interface IntegrationWorkerEnv extends PerConnectionAlarmEnv {
  /** DO namespace for `PerConnectionState`. */
  PER_CONNECTION_STATE: DurableObjectNamespace;
  /** Base URL of the Marfa server (e.g. `https://staging.marfa.so`). */
  MARFA_API_URL: string;
  /**
   * Base URL of the runtime-control Worker. The lease broker hangs
   * off `${MARFA_RUNTIME_CONTROL_URL}/lease/:connection_id/runtime`.
   */
  MARFA_RUNTIME_CONTROL_URL: string;
  /**
   * This Worker's own identity key, derived by the control plane as
   * `HMAC-SHA256(root_secret, integration_name)`. Presented when leasing
   * a credential, and checked on every inbound call to this Worker's
   * fetch surface.
   *
   * Deliberately not the platform broker key this replaced. That key
   * mints against any Connection in any space, so a copy on every
   * Worker made every Worker a platform principal; a derived key
   * authenticates one integration and nothing else, and cannot be used
   * to compute a sibling's.
   */
  MARFA_WORKER_IDENTITY_KEY: string;
  /**
   * Optional DLQ producer bindings. Wire whichever DLQ queues the
   * Worker's main consumers spill into; the wrapper routes by message
   * kind so an integration that consumes multiple queue families gets
   * the matching DLQ for each. Bindings are declared per-env in the
   * integration's `wrangler.toml` as `[[env.<env>.queues.producers]]`
   * pointing at the relevant DLQ.
   *
   * When a binding is unset, the wrapper takes the no-DLQ
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
 * Error codes the lease broker emits to say a Connection can never run
 * again, paired with the status each is expected to arrive on.
 *
 * Both halves have to agree before the verdict is terminal. Status alone
 * is not enough: the control plane answers 404 from its catch-all
 * `notFound` handler for every unmatched path, so a misconfigured
 * `MARFA_RUNTIME_CONTROL_URL` or a renamed lease route would otherwise
 * read as "this Connection is gone" for every healthy Connection on its
 * first tick. Code alone is not enough either, since a cached or proxied
 * body can carry one on a status that contradicts it.
 */
const TERMINAL_LEASE_ERRORS: Record<string, number> = {
  connection_not_found: 404,
  connection_not_active: 403,
};

/** Pull the `error` code out of a broker error body, if it has one. */
function leaseErrorCode(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const code = parsed.error;
      return typeof code === "string" ? code : null;
    }
  } catch {
    // Non-JSON bodies (an HTML error page from a proxy or WAF) carry no
    // verdict. Falling through to null keeps them transient.
  }
  return null;
}

/**
 * Mint a runtime credential by calling the control plane's lease
 * broker. Cached on the per-Connection DO for ≤ 5 min by the SDK
 * caller — this function unconditionally hits the broker.
 *
 * A terminal verdict from the broker is surfaced as `ConnectionGoneError`
 * so the consumer can tell "this will never work again" apart from "the
 * broker is having a bad minute", which is the difference between tearing
 * the schedule down and backing off. Anything unrecognized is transient:
 * a disarm is unrecoverable without operator action (nothing re-arms a
 * schedule automatically), so the asymmetry has to favor retrying.
 */
async function mintCredentialViaBroker(
  env: IntegrationWorkerEnv,
  config: IntegrationWorkerConfig,
  connectionId: string,
): Promise<RuntimeCredential> {
  // Encode the id — it reaches this function from a queue envelope or
  // an operator-supplied verify payload, so it is caller-controlled and
  // must not be able to reshape the broker path. Matches how the
  // control plane builds its own arm-schedule URL.
  const url = `${env.MARFA_RUNTIME_CONTROL_URL}/lease/${encodeURIComponent(connectionId)}/runtime`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.MARFA_WORKER_IDENTITY_KEY}`,
      // Says which integration this Worker is, so the control plane
      // knows which derived key to check the bearer against. Not a
      // credential on its own: naming an integration this Worker is not
      // selects a key it cannot present. The control plane forwards the
      // name it proves to the Marfa server, which refuses a Connection
      // installed for a different integration.
      [INTEGRATION_NAME_HEADER]: config.integrationName,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    const code = leaseErrorCode(body);
    if (code !== null && TERMINAL_LEASE_ERRORS[code] === res.status) {
      throw new ConnectionGoneError(
        `lease broker reports connection ${connectionId} unusable (${code}, ${String(res.status)}): ${body.slice(0, 256)}`,
        res.status,
      );
    }
    throw new Error(
      `lease broker returned ${String(res.status)}: ${body.slice(0, 256)}`,
    );
  }
  const parsed: RuntimeCredential = await res.json();
  return parsed;
}

/** Send a control message to a Connection's Durable Object. */
function perConnectionStub(
  env: IntegrationWorkerEnv,
  connectionId: string,
): DurableObjectStub {
  return env.PER_CONNECTION_STATE.get(
    env.PER_CONNECTION_STATE.idFromName(connectionId),
  );
}

/**
 * Build the standard `{ fetch, queue }` Worker default export. The
 * caller is responsible for `registerScheduleHandler` /
 * `registerWebhookHandler` / `registerItemEventHandler` calls before
 * this runs.
 *
 * Exported for unit-testing the env→consumer wiring (specifically the
 * `dlqProducerFor` kind→binding map); not part of the public Worker
 * bootstrap surface.
 */
export function buildConsumerEnv(
  env: IntegrationWorkerEnv,
  config: IntegrationWorkerConfig,
): ConsumerEnvironment {
  return {
    apiUrl: env.MARFA_API_URL,
    integrationName: config.integrationName,
    echo: config.echo,
    storageFor(connectionId: string) {
      // The consumer isolate can't access DO storage directly; proxy
      // each KV call via the DO's fetch handler instead.
      return makeStorageProxy(perConnectionStub(env, connectionId));
    },
    mintCredential: (connectionId: string) =>
      mintCredentialViaBroker(env, config, connectionId),
    async disarmSchedule(connectionId: string, reason: string) {
      const url = new URL("https://do.invalid/disarm-schedule");
      url.searchParams.set("reason", reason);
      const res = await perConnectionStub(env, connectionId).fetch(
        new Request(url.toString(), { method: "POST" }),
      );
      if (!res.ok) {
        throw new Error(
          `DO disarm-schedule returned ${String(res.status)} for connection ${connectionId}`,
        );
      }
    },
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
      // Gate the whole fetch surface once, before any routing. Gating
      // route-by-route means every route added later is open until
      // someone remembers to add a line; gating here means a new route
      // is covered the moment it exists. It also refuses before any
      // parsing, so a caller that cannot authenticate learns nothing
      // about which paths exist, which parameters they take, or
      // whether a given connection is real.
      const refusal = await brokerAuthFailure(
        request,
        env.MARFA_WORKER_IDENTITY_KEY,
      );
      if (refusal) return refusal;

      const url = new URL(request.url);
      // The control plane hits these from a service binding to arm the
      // schedule alarm at install time and cancel it at uninstall.
      if (
        (url.pathname === "/arm-schedule" ||
          url.pathname === "/disarm-schedule") &&
        request.method === "POST"
      ) {
        const connectionId = url.searchParams.get("connection_id");
        if (!connectionId) {
          return Response.json(
            { ok: false, reason: "missing_connection_id" },
            { status: 400 },
          );
        }
        const innerUrl = new URL(request.url);
        innerUrl.search = "";
        if (url.pathname === "/disarm-schedule") {
          // The reason is recorded on the tombstone, so an operator
          // reading DO state later can tell an uninstall teardown from
          // a manual one.
          innerUrl.searchParams.set(
            "reason",
            url.searchParams.get("reason") ?? "control_plane",
          );
        }
        return perConnectionStub(env, connectionId).fetch(
          new Request(innerUrl.toString(), { method: "POST" }),
        );
      }
      // Synchronous one-shot dispatch from the runtime-control verify
      // route. Reuses the same ConsumerEnvironment the queue consumer
      // builds so the handler runs against the real per-Connection
      // runtime credential and writes through the same Marfa API —
      // verify is real-handler, real-writes.
      if (url.pathname === "/verify" && request.method === "POST") {
        const consumerEnv = buildConsumerEnv(env, config);
        return verifyHandler(consumerEnv, request);
      }
      // Informational banner, useful as a smoke check that a Service
      // Binding resolves to the Worker the caller expected. Narrow to
      // `GET /` on purpose: it used to be the catch-all, which meant a
      // POST to a route this deployment does not have came back 200
      // `ok: true`, and every caller read that as the operation having
      // succeeded. A missing route has to look like a missing route.
      if (url.pathname === "/" && request.method === "GET") {
        return Response.json({
          ok: true,
          integration: config.integrationName,
          message:
            "Per-Integration Worker. Queue + DO traffic only; the HTTP surface is reachable over the control plane's Service Binding and requires this Worker's identity key.",
        });
      }
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    },
    async queue(batch: MessageBatch<QueueMessage>, env: E) {
      const consumerEnv = buildConsumerEnv(env, config);
      // MessageBatch.messages is readonly; consumeBatch takes a mutable array.
      // slice() produces a mutable copy without copying elements.
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
