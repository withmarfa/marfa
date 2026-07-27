import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildConsumerEnv,
  createIntegrationWorker,
  type IntegrationWorkerEnv,
  type IntegrationWorkerConfig,
} from "./worker-entry.js";
import type { DlqProducer } from "../queue-consumer.js";
import { ConnectionGoneError } from "../errors.js";

/**
 * Routing tests for `buildConsumerEnv`. The queue-consumer tests mock
 * `dlqProducerFor` directly, which doesn't exercise the env→consumer
 * wiring: a swap in the worker-entry switch (e.g. webhook → SCHEDULED_POLL)
 * would still pass those tests but route DLQ messages to the wrong queue at
 * runtime. These tests pin the kind → binding map.
 */

function makeProducer(label: string): DlqProducer & { _label: string } {
  return {
    _label: label,
    send: () => Promise.resolve(),
  };
}

function makeBaseEnv(): IntegrationWorkerEnv {
  // Cast only the DO binding — we don't exercise that path here, just
  // dlqProducerFor wiring.
  return {
    PER_CONNECTION_STATE: {} as IntegrationWorkerEnv["PER_CONNECTION_STATE"],
    INTEGRATION_NAME: "demo",
    MARFA_API_URL: "https://server.invalid",
    MARFA_RUNTIME_CONTROL_URL: "https://control.invalid",
    MARFA_RUNTIME_BROKER_KEY: "broker_key",
  };
}

const CONFIG: IntegrationWorkerConfig = {
  integrationName: "demo",
  echo: { echo_ttl_seconds: 60 },
};

describe("buildConsumerEnv.dlqProducerFor routing", () => {
  it("routes webhook → WEBHOOK_RECEIPT_DLQ_QUEUE", () => {
    const wh = makeProducer("webhook");
    const env = { ...makeBaseEnv(), WEBHOOK_RECEIPT_DLQ_QUEUE: wh };
    const consumer = buildConsumerEnv(env, CONFIG);
    expect(consumer.dlqProducerFor?.("webhook")).toBe(wh);
    expect(consumer.dlqProducerFor?.("schedule")).toBeNull();
    expect(consumer.dlqProducerFor?.("item-event")).toBeNull();
  });

  it("routes schedule → SCHEDULED_POLL_DLQ_QUEUE", () => {
    const sp = makeProducer("schedule");
    const env = { ...makeBaseEnv(), SCHEDULED_POLL_DLQ_QUEUE: sp };
    const consumer = buildConsumerEnv(env, CONFIG);
    expect(consumer.dlqProducerFor?.("schedule")).toBe(sp);
    expect(consumer.dlqProducerFor?.("webhook")).toBeNull();
    expect(consumer.dlqProducerFor?.("item-event")).toBeNull();
  });

  it("routes item-event → REACTIVE_RUN_DLQ_QUEUE", () => {
    const rr = makeProducer("item-event");
    const env = { ...makeBaseEnv(), REACTIVE_RUN_DLQ_QUEUE: rr };
    const consumer = buildConsumerEnv(env, CONFIG);
    expect(consumer.dlqProducerFor?.("item-event")).toBe(rr);
    expect(consumer.dlqProducerFor?.("webhook")).toBeNull();
    expect(consumer.dlqProducerFor?.("schedule")).toBeNull();
  });

  it("returns null for every kind when no DLQ bindings are wired", () => {
    const consumer = buildConsumerEnv(makeBaseEnv(), CONFIG);
    expect(consumer.dlqProducerFor?.("webhook")).toBeNull();
    expect(consumer.dlqProducerFor?.("schedule")).toBeNull();
    expect(consumer.dlqProducerFor?.("item-event")).toBeNull();
  });

  it("returns each producer independently when all three are wired (multi-family Worker)", () => {
    // task-auto-archive shape: consumes both scheduled-poll and
    // reactive-run, so it wires two DLQ producers. Verify they don't
    // collapse to one.
    const sp = makeProducer("schedule");
    const rr = makeProducer("item-event");
    const wh = makeProducer("webhook");
    const env = {
      ...makeBaseEnv(),
      SCHEDULED_POLL_DLQ_QUEUE: sp,
      REACTIVE_RUN_DLQ_QUEUE: rr,
      WEBHOOK_RECEIPT_DLQ_QUEUE: wh,
    };
    const consumer = buildConsumerEnv(env, CONFIG);
    expect(consumer.dlqProducerFor?.("schedule")).toBe(sp);
    expect(consumer.dlqProducerFor?.("item-event")).toBe(rr);
    expect(consumer.dlqProducerFor?.("webhook")).toBe(wh);
  });
});

/**
 * Build an env whose DO namespace hands back a stub recording every
 * request it receives, so the fetch-routing tests can assert what
 * reached (or never reached) the per-Connection Durable Object.
 */
function envWithDoStub(seen: Request[]): IntegrationWorkerEnv {
  const stub = {
    fetch(request: Request): Promise<Response> {
      seen.push(request);
      return Promise.resolve(
        Response.json({ ok: true, disarmed: true, previous_next_run_at_ms: 1 }),
      );
    },
  };
  return {
    ...makeBaseEnv(),
    PER_CONNECTION_STATE: {
      idFromName: (name: string) => name,
      get: () => stub,
    } as unknown as IntegrationWorkerEnv["PER_CONNECTION_STATE"],
  };
}

const EXEC_CTX = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

describe("createIntegrationWorker fetch routing", () => {
  it("answers an unrouted path with 404, not a success envelope", async () => {
    // A Worker that predates a route still resolves its hostname, so a
    // 200 catch-all turns "this deployment cannot do that yet" into
    // "done". Every caller upstream then reports success for work that
    // never happened.
    const worker = createIntegrationWorker(CONFIG);
    const res = await worker.fetch(
      new Request("https://integration.invalid/not-a-route", {
        method: "POST",
      }),
      envWithDoStub([]),
      EXEC_CTX,
    );

    expect(res.status).toBe(404);
    const body = await res.json<{ ok?: boolean; error?: string }>();
    expect(body.ok).not.toBe(true);
    expect(body.error).toBe("not_found");
  });

  it("answers a GET on a POST-only control path with 404", async () => {
    const worker = createIntegrationWorker(CONFIG);
    const res = await worker.fetch(
      new Request("https://integration.invalid/disarm-schedule", {
        method: "GET",
      }),
      envWithDoStub([]),
      EXEC_CTX,
    );

    expect(res.status).toBe(404);
  });

  it("forwards a disarm to the per-Connection Durable Object", async () => {
    const seen: Request[] = [];
    const worker = createIntegrationWorker(CONFIG);
    const res = await worker.fetch(
      new Request(
        "https://integration.invalid/disarm-schedule?connection_id=conn_a&reason=uninstall",
        { method: "POST" },
      ),
      envWithDoStub(seen),
      EXEC_CTX,
    );

    expect(res.status).toBe(200);
    expect(await res.json<{ disarmed: boolean }>()).toMatchObject({
      disarmed: true,
    });
    expect(seen).toHaveLength(1);
    const forwarded = new URL(seen[0]!.url);
    expect(forwarded.pathname).toBe("/disarm-schedule");
    expect(forwarded.searchParams.get("reason")).toBe("uninstall");
  });
});

describe("buildConsumerEnv.mintCredential broker classification", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubBroker(
    status: number,
    body: unknown,
    captured?: string[],
  ): void {
    globalThis.fetch = (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      captured?.push(url);
      return Promise.resolve(
        new Response(typeof body === "string" ? body : JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    };
  }

  it("converts a lease-broker connection_not_found into ConnectionGoneError", async () => {
    stubBroker(404, {
      error: "connection_not_found",
      message: "no such connection",
    });
    const consumer = buildConsumerEnv(makeBaseEnv(), CONFIG);

    await expect(consumer.mintCredential("conn_a")).rejects.toBeInstanceOf(
      ConnectionGoneError,
    );
  });

  it("converts a lease-broker connection_not_active into ConnectionGoneError", async () => {
    stubBroker(403, {
      error: "connection_not_active",
      message: "connection revoked",
    });
    const consumer = buildConsumerEnv(makeBaseEnv(), CONFIG);

    await expect(consumer.mintCredential("conn_a")).rejects.toBeInstanceOf(
      ConnectionGoneError,
    );
  });

  it("does NOT convert an unrecognized 404 — a routing miss is transient", async () => {
    // The control plane answers 404 from its own notFound handler for any
    // unmatched path, so a misconfigured URL or a renamed lease route
    // would otherwise make every healthy connection disarm itself on its
    // first tick, permanently and silently.
    stubBroker(404, { error: "not_found", path: "/lease/conn_a/runtime" });
    const consumer = buildConsumerEnv(makeBaseEnv(), CONFIG);

    const err = await consumer
      .mintCredential("conn_a")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ConnectionGoneError);
  });

  it("does NOT convert a WAF-style 403 with no recognizable body", async () => {
    stubBroker(403, "<html>blocked</html>");
    const consumer = buildConsumerEnv(makeBaseEnv(), CONFIG);

    const err = await consumer
      .mintCredential("conn_a")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ConnectionGoneError);
  });

  it("does NOT convert a recognized code arriving on an unexpected status", async () => {
    // The code alone is not proof: a cached or proxied 200/500 body could
    // carry it. Status and code must agree before the terminal verdict.
    stubBroker(500, { error: "connection_not_found" });
    const consumer = buildConsumerEnv(makeBaseEnv(), CONFIG);

    const err = await consumer
      .mintCredential("conn_a")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ConnectionGoneError);
  });

  it("percent-encodes the connection id into the lease URL", async () => {
    const captured: string[] = [];
    stubBroker(
      200,
      { api_key: "k", connection_id: "a/b", expires_at: "x" },
      captured,
    );
    const consumer = buildConsumerEnv(makeBaseEnv(), CONFIG);

    await consumer.mintCredential("a/b?x=1");

    expect(captured[0]).toBe(
      "https://control.invalid/lease/a%2Fb%3Fx%3D1/runtime",
    );
  });
});
