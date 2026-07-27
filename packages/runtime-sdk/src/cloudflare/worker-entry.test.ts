import { describe, it, expect, vi } from "vitest";
import {
  buildConsumerEnv,
  createIntegrationWorker,
  type IntegrationWorkerEnv,
  type IntegrationWorkerConfig,
} from "./worker-entry.js";
import type { DlqProducer } from "../queue-consumer.js";

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
 * Auth gate on the Worker's fetch surface.
 *
 * The routes here mint a runtime credential and run the real handler
 * with real persistence, so "the caller reached us over a Service
 * Binding" cannot be the whole authorization story: a `workers_dev`
 * subdomain, a preview URL, a `routes` entry, or an extra binding all
 * re-expose the same handler without touching this file. These tests
 * pin the refusal so the surface cannot quietly reopen.
 *
 * `400 missing_envelope` / `400 missing_connection_id` are the exact
 * responses an unauthenticated caller used to get, so asserting them
 * for an authorized caller is what proves the gate opens rather than
 * merely closing everything.
 */
const BROKER_KEY = "broker_key";

interface DoStub {
  fetch: ReturnType<typeof vi.fn>;
}

function makeFetchEnv(overrides: Partial<IntegrationWorkerEnv> = {}): {
  env: IntegrationWorkerEnv;
  doStub: DoStub;
  idFromName: ReturnType<typeof vi.fn>;
} {
  const doStub: DoStub = {
    fetch: vi.fn(() =>
      Promise.resolve(Response.json({ ok: true, armed: true })),
    ),
  };
  const idFromName = vi.fn((name: string) => name);
  const env = {
    PER_CONNECTION_STATE: {
      idFromName,
      get: () => doStub,
    } as unknown as IntegrationWorkerEnv["PER_CONNECTION_STATE"],
    MARFA_API_URL: "https://server.invalid",
    MARFA_RUNTIME_CONTROL_URL: "https://control.invalid",
    MARFA_RUNTIME_BROKER_KEY: BROKER_KEY,
    ...overrides,
  } as IntegrationWorkerEnv;
  return { env, doStub, idFromName };
}

const CTX = {} as ExecutionContext;

function post(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://integration.invalid${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
}

describe("createIntegrationWorker fetch auth gate", () => {
  const worker = createIntegrationWorker(CONFIG);

  it.each([
    ["/verify", {}],
    ["/verify", { authorization: "Bearer wrong_key" }],
    ["/verify", { authorization: BROKER_KEY }],
    ["/arm-schedule", {}],
    ["/arm-schedule", { authorization: "Bearer wrong_key" }],
  ])("refuses POST %s with headers %o", async (path, headers) => {
    const { env, doStub, idFromName } = makeFetchEnv();
    const res = await worker.fetch(post(path, headers), env, CTX);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: "unauthorized",
    });
    // Nothing downstream ran: no DO resolved, no handler dispatched.
    expect(idFromName).not.toHaveBeenCalled();
    expect(doStub.fetch).not.toHaveBeenCalled();
  });

  it("refuses a query-string credential — the key must be a header", async () => {
    const { env } = makeFetchEnv();
    const res = await worker.fetch(
      post(
        `/arm-schedule?connection_id=conn_1&authorization=Bearer ${BROKER_KEY}`,
      ),
      env,
      CTX,
    );
    expect(res.status).toBe(401);
  });

  it("fails closed when the Worker has no broker key configured", async () => {
    const { env, doStub } = makeFetchEnv({ MARFA_RUNTIME_BROKER_KEY: "" });
    // Both an absent header and the literal `Bearer ` a missing secret
    // would interpolate into must be refused — never `Bearer undefined`
    // matching `Bearer undefined`.
    const attempts: Record<string, string>[] = [
      {},
      { authorization: "Bearer " },
      { authorization: "Bearer undefined" },
    ];
    for (const headers of attempts) {
      const res = await worker.fetch(
        post("/arm-schedule?connection_id=conn_1", headers),
        env,
        CTX,
      );
      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toMatchObject({
        ok: false,
        error: "worker_misconfigured",
      });
    }
    expect(doStub.fetch).not.toHaveBeenCalled();
  });

  it("admits an authorized /arm-schedule call through to the Durable Object", async () => {
    const { env, doStub, idFromName } = makeFetchEnv();
    const res = await worker.fetch(
      post("/arm-schedule?connection_id=conn_1", {
        authorization: `Bearer ${BROKER_KEY}`,
      }),
      env,
      CTX,
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, armed: true });
    expect(idFromName).toHaveBeenCalledWith("conn_1");
    expect(doStub.fetch).toHaveBeenCalledTimes(1);
  });

  it("admits an authorized /arm-schedule call and still validates its payload", async () => {
    const { env, doStub } = makeFetchEnv();
    const res = await worker.fetch(
      post("/arm-schedule", { authorization: `Bearer ${BROKER_KEY}` }),
      env,
      CTX,
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      reason: "missing_connection_id",
    });
    expect(doStub.fetch).not.toHaveBeenCalled();
  });

  it("admits an authorized /verify call through to the verify handler", async () => {
    const { env } = makeFetchEnv();
    const res = await worker.fetch(
      post("/verify", { authorization: `Bearer ${BROKER_KEY}` }),
      env,
      CTX,
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: "missing_envelope",
    });
  });
});

describe("createIntegrationWorker fetch routing", () => {
  const worker = createIntegrationWorker(CONFIG);
  const auth = { authorization: `Bearer ${BROKER_KEY}` };

  it("serves the informational banner on GET /", async () => {
    const { env } = makeFetchEnv();
    const res = await worker.fetch(
      new Request("https://integration.invalid/", {
        method: "GET",
        headers: auth,
      }),
      env,
      CTX,
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      integration: "demo",
    });
  });

  it.each([
    "/",
    "/arm-schedule/",
    "/disarm-schedule",
    "/verify/x",
    "/anything",
  ])("404s an unknown path (%s) instead of reporting success", async (path) => {
    const { env } = makeFetchEnv();
    const res = await worker.fetch(post(path, auth), env, CTX);
    expect(res.status).toBe(404);
    // The old catch-all answered 200 `ok: true` here, which every
    // caller read as the operation having succeeded — a route the
    // deployment does not have must not look like one that worked.
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("404s a GET to a route that only accepts POST", async () => {
    const { env } = makeFetchEnv();
    const res = await worker.fetch(
      new Request("https://integration.invalid/verify", {
        method: "GET",
        headers: auth,
      }),
      env,
      CTX,
    );
    expect(res.status).toBe(404);
  });
});
