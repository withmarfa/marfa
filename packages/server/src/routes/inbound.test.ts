import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { trace } from "@opentelemetry/api";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import * as errorNotifier from "../middleware/error-notifier.js";
import type { AppConfig } from "../config.js";
import { DEFAULT_INBOUND_LIMITS } from "../config.js";
import {
  createTestContext,
  mintWorkingKey,
  request,
  seedOauthBearer,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { Housekeeping } from "../housekeeping/scheduler.js";
import { __resetEventLogForTests, initEventLog } from "../pubsub.js";
import { registerHousekeepingJobs } from "../housekeeping/registrations.js";

interface Endpoint {
  id: string;
  connector_id: string;
  label: string | null;
  duplicate_header: string | null;
  path: string;
  created_at: string;
  retired_at: string | null;
}

interface Delivery {
  id: string;
  endpoint_id: string;
  received_at: string;
  method: string;
  query: string;
  headers: [string, string][];
  size: number;
  sha256: string;
  duplicate_of: { id: string; outcome: string | null } | null;
  handled_at: string | null;
  outcome: string | null;
}

const contexts: TestContext[] = [];

async function context(overrides?: Partial<AppConfig>): Promise<TestContext> {
  const ctx = await createTestContext(overrides);
  contexts.push(ctx);
  return ctx;
}

afterAll(async () => {
  for (const ctx of contexts.splice(0)) await ctx.cleanup();
});

async function register(
  ctx: TestContext,
): Promise<{ key: string; id: string }> {
  const key = await mintWorkingKey(ctx);
  const res = await request(ctx.app, "POST", "/connectors", {
    key,
    body: { name: "inbound test" },
  });
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  return { key, id };
}

async function endpoint(
  ctx: TestContext,
  connector: { key: string; id: string },
  body: Record<string, unknown> = {},
): Promise<Endpoint> {
  const res = await request(
    ctx.app,
    "POST",
    `/connectors/${connector.id}/endpoints`,
    { key: connector.key, body },
  );
  expect(res.status).toBe(201);
  return (await res.json()) as Endpoint;
}

function post(
  ctx: TestContext,
  path: string,
  body: Uint8Array | string,
  headers: Record<string, string> = {},
  rawHeaders?: string[],
): Promise<Response> {
  return Promise.resolve(
    ctx.app.request(
      path,
      { method: "POST", headers, body: body as RequestInit["body"] },
      rawHeaders === undefined ? undefined : { incoming: { rawHeaders } },
    ),
  );
}

async function deliveries(
  ctx: TestContext,
  connector: { key: string; id: string },
  query = "",
): Promise<{ data: Delivery[]; next_cursor: string | null }> {
  const res = await request(
    ctx.app,
    "GET",
    `/connectors/${connector.id}/deliveries${query}`,
    { key: connector.key },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { data: Delivery[]; next_cursor: string | null };
}

describe("inbound webhook endpoints", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await context();
  });

  it("makes an endpoint for the connector's own key and the operator, answering the address once", async () => {
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector, {
      label: "github",
      duplicate_header: "X-GitHub-Delivery",
    });
    expect(made.path).toMatch(/^\/inbound\/[A-Za-z0-9_-]{43}$/);
    expect(made.duplicate_header).toBe("x-github-delivery");
    expect(made.retired_at).toBeNull();

    const byOperator = await request(
      ctx.app,
      "POST",
      `/connectors/${connector.id}/endpoints`,
      { key: ctx.operatorKey, body: {} },
    );
    expect(byOperator.status).toBe(201);

    const listed = await request(
      ctx.app,
      "GET",
      `/connectors/${connector.id}/endpoints`,
      { key: connector.key },
    );
    const { data } = (await listed.json()) as { data: Endpoint[] };
    const again = data.find((row) => row.id === made.id);
    expect(again?.path).toBe(`/inbound/****${made.path.slice(-4)}`);
  });

  it("refuses another key, a session token, an unknown registration and a header that is no header name", async () => {
    const connector = await register(ctx);
    const other = await mintWorkingKey(ctx);
    const refused = await request(
      ctx.app,
      "POST",
      `/connectors/${connector.id}/endpoints`,
      { key: other, body: {} },
    );
    expect(refused.status).toBe(403);
    const { token } = await seedOauthBearer(ctx.storage, ["items:read"]);
    const session = await request(
      ctx.app,
      "POST",
      `/connectors/${connector.id}/endpoints`,
      { key: token, body: {} },
    );
    expect(session.status).toBe(403);
    const unknown = await request(
      ctx.app,
      "POST",
      "/connectors/00000000-0000-7000-8000-000000000000/endpoints",
      { key: connector.key, body: {} },
    );
    expect(unknown.status).toBe(404);
    expect(
      ((await unknown.json()) as { error: { code: string } }).error.code,
    ).toBe("connector_not_found");
    const badHeader = await request(
      ctx.app,
      "POST",
      `/connectors/${connector.id}/endpoints`,
      { key: connector.key, body: { duplicate_header: "not a header" } },
    );
    expect(badHeader.status).toBe(400);
  });

  it("holds a registration to ten live endpoints, and a retired one frees a place", async () => {
    const connector = await register(ctx);
    const made: Endpoint[] = [];
    for (let i = 0; i < 10; i++) made.push(await endpoint(ctx, connector));
    const eleventh = await request(
      ctx.app,
      "POST",
      `/connectors/${connector.id}/endpoints`,
      { key: connector.key, body: {} },
    );
    expect(eleventh.status).toBe(409);
    expect(
      ((await eleventh.json()) as { error: { code: string } }).error.code,
    ).toBe("conflict");
    const retired = await request(
      ctx.app,
      "DELETE",
      `/connectors/${connector.id}/endpoints/${made[0]!.id}`,
      { key: connector.key },
    );
    expect(retired.status).toBe(200);
    await endpoint(ctx, connector);
  });

  it("retires an endpoint, after which its address answers as an unserved path does", async () => {
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    expect((await post(ctx, made.path, "before")).status).toBe(202);

    const res = await request(
      ctx.app,
      "DELETE",
      `/connectors/${connector.id}/endpoints/${made.id}`,
      { key: ctx.operatorKey },
    );
    expect(res.status).toBe(200);
    const retired = (await res.json()) as Endpoint;
    expect(retired.retired_at).not.toBeNull();
    const repeat = await request(
      ctx.app,
      "DELETE",
      `/connectors/${connector.id}/endpoints/${made.id}`,
      { key: connector.key },
    );
    expect(((await repeat.json()) as Endpoint).retired_at).toBe(
      retired.retired_at,
    );

    const after = await post(ctx, made.path, "after");
    const unserved = await post(ctx, "/no-such-door-at-all", "after");
    expect(after.status).toBe(404);
    expect(await after.json()).toEqual(await unserved.json());
    expect(after.headers.get("X-Error-Code")).toBe(
      unserved.headers.get("X-Error-Code"),
    );
    expect((await deliveries(ctx, connector)).data).toHaveLength(1);

    const unknown = await request(
      ctx.app,
      "DELETE",
      `/connectors/${connector.id}/endpoints/00000000-0000-7000-8000-000000000000`,
      { key: connector.key },
    );
    expect(unknown.status).toBe(404);
    expect(
      ((await unknown.json()) as { error: { code: string } }).error.code,
    ).toBe("endpoint_not_found");
  });

  it("audits a creation and a retirement, and not a receipt", async () => {
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    await post(ctx, made.path, "audited?");
    for (let i = 0; i < 2; i++) {
      await request(
        ctx.app,
        "DELETE",
        `/connectors/${connector.id}/endpoints/${made.id}`,
        { key: connector.key },
      );
    }
    const rows = await ctx.storage.audit.list({ resource_id: made.id });
    expect(rows.data.length >= 2).toBe(true);
    expect(rows.data.map((row) => row.action).sort()).toEqual([
      "inbound_endpoint.create",
      "inbound_endpoint.retire",
    ]);
  });

  it("stops answering once the registration's key is revoked", async () => {
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    expect((await post(ctx, made.path, "live")).status).toBe(202);
    const current = await request(ctx.app, "GET", "/keys/current", {
      key: connector.key,
    });
    const { id: keyId } = (await current.json()) as { id: string };
    await ctx.storage.keys.revoke(keyId);
    expect((await post(ctx, made.path, "revoked")).status).toBe(404);
  });

  it("stops answering once the registration's key has expired", async () => {
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    expect((await post(ctx, made.path, "live")).status).toBe(202);
    const current = await request(ctx.app, "GET", "/keys/current", {
      key: connector.key,
    });
    const { id: keyId } = (await current.json()) as { id: string };
    await (
      ctx.storage as unknown as {
        __sqliteRun: (query: string, params: unknown[]) => Promise<unknown>;
      }
    ).__sqliteRun("UPDATE api_keys SET expires_at = ? WHERE id = ?", [
      new Date(Date.now() - 1_000).toISOString(),
      keyId,
    ]);
    expect((await post(ctx, made.path, "expired")).status).toBe(404);
  });

  it("goes with its registration, and its deliveries with it", async () => {
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    expect((await post(ctx, made.path, "doomed")).status).toBe(202);
    const removed = await request(
      ctx.app,
      "DELETE",
      `/connectors/${connector.id}`,
      { key: connector.key },
    );
    expect(removed.status).toBe(200);
    expect((await post(ctx, made.path, "gone")).status).toBe(404);
    const rows = await (
      ctx.storage as unknown as {
        __sqliteAll: (query: string) => Promise<unknown[]>;
      }
    ).__sqliteAll(
      `SELECT id FROM inbound_deliveries WHERE connector_id = '${connector.id}'`,
    );
    expect(rows).toEqual([]);
  });
});

describe("the receiving door", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await context();
  });

  it("stores the body byte for byte, the headers as they arrived and the query as sent", async () => {
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    const body = new Uint8Array([
      0xff, 0xfe, 0x00, 0x0d, 0x0a, 0x7b, 0x22, 0xc3, 0x28, 0x7d, 0x20, 0x20,
    ]);
    const rawHeaders = [
      "Content-Type",
      "application/json",
      "X-Repeat",
      "one",
      "x-repeat",
      "two",
      "X-Hub-Signature-256",
      "sha256=abc",
    ];
    const res = await post(
      ctx,
      `${made.path}?b=2&a=%20one`,
      body,
      { "content-type": "application/json" },
      rawHeaders,
    );
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };

    const [stored] = (await deliveries(ctx, connector)).data;
    expect(stored?.id).toBe(id);
    expect(stored?.headers).toEqual([
      ["Content-Type", "application/json"],
      ["X-Repeat", "one"],
      ["x-repeat", "two"],
      ["X-Hub-Signature-256", "sha256=abc"],
    ]);
    expect(stored?.query).toBe("b=2&a=%20one");
    expect(stored?.method).toBe("POST");
    expect(stored?.size).toBe(body.length);

    const read = await request(
      ctx.app,
      "GET",
      `/connectors/${connector.id}/deliveries/${id}/body`,
      { key: connector.key },
    );
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("application/octet-stream");
    expect(read.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(body);
  });

  it("answers an unknown address exactly as a path the server does not serve", async () => {
    const unknown = await post(
      ctx,
      "/inbound/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "hello",
    );
    const unserved = await post(ctx, "/nowhere-at-all", "hello");
    expect(unknown.status).toBe(404);
    expect(unserved.status).toBe(404);
    expect(await unknown.json()).toEqual(await unserved.json());
    expect(unknown.headers.get("X-Error-Code")).toBe("not_found");
  });

  it("ignores a Marfa key on a receipt and stores the header like any other", async () => {
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    const res = await post(ctx, made.path, "keyed", {
      Authorization: `Bearer ${connector.key}`,
    });
    expect(res.status).toBe(202);
    const [stored] = (await deliveries(ctx, connector)).data;
    expect(stored?.headers).toContainEqual([
      "authorization",
      `Bearer ${connector.key}`,
    ]);
  });

  it("announces nothing on the event log", async () => {
    initEventLog(ctx.storage.eventLog);
    try {
      const connector = await register(ctx);
      const made = await endpoint(ctx, connector);
      const before = await ctx.storage.eventLog.getMaxId();
      expect((await post(ctx, made.path, "quiet")).status).toBe(202);
      expect(await ctx.storage.eventLog.getMaxId()).toBe(before);
      const written = await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: { type: "core.note", properties: { body: "witness" } },
      });
      expect(written.status).toBe(201);
      expect(await ctx.storage.eventLog.getMaxId()).not.toBe(before);
    } finally {
      __resetEventLogForTests();
    }
  });
});

describe("the receiving door's limits", () => {
  it("refuses a body over the limit and stores nothing, where one at the limit is stored", async () => {
    const ctx = await context({
      inbound: { ...DEFAULT_INBOUND_LIMITS, maxBytes: 16 },
    });
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    expect((await post(ctx, made.path, "x".repeat(16))).status).toBe(202);
    const over = await post(ctx, made.path, "x".repeat(17));
    expect(over.status).toBe(413);
    expect(
      ((await over.json()) as { error: { code: string } }).error.code,
    ).toBe("request_too_large");
    const streamed = await Promise.resolve(
      ctx.app.request(made.path, {
        method: "POST",
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("y".repeat(10)));
            controller.enqueue(new TextEncoder().encode("y".repeat(10)));
            controller.close();
          },
        }),
        duplex: "half",
      }),
    );
    expect(streamed.status).toBe(413);
    expect((await deliveries(ctx, connector)).data).toHaveLength(1);
  });

  it("holds each endpoint to its own rate window", async () => {
    const ctx = await context({
      rateLimitEnabled: true,
      inbound: { ...DEFAULT_INBOUND_LIMITS, requestsPerWindow: 2 },
    });
    const connector = await register(ctx);
    const first = await endpoint(ctx, connector);
    const second = await endpoint(ctx, connector);
    expect((await post(ctx, first.path, "1")).status).toBe(202);
    expect((await post(ctx, first.path, "2")).status).toBe(202);
    const refused = await post(ctx, first.path, "3");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await post(ctx, second.path, "1")).status).toBe(202);
  });

  it("refuses while the connector's backlog is full, and takes again once it drains", async () => {
    const ctx = await context({
      inbound: { ...DEFAULT_INBOUND_LIMITS, backlogDeliveries: 2 },
    });
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    expect((await post(ctx, made.path, "1")).status).toBe(202);
    expect((await post(ctx, made.path, "2")).status).toBe(202);
    const full = await post(ctx, made.path, "3");
    expect(full.status).toBe(503);
    expect(
      ((await full.json()) as { error: { code: string } }).error.code,
    ).toBe("inbound_unavailable");
    expect(full.headers.get("Retry-After")).toBe("60");
    const { data } = await deliveries(ctx, connector);
    await request(
      ctx.app,
      "POST",
      `/connectors/${connector.id}/deliveries/handled`,
      {
        key: connector.key,
        body: { ids: data.map((d) => d.id), outcome: "processed" },
      },
    );
    expect((await post(ctx, made.path, "4")).status).toBe(202);
  });

  it("refuses a body that would take the instance past its in-flight bytes", async () => {
    const ctx = await context({
      inbound: { ...DEFAULT_INBOUND_LIMITS, maxBytes: 64, inFlightBytes: 8 },
    });
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    expect((await post(ctx, made.path, "x".repeat(8))).status).toBe(202);
    const held = await post(ctx, made.path, "x".repeat(9));
    expect(held.status).toBe(503);
    expect(
      ((await held.json()) as { error: { code: string } }).error.code,
    ).toBe("inbound_unavailable");
  });
});

describe("reading and handling deliveries", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await context();
  });

  it("reads to the connector's own key alone", async () => {
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    const { id } = (await (await post(ctx, made.path, "mine")).json()) as {
      id: string;
    };
    const other = await mintWorkingKey(ctx);
    for (const key of [other, ctx.operatorKey]) {
      for (const [method, path, body] of [
        ["GET", `/connectors/${connector.id}/deliveries`, undefined],
        ["GET", `/connectors/${connector.id}/deliveries/${id}/body`, undefined],
        [
          "POST",
          `/connectors/${connector.id}/deliveries/handled`,
          { ids: [id], outcome: "processed" },
        ],
      ] as const) {
        const res = await request(ctx.app, method, path, { key, body });
        expect(res.status, `${method} ${path}`).toBe(403);
      }
    }
    expect((await deliveries(ctx, connector)).data[0]?.handled_at).toBeNull();
  });

  it("lists oldest first by cursor, narrowed by state and endpoint", async () => {
    const connector = await register(ctx);
    const first = await endpoint(ctx, connector);
    const second = await endpoint(ctx, connector);
    const ids: string[] = [];
    for (const [path, body] of [
      [first.path, "1"],
      [second.path, "2"],
      [first.path, "3"],
    ] as const) {
      ids.push(
        ((await (await post(ctx, path, body)).json()) as { id: string }).id,
      );
    }
    const page = await deliveries(ctx, connector, "?limit=2");
    expect(page.data.map((d) => d.id)).toEqual(ids.slice(0, 2));
    expect(page.next_cursor).not.toBeNull();
    const rest = await deliveries(
      ctx,
      connector,
      `?limit=2&cursor=${page.next_cursor!}`,
    );
    expect(rest.data.map((d) => d.id)).toEqual(ids.slice(2));
    expect(rest.next_cursor).toBeNull();

    const onFirst = await deliveries(
      ctx,
      connector,
      `?endpoint_id=${first.id}`,
    );
    expect(onFirst.data.map((d) => d.id)).toEqual([ids[0], ids[2]]);

    await request(
      ctx.app,
      "POST",
      `/connectors/${connector.id}/deliveries/handled`,
      { key: connector.key, body: { ids: [ids[1]], outcome: "rejected" } },
    );
    expect((await deliveries(ctx, connector)).data.map((d) => d.id)).toEqual([
      ids[0],
      ids[2],
    ]);
    expect(
      (await deliveries(ctx, connector, "?state=handled")).data.map(
        (d) => d.id,
      ),
    ).toEqual([ids[1]]);
    expect(
      (await deliveries(ctx, connector, "?state=any")).data.map((d) => d.id),
    ).toEqual(ids);
  });

  it("keeps the first mark, and marks nothing when an id is not the connector's", async () => {
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    const { id } = (await (await post(ctx, made.path, "once")).json()) as {
      id: string;
    };
    const mark = (ids: string[], outcome: string) =>
      request(
        ctx.app,
        "POST",
        `/connectors/${connector.id}/deliveries/handled`,
        {
          key: connector.key,
          body: { ids, outcome },
        },
      );
    const first = await mark([id], "processed");
    expect(first.status).toBe(200);
    const [marked] = ((await first.json()) as { data: Delivery[] }).data;
    expect(marked?.outcome).toBe("processed");
    const second = await mark([id], "rejected");
    const [again] = ((await second.json()) as { data: Delivery[] }).data;
    expect(again?.outcome).toBe("processed");
    expect(again?.handled_at).toBe(marked?.handled_at);

    const { id: fresh } = (await (
      await post(ctx, made.path, "fresh")
    ).json()) as { id: string };
    const foreign = await mark(
      [fresh, "00000000-0000-7000-8000-000000000000"],
      "processed",
    );
    expect(foreign.status).toBe(404);
    expect(
      ((await foreign.json()) as { error: { code: string } }).error.code,
    ).toBe("delivery_not_found");
    expect((await deliveries(ctx, connector)).data.map((d) => d.id)).toEqual([
      fresh,
    ]);
  });

  it("marks a repeat of the duplicate header with the first delivery and how it was handled", async () => {
    const connector = await register(ctx);
    const keyed = await endpoint(ctx, connector, {
      duplicate_header: "X-GitHub-Delivery",
    });
    const plain = await endpoint(ctx, connector);
    const send = async (path: string, delivery: string) =>
      (
        (await (
          await post(ctx, path, "{}", { "X-GitHub-Delivery": delivery })
        ).json()) as { id: string }
      ).id;
    const original = await send(keyed.path, "guid-1");
    const other = await send(keyed.path, "guid-2");
    const repeat = await send(keyed.path, "guid-1");
    const unkeyed = await send(plain.path, "guid-1");

    const byId = new Map(
      (await deliveries(ctx, connector)).data.map((d) => [d.id, d]),
    );
    expect(byId.get(original)?.duplicate_of).toBeNull();
    expect(byId.get(other)?.duplicate_of).toBeNull();
    expect(byId.get(unkeyed)?.duplicate_of).toBeNull();
    expect(byId.get(repeat)?.duplicate_of).toEqual({
      id: original,
      outcome: null,
    });

    await request(
      ctx.app,
      "POST",
      `/connectors/${connector.id}/deliveries/handled`,
      { key: connector.key, body: { ids: [original], outcome: "processed" } },
    );
    const after = (await deliveries(ctx, connector)).data.find(
      (d) => d.id === repeat,
    );
    expect(after?.duplicate_of).toEqual({ id: original, outcome: "processed" });
  });

  it("refuses a query key the listing does not declare, rather than answering unfiltered", async () => {
    const connector = await register(ctx);
    const res = await request(
      ctx.app,
      "GET",
      `/connectors/${connector.id}/deliveries?status=handled`,
      { key: connector.key },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details: { unknown_parameters: string[] } };
    };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.details.unknown_parameters).toEqual(["status"]);
    expect((await deliveries(ctx, connector, "?state=handled")).data).toEqual(
      [],
    );
  });

  it("answers delivery_not_found for a body the connector does not hold", async () => {
    const connector = await register(ctx);
    const res = await request(
      ctx.app,
      "GET",
      `/connectors/${connector.id}/deliveries/00000000-0000-7000-8000-000000000000/body`,
      { key: connector.key },
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "delivery_not_found",
    );
  });
});

describe("the door's order and bounds", () => {
  it("refuses a declared length over the limit before reading a byte", async () => {
    const ctx = await context({
      inbound: { ...DEFAULT_INBOUND_LIMITS, maxBytes: 16 },
    });
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    const refused = await post(ctx, made.path, "x", { "content-length": "17" });
    expect(refused.status).toBe(413);
    expect((await deliveries(ctx, connector)).data).toEqual([]);
  });

  it("answers an unknown address before it reads the body, where a known one refuses the same body", async () => {
    const ctx = await context({
      inbound: { ...DEFAULT_INBOUND_LIMITS, maxBytes: 16 },
    });
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    const body = "x".repeat(64);
    expect((await post(ctx, made.path, body)).status).toBe(413);
    expect(
      (
        await post(
          ctx,
          "/inbound/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          body,
        )
      ).status,
    ).toBe(404);
  });

  it("gives back the bytes a receipt held, so the next is taken", async () => {
    const ctx = await context({
      inbound: { ...DEFAULT_INBOUND_LIMITS, inFlightBytes: 8 },
    });
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    expect((await post(ctx, made.path, "x".repeat(8))).status).toBe(202);
    expect((await post(ctx, made.path, "y".repeat(8))).status).toBe(202);
  });

  it("counts the rate window before the backlog", async () => {
    const ctx = await context({
      rateLimitEnabled: true,
      inbound: {
        ...DEFAULT_INBOUND_LIMITS,
        requestsPerWindow: 1,
        backlogDeliveries: 1,
      },
    });
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    expect((await post(ctx, made.path, "1")).status).toBe(202);
    expect((await post(ctx, made.path, "2")).status).toBe(429);
  });

  it("refuses once the backlog's bytes are full", async () => {
    const ctx = await context({
      inbound: { ...DEFAULT_INBOUND_LIMITS, backlogBytes: 4 },
    });
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    expect((await post(ctx, made.path, "xxxx")).status).toBe(202);
    const full = await post(ctx, made.path, "y");
    expect(full.status).toBe(503);
    expect(
      ((await full.json()) as { error: { code: string } }).error.code,
    ).toBe("inbound_unavailable");
  });

  it("answers request_timeout to a body that does not arrive in time, and stores nothing", async () => {
    const ctx = await context({
      inbound: { ...DEFAULT_INBOUND_LIMITS, readTimeoutMs: 50 },
    });
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    const stalled = await Promise.resolve(
      ctx.app.request(made.path, {
        method: "POST",
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("part"));
          },
        }),
        duplex: "half",
      }),
    );
    expect(stalled.status).toBe(408);
    expect(
      ((await stalled.json()) as { error: { code: string } }).error.code,
    ).toBe("request_timeout");
    expect((await post(ctx, made.path, "whole")).status).toBe(202);
    expect((await deliveries(ctx, connector)).data).toHaveLength(1);
  });

  it("refuses a body that breaks off as the sender's, not the server's fault", async () => {
    const ctx = await context();
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    const written: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      });
    let broken: Response;
    try {
      broken = await Promise.resolve(
        ctx.app.request(made.path, {
          method: "POST",
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("part"));
              controller.error(new Error("the connection went away"));
            },
          }),
          duplex: "half",
        }),
      );
    } finally {
      spy.mockRestore();
    }
    expect(broken.status).toBe(400);
    expect(written.join("")).not.toContain("Unhandled error");
    expect((await deliveries(ctx, connector)).data).toEqual([]);
  });

  it("makes no more than ten live endpoints when asked for many at once", async () => {
    const ctx = await context();
    const connector = await register(ctx);
    const answers = await Promise.all(
      Array.from({ length: 20 }, () =>
        request(ctx.app, "POST", `/connectors/${connector.id}/endpoints`, {
          key: connector.key,
          body: {},
        }),
      ),
    );
    const statuses = answers.map((answer) => answer.status).sort();
    expect(statuses.filter((status) => status === 201)).toHaveLength(10);
    expect(statuses.filter((status) => status === 409)).toHaveLength(10);
  });

  it("marks a repeat only on its own endpoint", async () => {
    const ctx = await context();
    const a = await register(ctx);
    const b = await register(ctx);
    const header = { duplicate_header: "X-GitHub-Delivery" };
    const first = await endpoint(ctx, a, header);
    const second = await endpoint(ctx, a, header);
    const theirs = await endpoint(ctx, b, header);
    const send = async (path: string) =>
      (
        (await (
          await post(ctx, path, "{}", { "X-GitHub-Delivery": "same" })
        ).json()) as { id: string }
      ).id;
    const original = await send(first.path);
    const repeat = await send(first.path);
    const onSecond = await send(second.path);
    const onTheirs = await send(theirs.path);
    const mine = new Map(
      (await deliveries(ctx, a)).data.map((d) => [d.id, d.duplicate_of]),
    );
    expect(mine.get(repeat)).toEqual({ id: original, outcome: null });
    expect(mine.get(onSecond)).toBeNull();
    expect((await deliveries(ctx, b)).data.map((d) => d.duplicate_of)).toEqual([
      null,
    ]);
    expect(onTheirs).not.toBe(original);
  });

  it("keeps a connector's deliveries from another connector's key, however it names them", async () => {
    const ctx = await context();
    const a = await register(ctx);
    const b = await register(ctx);
    const made = await endpoint(ctx, a);
    const id = (
      (await (await post(ctx, made.path, "a's")).json()) as {
        id: string;
      }
    ).id;
    const body = await request(
      ctx.app,
      "GET",
      `/connectors/${b.id}/deliveries/${id}/body`,
      { key: b.key },
    );
    expect(body.status).toBe(404);
    const marked = await request(
      ctx.app,
      "POST",
      `/connectors/${b.id}/deliveries/handled`,
      { key: b.key, body: { ids: [id], outcome: "processed" } },
    );
    expect(marked.status).toBe(404);
    expect(
      (await deliveries(ctx, b, `?endpoint_id=${made.id}&state=any`)).data,
    ).toEqual([]);
    expect((await deliveries(ctx, a)).data.map((d) => d.id)).toEqual([id]);
  });

  it("writes no audit row for a receipt", async () => {
    const ctx = await context();
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    const count = async (): Promise<number> => {
      const [row] = (await (
        ctx.storage as unknown as {
          __sqliteAll: (query: string) => Promise<unknown[]>;
        }
      ).__sqliteAll("SELECT COUNT(*) AS n FROM audit_log")) as { n: number }[];
      return row?.n ?? 0;
    };
    {
      const auditResult = await ctx.storage.audit.list({
        resource_id: made.id,
      });
      expect(auditResult.data.length === 1).toBe(true);
    }
    const before = await count();
    expect((await post(ctx, made.path, "unaudited")).status).toBe(202);
    const witness = await endpoint(ctx, connector);
    {
      const auditResult = await ctx.storage.audit.list({
        resource_id: witness.id,
      });
      expect(auditResult.data.length === 1).toBe(true);
    }
    expect(await count()).toBe(before + 1);
  });

  it("keeps the address out of the error log when storing fails", async () => {
    const ctx = await context();
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    const token = made.path.slice("/inbound/".length);
    const store = ctx.storage.inbound;
    const receive = store.receive.bind(store);
    store.receive = () => Promise.reject(new Error("the disk went away"));
    const written: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      });
    try {
      expect((await post(ctx, made.path, "lost")).status).toBe(500);
    } finally {
      spy.mockRestore();
      store.receive = receive;
    }
    const log = written.join("");
    expect(log).toContain("Unhandled error");
    expect(log).toContain(`/inbound/****${token.slice(-4)}`);
    expect(log).not.toContain(token.slice(0, -4));
  });
});

describe("what reaches the logs", () => {
  it("writes no address, header, query or body of a receipt, where another door's path is written", async () => {
    const ctx = await context({
      inbound: { ...DEFAULT_INBOUND_LIMITS, maxBytes: 64 },
    });
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    const token = made.path.slice("/inbound/".length);
    const written: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      });
    try {
      expect(
        (
          await post(ctx, `${made.path}?q=QUERYSENTINEL`, "BODYSENTINEL", {
            "X-Sentinel": "HEADERSENTINEL",
          })
        ).status,
      ).toBe(202);
      expect(
        (await post(ctx, made.path, "OVERSIZEDSENTINEL".repeat(8))).status,
      ).toBe(413);
      await post(ctx, "/no-door-PATHSENTINEL", "x");
    } finally {
      spy.mockRestore();
    }
    const log = written.join("");
    expect(log).toContain("PATHSENTINEL");
    expect(log).toContain(`/inbound/****${token.slice(-4)}`);
    for (const secret of [
      token.slice(0, -4),
      "QUERYSENTINEL",
      "HEADERSENTINEL",
      "BODYSENTINEL",
      "OVERSIZEDSENTINEL",
    ]) {
      expect(log).not.toContain(secret);
    }
  });
});

describe("the inbound delivery sweep", () => {
  it("removes handled deliveries past a week and unhandled ones past thirty days, keeping the rest", async () => {
    const ctx = await context();
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    const receive = async (body: string) =>
      ((await (await post(ctx, made.path, body)).json()) as { id: string }).id;
    const oldHandled = await receive("old handled");
    const freshHandled = await receive("fresh handled");
    const oldPending = await receive("old pending");
    const freshPending = await receive("fresh pending");
    await request(
      ctx.app,
      "POST",
      `/connectors/${connector.id}/deliveries/handled`,
      {
        key: connector.key,
        body: { ids: [oldHandled, freshHandled], outcome: "processed" },
      },
    );
    const run = (
      ctx.storage as unknown as {
        __sqliteRun: (query: string, params: unknown[]) => Promise<unknown>;
      }
    ).__sqliteRun;
    const daysAgo = (days: number) =>
      new Date(Date.now() - days * 86_400_000).toISOString();
    await run("UPDATE inbound_deliveries SET handled_at = ? WHERE id = ?", [
      daysAgo(8),
      oldHandled,
    ]);
    await run("UPDATE inbound_deliveries SET received_at = ? WHERE id = ?", [
      daysAgo(31),
      oldPending,
    ]);
    await run("UPDATE inbound_deliveries SET received_at = ? WHERE id = ?", [
      daysAgo(20),
      freshPending,
    ]);

    const housekeeping = new Housekeeping(ctx.storage.housekeeping, {
      pollIntervalMs: 3_600_000,
    });
    registerHousekeepingJobs(housekeeping, ctx.storage, ctx.blobs, ctx.config);
    await housekeeping.start();
    try {
      const ran = await housekeeping.runNow("inbound-delivery-cleanup");
      expect(ran.kind).toBe("ran");
    } finally {
      await housekeeping.stop();
    }
    const left = (await deliveries(ctx, connector, "?state=any")).data.map(
      (d) => d.id,
    );
    expect(left.sort()).toEqual([freshHandled, freshPending].sort());
    const bodies = await (
      ctx.storage as unknown as {
        __sqliteAll: (query: string) => Promise<unknown[]>;
      }
    ).__sqliteAll(
      `SELECT delivery_id FROM inbound_delivery_bodies WHERE delivery_id IN ('${oldHandled}', '${oldPending}')`,
    );
    expect(bodies).toEqual([]);
  });

  it("keeps a kind whose retention is zero, whatever its age", async () => {
    const ctx = await context({
      inbound: {
        ...DEFAULT_INBOUND_LIMITS,
        handledRetentionDays: 0,
        pendingRetentionDays: 0,
      },
    });
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    const receive = async (body: string) =>
      ((await (await post(ctx, made.path, body)).json()) as { id: string }).id;
    const handled = await receive("handled");
    await receive("waiting");
    await request(
      ctx.app,
      "POST",
      `/connectors/${connector.id}/deliveries/handled`,
      { key: connector.key, body: { ids: [handled], outcome: "processed" } },
    );
    const run = (
      ctx.storage as unknown as {
        __sqliteRun: (query: string, params: unknown[]) => Promise<unknown>;
      }
    ).__sqliteRun;
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
    await run(
      "UPDATE inbound_deliveries SET received_at = ?, handled_at = CASE WHEN handled_at IS NULL THEN NULL ELSE ? END",
      [old, old],
    );
    expect(
      await ctx.storage.inbound.cleanup({ handledDays: 0, pendingDays: 0 }),
    ).toEqual({ deleted: 0, remaining: false });
    expect(
      await ctx.storage.inbound.cleanup({ handledDays: 0, pendingDays: 30 }),
    ).toEqual({ deleted: 1, remaining: false });
    const left = (await deliveries(ctx, connector, "?state=any")).data.map(
      (d) => d.id,
    );
    expect(left).toEqual([handled]);
  });
});

describe("authoritative inbound capacity", () => {
  it("checks concurrent completed bodies in the insertion transaction", async () => {
    const ctx = await context({
      inbound: { ...DEFAULT_INBOUND_LIMITS, backlogDeliveries: 2 },
    });
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    let reads = 0;
    let ready!: () => void;
    const allRead = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const original = ctx.storage.inbound.backlog.bind(ctx.storage.inbound);
    const spy = vi
      .spyOn(ctx.storage.inbound, "backlog")
      .mockImplementation(async (id) => {
        const value = await original(id);
        expect(value.count).toBe(0);
        if (++reads === 3) ready();
        return value;
      });
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const responses = Array.from({ length: 3 }, () =>
      Promise.resolve(
        ctx.app.request(made.path, {
          method: "POST",
          duplex: "half",
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controllers.push(controller);
              controller.enqueue(new TextEncoder().encode("x"));
            },
          }),
        }),
      ),
    );
    await allRead;
    spy.mockRestore();
    controllers.forEach((controller) => {
      controller.close();
    });
    expect((await Promise.all(responses)).map((r) => r.status).sort()).toEqual([
      202, 202, 503,
    ]);
    expect(await ctx.storage.inbound.backlog(connector.id)).toEqual({
      count: 2,
      bytes: 2,
    });
    expect((await deliveries(ctx, connector)).data).toHaveLength(2);
  });

  it("compares incoming bytes and permits a zero body at an exactly full byte limit", async () => {
    const ctx = await context({
      inbound: { ...DEFAULT_INBOUND_LIMITS, backlogBytes: 2 },
    });
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    expect((await post(ctx, made.path, "xxx")).status).toBe(503);
    expect((await post(ctx, made.path, "xx")).status).toBe(202);
    expect((await post(ctx, made.path, "")).status).toBe(202);
    expect((await post(ctx, made.path, "x")).status).toBe(503);
    expect(await ctx.storage.inbound.backlog(connector.id)).toEqual({
      count: 2,
      bytes: 2,
    });
  });

  it("charges handled zero-body receipts across retired and live endpoints", async () => {
    const ctx = await context({
      inbound: {
        ...DEFAULT_INBOUND_LIMITS,
        retainedDeliveries: 2,
        handledRetentionDays: 0,
        pendingRetentionDays: 0,
      },
    });
    const connector = await register(ctx);
    const first = await endpoint(ctx, connector);
    const second = await endpoint(ctx, connector);
    for (const path of [first.path, second.path]) {
      const response = await post(ctx, path + "?metadata=%C3%A9", "", {
        "X-Metadata": "stored",
      });
      expect(response.status).toBe(202);
      const { id } = (await response.json()) as { id: string };
      expect(
        (
          await request(
            ctx.app,
            "POST",
            `/connectors/${connector.id}/deliveries/handled`,
            {
              key: connector.key,
              body: { ids: [id], outcome: "processed" },
            },
          )
        ).status,
      ).toBe(200);
    }
    expect(
      (
        await request(
          ctx.app,
          "DELETE",
          `/connectors/${connector.id}/endpoints/${first.id}`,
          { key: connector.key },
        )
      ).status,
    ).toBe(200);
    expect((await post(ctx, second.path, "")).status).toBe(503);
    expect((await deliveries(ctx, connector, "?state=any")).data).toHaveLength(
      2,
    );
    const other = await register(ctx);
    expect(
      (await post(ctx, (await endpoint(ctx, other)).path, "")).status,
    ).toBe(202);
  });

  it("refuses an endpoint retired while its body is arriving", async () => {
    const ctx = await context();
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    let ready!: () => void;
    const read = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const original = ctx.storage.inbound.backlog.bind(ctx.storage.inbound);
    const spy = vi
      .spyOn(ctx.storage.inbound, "backlog")
      .mockImplementation(async (id) => {
        const value = await original(id);
        ready();
        return value;
      });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const receiving = Promise.resolve(
      ctx.app.request(made.path, {
        method: "POST",
        duplex: "half",
        body: new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
            c.enqueue(new TextEncoder().encode("x"));
          },
        }),
      }),
    );
    await read;
    spy.mockRestore();
    expect(
      (
        await request(
          ctx.app,
          "DELETE",
          `/connectors/${connector.id}/endpoints/${made.id}`,
          { key: connector.key },
        )
      ).status,
    ).toBe(200);
    controller.close();
    expect((await receiving).status).toBe(404);
    expect((await deliveries(ctx, connector, "?state=any")).data).toEqual([]);
  });

  it("bounds one cleanup pass and reports resumable remaining work", async () => {
    const ctx = await context();
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    const raw = ctx.storage as unknown as {
      __sqliteRun(query: string, params: unknown[]): Promise<unknown>;
      __sqliteAll(query: string): Promise<unknown[]>;
    };
    const original = await post(ctx, made.path, "x");
    const { id } = (await original.json()) as { id: string };
    await raw.__sqliteRun(
      `INSERT INTO inbound_deliveries SELECT 'copy-' || printf('%04d', value), endpoint_id, connector_id, received_at, method, query, headers, size, stored_bytes, sha256, dedupe_key, handled_at, outcome FROM inbound_deliveries, (WITH RECURSIVE n(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM n WHERE value < 500) SELECT value FROM n) WHERE id = ?`,
      [id],
    );
    await raw.__sqliteRun("UPDATE inbound_deliveries SET received_at = ?", [
      new Date(Date.now() - 40 * 86400000).toISOString(),
    ]);
    expect(
      await ctx.storage.inbound.cleanup({ handledDays: 7, pendingDays: 30 }),
    ).toEqual({ deleted: 500, remaining: true });
    expect(
      await ctx.storage.inbound.cleanup({ handledDays: 7, pendingDays: 30 }),
    ).toEqual({ deleted: 1, remaining: false });
  });

  it("round trips live retention overrides without making capacity optional", async () => {
    const ctx = await context();
    const got = await request(ctx.app, "GET", "/config", {
      key: ctx.workingKey,
    });
    const config = (await got.json()) as Record<string, unknown>;
    const changed = await request(ctx.app, "PUT", "/config", {
      key: ctx.workingKey,
      body: {
        ...config,
        inbound_handled_retention_days: 0,
        inbound_pending_retention_days: 2,
      },
    });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({
      inbound_handled_retention_days: 0,
      inbound_pending_retention_days: 2,
    });
  });
});

describe("inbound charged storage and cleanup", () => {
  function raw(ctx: TestContext) {
    return ctx.storage as unknown as {
      __sqliteRun(query: string, params: unknown[]): Promise<unknown>;
      __sqliteAll(query: string): Promise<Record<string, unknown>[]>;
    };
  }

  it("charges canonical UTF-8 metadata and body once, with exact and one-byte-over boundaries", async () => {
    const ctx = await context({ inbound: { ...DEFAULT_INBOUND_LIMITS } });
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector, {
      duplicate_header: "X-Delivery",
    });
    const path = made.path + "?q=%C3%A9";
    const headers = { "X-Delivery": "same", "X-Metadata": "café" };
    const first = await post(ctx, path, "é", headers, [
      "X-Delivery",
      "same",
      "X-Metadata",
      "café",
      "X-Metadata",
      "repeat",
    ]);
    expect(first.status).toBe(202);
    const { id } = (await first.json()) as { id: string };
    const [row] = await raw(ctx).__sqliteAll(
      `SELECT * FROM inbound_deliveries WHERE id = '${id}'`,
    );
    const metadata = {
      id: row!.id,
      endpoint_id: row!.endpoint_id,
      connector_id: row!.connector_id,
      received_at: row!.received_at,
      method: row!.method,
      query: row!.query,
      headers: JSON.parse(row!.headers as string) as [string, string][],
      size: row!.size,
      sha256: row!.sha256,
      dedupe_key: row!.dedupe_key,
      handled_at: null,
      outcome: null,
    };
    const charge = 2 + Buffer.byteLength(JSON.stringify(metadata), "utf8") + 32;
    expect(row!.stored_bytes).toBe(charge);
    expect(Buffer.byteLength(JSON.stringify(metadata), "utf8")).toBeGreaterThan(
      JSON.stringify(metadata).length,
    );
    ctx.config.inbound!.retainedBytes = charge * 2 - 1;
    expect(
      (
        await post(ctx, path, "é", headers, [
          "X-Delivery",
          "same",
          "X-Metadata",
          "café",
          "X-Metadata",
          "repeat",
        ])
      ).status,
    ).toBe(503);
    ctx.config.inbound!.retainedBytes = charge * 2;
    const equal = await post(ctx, path, "é", headers, [
      "X-Delivery",
      "same",
      "X-Metadata",
      "café",
      "X-Metadata",
      "repeat",
    ]);
    expect(equal.status).toBe(202);
    const second = (await equal.json()) as { id: string };
    const marked = await ctx.storage.inbound.markHandled(
      connector.id,
      [second.id, id],
      "processed",
    );
    expect(marked?.map((d) => d.id)).toEqual([second.id, id]);
    expect(
      (
        await ctx.storage.inbound.markHandled(connector.id, [id], "rejected")
      )?.[0]?.outcome,
    ).toBe("processed");
    const [total] = await raw(ctx).__sqliteAll(
      "SELECT SUM(stored_bytes) AS bytes FROM inbound_deliveries",
    );
    expect(total!.bytes).toBe(charge * 2);
    const publicRows = (await deliveries(ctx, connector, "?state=any")).data;
    expect(publicRows.find((d) => d.id === second.id)?.duplicate_of).toEqual({
      id,
      outcome: "processed",
    });
    expect(publicRows.every((d) => !("stored_bytes" in d))).toBe(true);
    expect((await post(ctx, path, "", headers)).status).toBe(503);
  });

  it("rolls metadata and body insertion back together before accepting a later receipt", async () => {
    const ctx = await context({
      inbound: { ...DEFAULT_INBOUND_LIMITS, retainedDeliveries: 1 },
    });
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    await raw(ctx).__sqliteRun(
      "CREATE TRIGGER fixture_body_insert BEFORE INSERT ON inbound_delivery_bodies BEGIN SELECT RAISE(ABORT, 'fixture body insert failure'); END",
      [],
    );
    expect((await post(ctx, made.path, "x")).status).toBe(500);
    expect(
      await raw(ctx).__sqliteAll("SELECT id FROM inbound_deliveries"),
    ).toEqual([]);
    expect(
      await raw(ctx).__sqliteAll(
        "SELECT delivery_id FROM inbound_delivery_bodies",
      ),
    ).toEqual([]);
    await raw(ctx).__sqliteRun("DROP TRIGGER fixture_body_insert", []);
    expect((await post(ctx, made.path, "x")).status).toBe(202);
    expect((await post(ctx, made.path, "x")).status).toBe(503);
  });

  it("rolls cleanup cascades back and resumes in mixed age order within the byte target", async () => {
    const ctx = await context();
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++)
      ids.push(
        ((await (await post(ctx, made.path, "body")).json()) as { id: string })
          .id,
      );
    await ctx.storage.inbound.markHandled(
      connector.id,
      [ids[1]!, ids[3]!],
      "processed",
    );
    const ago = (days: number) =>
      new Date(Date.now() - days * 86400000).toISOString();
    await raw(ctx).__sqliteRun(
      "UPDATE inbound_deliveries SET received_at = ?, handled_at = CASE WHEN handled_at IS NULL THEN NULL ELSE ? END, stored_bytes = ? WHERE id = ?",
      [ago(60), ago(60), 33 * 1024 * 1024, ids[0]],
    );
    await raw(ctx).__sqliteRun(
      "UPDATE inbound_deliveries SET handled_at = ?, stored_bytes = ? WHERE id = ?",
      [ago(50), 20 * 1024 * 1024, ids[1]],
    );
    await raw(ctx).__sqliteRun(
      "UPDATE inbound_deliveries SET received_at = ?, stored_bytes = ? WHERE id = ?",
      [ago(40), 13 * 1024 * 1024, ids[2]],
    );
    await raw(ctx).__sqliteRun(
      "CREATE TRIGGER fixture_body_delete BEFORE DELETE ON inbound_delivery_bodies BEGIN SELECT RAISE(ABORT, 'fixture body delete failure'); END",
      [],
    );
    await expect(
      ctx.storage.inbound.cleanup({ handledDays: 7, pendingDays: 30 }),
    ).rejects.toThrow();
    expect(
      await raw(ctx).__sqliteAll("SELECT id FROM inbound_deliveries"),
    ).toHaveLength(4);
    expect(
      await raw(ctx).__sqliteAll(
        "SELECT delivery_id FROM inbound_delivery_bodies",
      ),
    ).toHaveLength(4);
    await raw(ctx).__sqliteRun("DROP TRIGGER fixture_body_delete", []);
    expect(
      await ctx.storage.inbound.cleanup({ handledDays: 7, pendingDays: 30 }),
    ).toEqual({ deleted: 1, remaining: true });
    expect(await ctx.storage.inbound.body(connector.id, ids[0]!)).toBeNull();
    expect(await ctx.storage.inbound.body(connector.id, ids[1]!)).toEqual(
      Buffer.from("body"),
    );
    expect(
      await ctx.storage.inbound.cleanup({ handledDays: 7, pendingDays: 30 }),
    ).toEqual({ deleted: 1, remaining: true });
    expect(await ctx.storage.inbound.body(connector.id, ids[1]!)).toBeNull();
    expect(await ctx.storage.inbound.body(connector.id, ids[2]!)).toEqual(
      Buffer.from("body"),
    );
    expect(
      await ctx.storage.inbound.cleanup({ handledDays: 7, pendingDays: 30 }),
    ).toEqual({ deleted: 1, remaining: false });
    expect(
      (await deliveries(ctx, connector, "?state=any")).data.map((d) => d.id),
    ).toEqual([ids[3]]);
  });

  it("uses current retention overrides on each ordinary housekeeping pass", async () => {
    const ctx = await context();
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    const id = (
      (await (await post(ctx, made.path, "body")).json()) as { id: string }
    ).id;
    await ctx.storage.inbound.markHandled(connector.id, [id], "processed");
    await raw(ctx).__sqliteRun(
      "UPDATE inbound_deliveries SET handled_at = ? WHERE id = ?",
      [new Date(Date.now() - 10 * 86400000).toISOString(), id],
    );
    const housekeeping = new Housekeeping(ctx.storage.housekeeping, {
      pollIntervalMs: 3600000,
    });
    registerHousekeepingJobs(housekeeping, ctx.storage, ctx.blobs, ctx.config);
    await housekeeping.start();
    try {
      expect(
        (
          await request(ctx.app, "PUT", "/config", {
            key: ctx.workingKey,
            body: {
              inbound_handled_retention_days: 0,
              inbound_pending_retention_days: 0,
            },
          })
        ).status,
      ).toBe(200);
      await housekeeping.runNow("inbound-delivery-cleanup");
      expect(await ctx.storage.inbound.body(connector.id, id)).toEqual(
        Buffer.from("body"),
      );
      expect(
        (
          await request(ctx.app, "PUT", "/config", {
            key: ctx.workingKey,
            body: { inbound_handled_retention_days: 1 },
          })
        ).status,
      ).toBe(200);
      await housekeeping.runNow("inbound-delivery-cleanup");
      expect(await ctx.storage.inbound.body(connector.id, id)).toBeNull();
      for (const value of [-1, 1.5])
        expect(
          (
            await request(ctx.app, "PUT", "/config", {
              key: ctx.workingKey,
              body: { inbound_handled_retention_days: value },
            })
          ).status,
        ).toBe(400);
    } finally {
      await housekeeping.stop();
    }
  });

  it.each(["revoked", "expired"])(
    "rechecks a %s registration key after a held body",
    async (standing) => {
      const ctx = await context();
      const connector = await register(ctx);
      const made = await endpoint(ctx, connector);
      expect((await post(ctx, made.path, "positive standing")).status).toBe(
        202,
      );
      const current = await request(ctx.app, "GET", "/keys/current", {
        key: connector.key,
      });
      const { id } = (await current.json()) as { id: string };
      let signal!: () => void;
      const entered = new Promise<void>((resolve) => {
        signal = resolve;
      });
      const original = ctx.storage.inbound.backlog.bind(ctx.storage.inbound);
      const spy = vi
        .spyOn(ctx.storage.inbound, "backlog")
        .mockImplementation(async (connectorId) => {
          const value = await original(connectorId);
          signal();
          return value;
        });
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const response = Promise.resolve(
        ctx.app.request(made.path, {
          method: "POST",
          duplex: "half",
          body: new ReadableStream<Uint8Array>({
            start(c) {
              controller = c;
              c.enqueue(new TextEncoder().encode("late"));
            },
          }),
        }),
      );
      await entered;
      spy.mockRestore();
      if (standing === "revoked") await ctx.storage.keys.revoke(id);
      else
        await raw(ctx).__sqliteRun(
          "UPDATE api_keys SET expires_at = ? WHERE id = ?",
          [new Date(Date.now() - 1000).toISOString(), id],
        );
      controller.close();
      expect((await response).status).toBe(404);
      expect(await ctx.storage.inbound.backlog(connector.id)).toEqual({
        count: 1,
        bytes: Buffer.byteLength("positive standing"),
      });
    },
  );
});

describe("inbound storage-failure privacy", () => {
  it.each(["inbound_deliveries", "inbound_delivery_bodies"])(
    "reports a real %s SQLite failure to every error sink as the fixed database failure",
    async (table) => {
      const ctx = await context({
        errorWebhookUrl: "http://127.0.0.1:9/fixture-error",
      });
      const connector = await register(ctx);
      const made = await endpoint(ctx, connector);
      const raw = ctx.storage as unknown as {
        __sqliteRun(query: string, params: unknown[]): Promise<unknown>;
        __sqliteAll(query: string): Promise<unknown[]>;
      };
      await raw.__sqliteRun(
        `CREATE TRIGGER fixture_receipt_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END`,
        [],
      );
      const sentinels = [
        "HEADER_SENTINEL_" + table,
        "QUERY_SENTINEL_" + table,
        "BODY_SENTINEL_" + table,
      ];
      const real = ctx.storage.inbound.receive.bind(ctx.storage.inbound);
      let thrown: unknown;
      const receive = vi
        .spyOn(ctx.storage.inbound, "receive")
        .mockImplementation(async (...args) => {
          try {
            return await real(...args);
          } catch (error) {
            thrown = error;
            throw error;
          }
        });
      const written: string[] = [];
      const stdout = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk: string | Uint8Array) => {
          written.push(String(chunk));
          return true;
        });
      const reported: unknown[] = [];
      const previousReporter = globalThis.__marfaReportException;
      globalThis.__marfaReportException = (error, attributes) => {
        reported.push({ error, attributes });
      };
      const span = trace.wrapSpanContext({
        traceId: "1".repeat(32),
        spanId: "1".repeat(16),
        traceFlags: 0,
      });
      const recorded = vi.spyOn(span, "recordException");
      const active = vi.spyOn(trace, "getActiveSpan").mockReturnValue(span);
      const notified = vi
        .spyOn(errorNotifier, "notifyError")
        .mockImplementation(() => undefined);
      try {
        const response = await post(
          ctx,
          made.path + "?q=" + sentinels[1]!,
          sentinels[2]!,
          { "X-Fixture": sentinels[0]! },
        );
        expect(response.status).toBe(500);
        expect(
          ((await response.json()) as { error: { code: string } }).error.code,
        ).toBe("internal_error");
        expect(
          await raw.__sqliteAll("SELECT id FROM inbound_deliveries"),
        ).toEqual([]);
        expect(
          await raw.__sqliteAll(
            "SELECT delivery_id FROM inbound_delivery_bodies",
          ),
        ).toEqual([]);
        // The witness: the failed statement carries what it was bound to.
        const bound =
          table === "inbound_deliveries"
            ? sentinels.slice(0, 2)
            : sentinels.slice(2);
        for (const sentinel of bound)
          expect((thrown as Error).message).toContain(sentinel);
        expect(reported).toHaveLength(1);
        expect(recorded).toHaveBeenCalledOnce();
        expect(notified).toHaveBeenCalledOnce();
        const errors = [
          (reported[0] as { error: Error }).error,
          recorded.mock.calls[0]![0] as Error,
        ];
        const outputs = [
          written.join(""),
          ...errors.map((error) =>
            JSON.stringify({
              message: error.message,
              stack: error.stack,
              cause: error.cause,
            }),
          ),
          JSON.stringify(notified.mock.calls),
        ];
        for (const output of outputs)
          for (const sentinel of sentinels)
            expect(output).not.toContain(sentinel);
        const fixed = "Database operation failed (SQLITE_CONSTRAINT_TRIGGER)";
        expect(errors[0]!.message).toBe(fixed);
        expect(errors[1]!.name).toBe("DatabaseFailure");
        expect(errors[1]!.message).toBe(`DatabaseFailure: ${fixed}`);
        for (const error of errors) {
          expect(error.cause).toBeUndefined();
          expect(error.stack).not.toContain("Failed query");
        }
        for (const output of outputs) {
          expect(output).not.toContain("Failed query");
          expect(output).not.toContain("fixture receipt failure");
        }
        expect(written.join("")).toContain("Unhandled error");
        expect(written.join("")).toContain(fixed);
        expect(notified.mock.calls[0]![1].error).toBe(
          `DatabaseFailure: ${fixed}`,
        );
      } finally {
        receive.mockRestore();
        stdout.mockRestore();
        active.mockRestore();
        recorded.mockRestore();
        notified.mockRestore();
        globalThis.__marfaReportException = previousReporter;
        await raw.__sqliteRun("DROP TRIGGER fixture_receipt_failure", []);
      }
      expect((await post(ctx, made.path, "positive recovery")).status).toBe(
        202,
      );
    },
  );

  it("preserves a wrapped typed write-contention refusal", async () => {
    const ctx = await context();
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    const refusal = new MarfaError(
      ErrorCode.WRITE_CONTENTION,
      "The writer is occupied",
    );
    const spy = vi
      .spyOn(ctx.storage.inbound, "receive")
      .mockRejectedValue(new Error("query wrapper", { cause: refusal }));
    try {
      const response = await post(ctx, made.path, "typed control");
      expect(response.status).toBe(503);
      expect(
        ((await response.json()) as { error: { code: string } }).error.code,
      ).toBe("write_contention");
    } finally {
      spy.mockRestore();
    }
    expect((await post(ctx, made.path, "positive recovery")).status).toBe(202);
  });
});

it("derives duplicate-header policy from the insertion transaction", async () => {
  const ctx = await context();
  const connector = await register(ctx);
  const made = await endpoint(ctx, connector, {
    duplicate_header: "X-Earlier",
  });
  let signal!: () => void;
  const ready = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const original = ctx.storage.inbound.backlog.bind(ctx.storage.inbound);
  const spy = vi
    .spyOn(ctx.storage.inbound, "backlog")
    .mockImplementation(async (id) => {
      const result = await original(id);
      signal();
      return result;
    });
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = Promise.resolve(
    ctx.app.request(made.path, {
      method: "POST",
      duplex: "half",
      headers: { "X-Earlier": "old", "X-Current": "new" },
      body: new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
          c.enqueue(new TextEncoder().encode("x"));
        },
      }),
    }),
  );
  await ready;
  spy.mockRestore();
  const raw = ctx.storage as unknown as {
    __sqliteRun(query: string, params: unknown[]): Promise<unknown>;
    __sqliteAll(query: string): Promise<{ dedupe_key: string }[]>;
  };
  await raw.__sqliteRun(
    "UPDATE inbound_endpoints SET duplicate_header = ? WHERE id = ?",
    ["x-current", made.id],
  );
  controller.close();
  expect((await response).status).toBe(202);
  expect(
    await raw.__sqliteAll("SELECT dedupe_key FROM inbound_deliveries"),
  ).toEqual([{ dedupe_key: "new" }]);
});

describe("inbound retention ordering", () => {
  it("merges equal handled and pending ages by id and keeps future receipts", async () => {
    const ctx = await context();
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++)
      ids.push(
        ((await (await post(ctx, made.path, "body")).json()) as { id: string })
          .id,
      );
    const raw = ctx.storage as unknown as {
      __sqliteRun(query: string, params: unknown[]): Promise<unknown>;
      __sqliteAll(query: string): Promise<unknown[]>;
    };
    await ctx.storage.inbound.markHandled(connector.id, [ids[1]!], "processed");
    const old = new Date(Date.now() - 50 * 86400000).toISOString();
    for (const id of ids.slice(0, 3))
      await raw.__sqliteRun(
        "UPDATE inbound_deliveries SET received_at = ?, handled_at = CASE WHEN handled_at IS NULL THEN NULL ELSE ? END, stored_bytes = ? WHERE id = ?",
        [old, old, 20 * 1024 * 1024, id],
      );
    await raw.__sqliteRun(
      "UPDATE inbound_deliveries SET received_at = ? WHERE id = ?",
      [new Date(Date.now() + 86400000).toISOString(), ids[3]],
    );
    const ordered = ids.slice(0, 3).sort();
    for (let i = 0; i < ordered.length; i++) {
      expect(
        await ctx.storage.inbound.cleanup({ handledDays: 7, pendingDays: 30 }),
      ).toEqual({ deleted: 1, remaining: i < 2 });
      for (const id of ordered.slice(0, i + 1))
        expect(await ctx.storage.inbound.body(connector.id, id)).toBeNull();
      for (const id of [...ordered.slice(i + 1), ids[3]!])
        expect(await ctx.storage.inbound.body(connector.id, id)).toEqual(
          Buffer.from("body"),
        );
    }
    const plans = await raw.__sqliteAll(
      `EXPLAIN QUERY PLAN SELECT id, stored_bytes FROM (SELECT * FROM (SELECT id, stored_bytes, handled_at AS stamp FROM inbound_deliveries WHERE handled_at IS NOT NULL AND handled_at < '${old}' ORDER BY handled_at, id LIMIT 500) UNION ALL SELECT * FROM (SELECT id, stored_bytes, received_at AS stamp FROM inbound_deliveries WHERE handled_at IS NULL AND received_at < '${old}' ORDER BY received_at, id LIMIT 500)) ORDER BY stamp, id LIMIT 500`,
    );
    expect(JSON.stringify(plans)).toContain(
      "idx_inbound_deliveries_handled_age",
    );
    expect(JSON.stringify(plans)).toContain(
      "idx_inbound_deliveries_pending_age",
    );
  });

  it("uses the earliest remaining duplicate after expiry without changing first handled outcomes", async () => {
    const ctx = await context();
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector, {
      duplicate_header: "X-Delivery",
    });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++)
      ids.push(
        (
          (await (
            await post(ctx, made.path, "body", { "X-Delivery": "same" })
          ).json()) as { id: string }
        ).id,
      );
    await ctx.storage.inbound.markHandled(connector.id, [ids[0]!], "processed");
    expect(
      (await deliveries(ctx, connector, "?state=any")).data[2]?.duplicate_of,
    ).toEqual({ id: ids[0], outcome: "processed" });
    const raw = ctx.storage as unknown as {
      __sqliteRun(query: string, params: unknown[]): Promise<unknown>;
    };
    await raw.__sqliteRun(
      "UPDATE inbound_deliveries SET handled_at = ? WHERE id = ?",
      [new Date(Date.now() - 10 * 86400000).toISOString(), ids[0]],
    );
    expect(
      await ctx.storage.inbound.cleanup({ handledDays: 7, pendingDays: 30 }),
    ).toEqual({ deleted: 1, remaining: false });
    const page = await ctx.storage.inbound.listDeliveries(
      connector.id,
      { state: "any" },
      { limit: 1 },
    );
    expect(page.data[0]?.id).toBe(ids[1]);
    expect(page.data[0]?.duplicate_of).toBeNull();
    const remaining = await ctx.storage.inbound.listDeliveries(
      connector.id,
      { state: "any" },
      { limit: 1, cursor: page.next_cursor! },
    );
    expect(remaining.data[0]?.duplicate_of).toEqual({
      id: ids[1],
      outcome: null,
    });
    expect(
      (
        await ctx.storage.inbound.markHandled(
          connector.id,
          [ids[2]!, ids[1]!],
          "rejected",
        )
      )?.map((d) => d.id),
    ).toEqual([ids[2], ids[1]]);
    expect(
      (
        await ctx.storage.inbound.markHandled(
          connector.id,
          [ids[1]!],
          "processed",
        )
      )?.[0]?.outcome,
    ).toBe("rejected");
  });
});

describe("a body field the operation does not declare", () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await context();
  });

  const unknownFields = async (res: Response): Promise<unknown> => {
    const body = (await res.json()) as {
      error: { code: string; details?: { unknown_body_fields?: unknown } };
    };
    expect(body.error.code).toBe("validation_error");
    return body.error.details?.unknown_body_fields;
  };

  it("refuses an endpoint that carries one, and makes none", async () => {
    const connector = await register(ctx);
    const path = `/connectors/${connector.id}/endpoints`;
    const refused = await request(ctx.app, "POST", path, {
      key: connector.key,
      body: { lable: "misspelled" },
    });
    expect(refused.status).toBe(400);
    expect(await unknownFields(refused)).toEqual(["lable"]);
    const listed = (await (
      await request(ctx.app, "GET", path, { key: connector.key })
    ).json()) as { data: Endpoint[] };
    expect(listed.data).toEqual([]);

    const made = await request(ctx.app, "POST", path, {
      key: ctx.operatorKey,
      body: { label: "kept", _client: "ignored" },
    });
    expect(made.status).toBe(201);
  });

  it("refuses a handled mark that carries one, and marks nothing", async () => {
    const connector = await register(ctx);
    const made = await endpoint(ctx, connector);
    const { id } = (await (await post(ctx, made.path, "once")).json()) as {
      id: string;
    };
    const path = `/connectors/${connector.id}/deliveries/handled`;
    const refused = await request(ctx.app, "POST", path, {
      key: connector.key,
      body: { ids: [id], outcome: "processed", outcom: "misspelled" },
    });
    expect(refused.status).toBe(400);
    expect(await unknownFields(refused)).toEqual(["outcom"]);
    expect((await deliveries(ctx, connector)).data[0]?.handled_at).toBeNull();

    const marked = await request(ctx.app, "POST", path, {
      key: connector.key,
      body: { ids: [id], outcome: "processed" },
    });
    expect(marked.status).toBe(200);
  });

  it("answers a key that is not the connector's, and an id nothing carries, before it names the field", async () => {
    const connector = await register(ctx);
    const other = await mintWorkingKey(ctx);
    const missing = "00000000-0000-7000-8000-000000000000";
    for (const [suffix, body] of [
      ["endpoints", { lable: "x" }],
      [
        "deliveries/handled",
        { ids: [missing], outcome: "processed", outcom: "x" },
      ],
    ] as const) {
      const asOther = await request(
        ctx.app,
        "POST",
        `/connectors/${connector.id}/${suffix}`,
        { key: other, body },
      );
      expect(asOther.status, suffix).toBe(403);
      const unknown = await request(
        ctx.app,
        "POST",
        `/connectors/${missing}/${suffix}`,
        { key: connector.key, body },
      );
      expect(unknown.status, suffix).toBe(404);
    }
  });
});
