import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { idempotencyMiddleware } from "./idempotency.js";
import { authMiddleware } from "./auth.js";
import { createErrorHandler } from "./error-handler.js";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { AppEnv } from "./auth.js";

const SALT = "test-salt";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(() => {
  ctx.cleanup();
});

interface HandlerProbe {
  calls: number;
}

/**
 * Mount a minimal app with the same middleware stack the production
 * config uses for protected routes: error handler, auth, idempotency,
 * then a handful of probe handlers exercising different status codes
 * and content types. The probes count their invocations so tests can
 * assert "handler did NOT run on cache hit".
 */
function mountWithIdempotency(
  options: {
    handlerProbe: HandlerProbe;
    handlerStatus?: number;
    handlerBody?: () => unknown;
    handlerContentType?: string;
  },
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(createErrorHandler({ errorWebhookUrl: "" }));
  app.use("*", authMiddleware(ctx.storage, SALT));
  app.use("*", idempotencyMiddleware(ctx.storage, { retentionHours: 24 }));

  // POST handler — JSON 201 by default, or whatever the test asks for.
  app.post("/probe", (c) => {
    options.handlerProbe.calls += 1;
    const status = options.handlerStatus ?? 201;
    if (options.handlerContentType === "text/event-stream") {
      return new Response("event: ping\ndata: {}\n\n", {
        status,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    const body = options.handlerBody
      ? options.handlerBody()
      : { ok: true, ts: Date.now() };
    return c.json(body as Record<string, unknown>, status as never);
  });

  // DELETE handler — same probe pattern, returns 204 with no body.
  app.delete("/probe/:id", (c) => {
    options.handlerProbe.calls += 1;
    return c.json({ ok: true, deleted: c.req.param("id") }, 200);
  });

  // GET handler — should NEVER hit idempotency caching even if the
  // header is present.
  app.get("/probe", (c) => {
    options.handlerProbe.calls += 1;
    return c.json({ ok: true });
  });

  return app;
}

function authedHeaders(extras: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${ctx.adminKey}`,
    "Content-Type": "application/json",
    ...extras,
  };
}

describe("idempotencyMiddleware — opt-in semantics", () => {
  it("is a no-op when Idempotency-Key header is absent", async () => {
    const probe: HandlerProbe = { calls: 0 };
    const app = mountWithIdempotency({ handlerProbe: probe });

    const r1 = await app.request("/probe", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({ value: "first" }),
    });
    const r2 = await app.request("/probe", {
      method: "POST",
      headers: authedHeaders(),
      body: JSON.stringify({ value: "first" }),
    });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(probe.calls).toBe(2);
  });

  it("ignores Idempotency-Key on GET", async () => {
    const probe: HandlerProbe = { calls: 0 };
    const app = mountWithIdempotency({ handlerProbe: probe });

    await app.request("/probe", {
      method: "GET",
      headers: authedHeaders({ "Idempotency-Key": "abc-12345678" }),
    });
    await app.request("/probe", {
      method: "GET",
      headers: authedHeaders({ "Idempotency-Key": "abc-12345678" }),
    });
    expect(probe.calls).toBe(2);
  });
});

describe("idempotencyMiddleware — cache hit / miss", () => {
  it("first request runs the handler; second request returns cached body", async () => {
    const probe: HandlerProbe = { calls: 0 };
    const handlerBody = (() => {
      let n = 0;
      return () => ({ count: ++n });
    })();
    const app = mountWithIdempotency({
      handlerProbe: probe,
      handlerBody,
    });

    const r1 = await app.request("/probe", {
      method: "POST",
      headers: authedHeaders({ "Idempotency-Key": "test-replay-12345678" }),
      body: JSON.stringify({ value: "first" }),
    });
    const body1 = (await r1.json()) as { count: number };
    expect(r1.status).toBe(201);
    expect(body1.count).toBe(1);
    expect(probe.calls).toBe(1);

    const r2 = await app.request("/probe", {
      method: "POST",
      headers: authedHeaders({ "Idempotency-Key": "test-replay-12345678" }),
      body: JSON.stringify({ value: "first" }),
    });
    const body2 = (await r2.json()) as { count: number };
    expect(r2.status).toBe(201);
    expect(body2.count).toBe(1); // same body — handler did NOT re-run
    expect(probe.calls).toBe(1);
  });

  it("returns 422 when same key is reused with a different body", async () => {
    const probe: HandlerProbe = { calls: 0 };
    const app = mountWithIdempotency({ handlerProbe: probe });

    const r1 = await app.request("/probe", {
      method: "POST",
      headers: authedHeaders({ "Idempotency-Key": "reuse-key-87654321" }),
      body: JSON.stringify({ value: "first" }),
    });
    expect(r1.status).toBe(201);

    const r2 = await app.request("/probe", {
      method: "POST",
      headers: authedHeaders({ "Idempotency-Key": "reuse-key-87654321" }),
      body: JSON.stringify({ value: "DIFFERENT" }),
    });
    expect(r2.status).toBe(422);
    const errBody = (await r2.json()) as { error: { code: string } };
    expect(errBody.error.code).toBe("idempotency_key_reused");
    expect(probe.calls).toBe(1); // only the first call ran the handler
  });

  it("rejects malformed Idempotency-Key with 400", async () => {
    const probe: HandlerProbe = { calls: 0 };
    const app = mountWithIdempotency({ handlerProbe: probe });

    const res = await app.request("/probe", {
      method: "POST",
      headers: authedHeaders({ "Idempotency-Key": "has whitespace" }),
      body: JSON.stringify({ value: "x" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("idempotency_key_invalid");
    expect(probe.calls).toBe(0);
  });

  it("DELETE replays return the cached response", async () => {
    const probe: HandlerProbe = { calls: 0 };
    const app = mountWithIdempotency({ handlerProbe: probe });

    const r1 = await app.request("/probe/abc", {
      method: "DELETE",
      headers: authedHeaders({ "Idempotency-Key": "delete-replay-key-aaa" }),
    });
    const r2 = await app.request("/probe/abc", {
      method: "DELETE",
      headers: authedHeaders({ "Idempotency-Key": "delete-replay-key-aaa" }),
    });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(probe.calls).toBe(1);
  });
});

describe("idempotencyMiddleware — what's NOT cached", () => {
  it("does not cache 5xx responses (retries are allowed)", async () => {
    const probe: HandlerProbe = { calls: 0 };
    const app = mountWithIdempotency({
      handlerProbe: probe,
      handlerStatus: 503,
      handlerBody: () => ({ error: "downstream" }),
    });

    const r1 = await app.request("/probe", {
      method: "POST",
      headers: authedHeaders({ "Idempotency-Key": "retry-allowed-key-aa" }),
      body: JSON.stringify({ value: "x" }),
    });
    const r2 = await app.request("/probe", {
      method: "POST",
      headers: authedHeaders({ "Idempotency-Key": "retry-allowed-key-aa" }),
      body: JSON.stringify({ value: "x" }),
    });
    expect(r1.status).toBe(503);
    expect(r2.status).toBe(503);
    expect(probe.calls).toBe(2); // handler ran both times
  });

  it("caches 4xx responses (validation failures shouldn't retry-loop)", async () => {
    const probe: HandlerProbe = { calls: 0 };
    const app = mountWithIdempotency({
      handlerProbe: probe,
      handlerStatus: 400,
      handlerBody: () => ({ error: { code: "validation", message: "no" } }),
    });

    await app.request("/probe", {
      method: "POST",
      headers: authedHeaders({ "Idempotency-Key": "validation-key-aaa" }),
      body: JSON.stringify({ value: "x" }),
    });
    await app.request("/probe", {
      method: "POST",
      headers: authedHeaders({ "Idempotency-Key": "validation-key-aaa" }),
      body: JSON.stringify({ value: "x" }),
    });
    expect(probe.calls).toBe(1); // 4xx is cached; second call short-circuits
  });

  it("does not cache non-JSON responses (e.g. SSE streams)", async () => {
    const probe: HandlerProbe = { calls: 0 };
    const app = mountWithIdempotency({
      handlerProbe: probe,
      handlerContentType: "text/event-stream",
    });

    await app.request("/probe", {
      method: "POST",
      headers: authedHeaders({ "Idempotency-Key": "stream-key-aaaaaaaa" }),
      body: JSON.stringify({ value: "x" }),
    });
    await app.request("/probe", {
      method: "POST",
      headers: authedHeaders({ "Idempotency-Key": "stream-key-aaaaaaaa" }),
      body: JSON.stringify({ value: "x" }),
    });
    expect(probe.calls).toBe(2); // not cached
  });
});

describe("idempotencyMiddleware — cache scope", () => {
  it("scopes cache entries per api_key_id (different keys, same idem key)", async () => {
    // Mint a second admin key in the shared storage.
    const { hashApiKey } = await import("./auth.js");
    const secondRaw = `myme_k1_test_admin_two_${Math.random().toString(36).slice(2, 14)}`;
    await ctx.storage.keys.create(
      {
        label: "second-admin",
        source: `second-admin-${Math.random().toString(36).slice(2, 14)}`,
        role: "admin",
        type_permissions: {},
        default_library: false,
      },
      hashApiKey(secondRaw, SALT),
    );

    const probe: HandlerProbe = { calls: 0 };
    const handlerBody = (() => {
      let n = 0;
      return () => ({ count: ++n });
    })();
    const app = mountWithIdempotency({ handlerProbe: probe, handlerBody });

    const ikey = "shared-idem-key-12345";
    const body = JSON.stringify({ same: true });

    const r1 = await app.request("/probe", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.adminKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": ikey,
      },
      body,
    });
    const r2 = await app.request("/probe", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secondRaw}`,
        "Content-Type": "application/json",
        "Idempotency-Key": ikey,
      },
      body,
    });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    // Each api key gets its own cache row, so handler runs for each.
    expect(probe.calls).toBe(2);
    const body1 = (await r1.json()) as { count: number };
    const body2 = (await r2.json()) as { count: number };
    expect(body1.count).toBe(1);
    expect(body2.count).toBe(2);
  });
});

describe("IdempotencyStore.cleanup", () => {
  it("deletes only entries whose expires_at is at or before the cutoff", async () => {
    const now = Date.now();
    await ctx.storage.idempotency.put({
      api_key_id: "k1",
      key: "expired-1",
      request_hash: "h",
      status: 201,
      response_body: "{}",
      created_at: new Date(now - 48 * 3600 * 1000).toISOString(),
      expires_at: new Date(now - 24 * 3600 * 1000).toISOString(),
    });
    await ctx.storage.idempotency.put({
      api_key_id: "k1",
      key: "fresh-1",
      request_hash: "h",
      status: 201,
      response_body: "{}",
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + 24 * 3600 * 1000).toISOString(),
    });

    const cutoff = new Date(now).toISOString();
    const deleted = await ctx.storage.idempotency.cleanup(cutoff);
    expect(deleted).toBeGreaterThanOrEqual(1);

    const fresh = await ctx.storage.idempotency.get("k1", "fresh-1");
    expect(fresh).not.toBeNull();
    const expired = await ctx.storage.idempotency.get("k1", "expired-1");
    expect(expired).toBeNull();
  });
});
