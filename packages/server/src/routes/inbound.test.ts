import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import { DEFAULT_INBOUND_LIMITS } from "../config.js";
import {
  createTestContext,
  mintWorkingKey,
  request,
  seedOauthBearer,
  waitForAudit,
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
    const rows = await waitForAudit(
      () => ctx.storage.audit.list({ resource_id: made.id }),
      (r) => r.data.length >= 2,
    );
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
    await waitForAudit(
      () => ctx.storage.audit.list({ resource_id: made.id }),
      (r) => r.data.length === 1,
    );
    const before = await count();
    expect((await post(ctx, made.path, "unaudited")).status).toBe(202);
    const witness = await endpoint(ctx, connector);
    await waitForAudit(
      () => ctx.storage.audit.list({ resource_id: witness.id }),
      (r) => r.data.length === 1,
    );
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
    ).toBe(0);
    expect(
      await ctx.storage.inbound.cleanup({ handledDays: 0, pendingDays: 30 }),
    ).toBe(1);
    const left = (await deliveries(ctx, connector, "?state=any")).data.map(
      (d) => d.id,
    );
    expect(left).toEqual([handled]);
  });
});
