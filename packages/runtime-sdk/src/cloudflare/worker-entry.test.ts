import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from "vitest";
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
    MARFA_WORKER_IDENTITY_KEY: "identity_key",
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
 * The connection id reaches `mintCredential` from a queue envelope or a
 * verify payload, so it is caller-controlled by the time it is spliced
 * into the lease broker path. Percent-encoding is what stops a crafted
 * id steering the request at a different control-plane route.
 */
describe("buildConsumerEnv.mintCredential broker URL", () => {
  const CREDENTIAL = { token: "tok", expires_at: "2026-01-01T00:00:00Z" };

  function stubFetch(): Mock<typeof fetch> {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.json(CREDENTIAL)),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("presents its own identity key and integration name, and leaves an ordinary id untouched", async () => {
    const fetchMock = stubFetch();
    const consumer = buildConsumerEnv(makeBaseEnv(), CONFIG);
    await consumer.mintCredential("conn_1");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://control.invalid/lease/conn_1/runtime",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Not a platform credential. The whole point of the derived
          // key is that this Worker holds nothing that mints against
          // another integration's Connection.
          authorization: "Bearer identity_key",
          // Comes from the manifest-derived config, never from the
          // message being processed, so a queue envelope cannot make
          // this Worker claim to be a different integration.
          "x-marfa-integration": CONFIG.integrationName,
        },
      },
    );
  });

  it.each([
    ["../dlq", "https://control.invalid/lease/..%2Fdlq/runtime"],
    ["a?b=c", "https://control.invalid/lease/a%3Fb%3Dc/runtime"],
    ["a#frag", "https://control.invalid/lease/a%23frag/runtime"],
  ])("encodes %s so it cannot reshape the path", async (id, expected) => {
    const fetchMock = stubFetch();
    const consumer = buildConsumerEnv(makeBaseEnv(), CONFIG);
    await consumer.mintCredential(id);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(expected);
  });
});

/**
 * Which broker refusals mean "this Connection can never run again".
 *
 * A terminal verdict makes the consumer tear the schedule down, and
 * nothing re-arms it without an operator working one Connection at a
 * time. A transient verdict costs a retry. The asymmetry is why the
 * negative cases below matter more than the positive ones: every
 * refusal that is not specifically about this Connection has to stay
 * transient, however plausible its status looks.
 */
describe("buildConsumerEnv.mintCredential broker classification", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubBroker(status: number, body: unknown): void {
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(typeof body === "string" ? body : JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
  }

  function mintError(): Promise<unknown> {
    return buildConsumerEnv(makeBaseEnv(), CONFIG)
      .mintCredential("conn_a")
      .catch((e: unknown) => e);
  }

  it.each([
    ["connection_not_found", 404],
    ["connection_not_active", 403],
  ])(
    "converts a lease-broker %s into ConnectionGoneError",
    async (error, status) => {
      stubBroker(status, { error, message: "gone" });
      expect(await mintError()).toBeInstanceOf(ConnectionGoneError);
    },
  );

  it("does NOT convert an unrecognized 404 — a routing miss is transient", async () => {
    // The control plane answers 404 from its own notFound handler for any
    // unmatched path, so a misconfigured URL or a renamed lease route
    // would otherwise make every healthy connection disarm itself on its
    // first tick, permanently and silently.
    stubBroker(404, { error: "not_found", path: "/lease/conn_a/runtime" });
    const err = await mintError();
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ConnectionGoneError);
  });

  it("does NOT convert an unauthorized 401 from the control plane", async () => {
    // The lease route is gated on the broker key. A Worker holding a
    // stale key is refused for every connection it serves, which says
    // nothing about any of them.
    stubBroker(401, { error: "unauthorized" });
    const err = await mintError();
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ConnectionGoneError);
  });

  it("does NOT convert a platform-credential 403 — it is fleet-wide, not per-connection", async () => {
    // The server refuses a mint from a non-platform credential with 403
    // `forbidden`. A broker key rotated to a valid but space-scoped
    // admin key produces exactly this for every connection in every
    // space, so reading it as terminal deschedules the whole fleet
    // inside one cron period.
    stubBroker(403, {
      error: "forbidden",
      message: "requires a platform credential (is_platform: true)",
    });
    const err = await mintError();
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ConnectionGoneError);
  });

  it("does NOT convert a WAF-style 403 with no recognizable body", async () => {
    stubBroker(403, "<html>blocked</html>");
    const err = await mintError();
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ConnectionGoneError);
  });

  it("does NOT convert a recognized code arriving on an unexpected status", async () => {
    // The code alone is not proof: a cached or proxied 200/500 body could
    // carry it. Status and code must agree before the terminal verdict.
    stubBroker(500, { error: "connection_not_found" });
    const err = await mintError();
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ConnectionGoneError);
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
const IDENTITY_KEY = "identity_key";

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
    MARFA_WORKER_IDENTITY_KEY: IDENTITY_KEY,
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
    ["/verify", { authorization: IDENTITY_KEY }],
    ["/arm-schedule", {}],
    ["/arm-schedule", { authorization: "Bearer wrong_key" }],
    ["/disarm-schedule", {}],
    ["/disarm-schedule", { authorization: "Bearer wrong_key" }],
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
        `/arm-schedule?connection_id=conn_1&authorization=Bearer ${IDENTITY_KEY}`,
      ),
      env,
      CTX,
    );
    expect(res.status).toBe(401);
  });

  it("fails closed when the Worker has no identity key configured", async () => {
    const { env, doStub } = makeFetchEnv({ MARFA_WORKER_IDENTITY_KEY: "" });
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
        authorization: `Bearer ${IDENTITY_KEY}`,
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
      post("/arm-schedule", { authorization: `Bearer ${IDENTITY_KEY}` }),
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

  it("admits an authorized /disarm-schedule call through to the Durable Object", async () => {
    const { env, doStub, idFromName } = makeFetchEnv();
    const res = await worker.fetch(
      post("/disarm-schedule?connection_id=conn_1&reason=uninstall", {
        authorization: `Bearer ${IDENTITY_KEY}`,
      }),
      env,
      CTX,
    );
    expect(res.status).toBe(200);
    expect(idFromName).toHaveBeenCalledWith("conn_1");
    expect(doStub.fetch).toHaveBeenCalledTimes(1);
    const forwarded = new URL((doStub.fetch.mock.calls[0] as [Request])[0].url);
    expect(forwarded.pathname).toBe("/disarm-schedule");
    // The reason rides through to the Durable Object's tombstone, so an
    // operator reading DO state later can tell an uninstall teardown
    // from a manual one.
    expect(forwarded.searchParams.get("reason")).toBe("uninstall");
  });

  it("defaults the disarm reason when the caller omits one", async () => {
    const { env, doStub } = makeFetchEnv();
    await worker.fetch(
      post("/disarm-schedule?connection_id=conn_1", {
        authorization: `Bearer ${IDENTITY_KEY}`,
      }),
      env,
      CTX,
    );
    const forwarded = new URL((doStub.fetch.mock.calls[0] as [Request])[0].url);
    expect(forwarded.searchParams.get("reason")).toBe("control_plane");
  });

  it("admits an authorized /disarm-schedule call and still validates its payload", async () => {
    const { env, doStub } = makeFetchEnv();
    const res = await worker.fetch(
      post("/disarm-schedule", { authorization: `Bearer ${IDENTITY_KEY}` }),
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
      post("/verify", { authorization: `Bearer ${IDENTITY_KEY}` }),
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
  const auth = { authorization: `Bearer ${IDENTITY_KEY}` };

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
    "/disarm-schedule/",
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

  it.each(["/verify", "/arm-schedule", "/disarm-schedule"])(
    "404s a GET to %s, which only accepts POST",
    async (path) => {
      const { env, doStub } = makeFetchEnv();
      const res = await worker.fetch(
        new Request(`https://integration.invalid${path}`, {
          method: "GET",
          headers: auth,
        }),
        env,
        CTX,
      );
      expect(res.status).toBe(404);
      expect(doStub.fetch).not.toHaveBeenCalled();
    },
  );
});
