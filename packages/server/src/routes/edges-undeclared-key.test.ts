/**
 * Every door that creates or updates an edge refuses a body key it does not
 * declare, for a key and for an app the owner signed in alike, and writes
 * nothing.
 *
 * Keys inside `properties` are the edge type's, not the door's, so a
 * property the edge type's schema does not name still lands.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, request, seedOauthBearer } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;
let appToken = "";
let source = "";
const targets: string[] = [];

beforeAll(async () => {
  ctx = await createTestContext();
  ({ token: appToken } = await seedOauthBearer(ctx, [
    "core.note:write",
    "edge.about:write",
  ]));
  const note = async (): Promise<string> => {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { body: "an end" } },
    });
    expect(res.status, "the fixture cannot seed an edge end").toBe(201);
    return ((await res.json()) as { item: { id: string } }).item.id;
  };
  source = await note();
  for (let i = 0; i < 19; i += 1) targets.push(await note());
});

afterAll(async () => {
  await ctx.cleanup();
});

type Caller = "key" | "app";

function send(caller: Caller, path: string, body: unknown): Promise<Response> {
  return request(ctx.app, "POST", path, {
    key: caller === "key" ? ctx.workingKey : appToken,
    body,
  });
}

/** The target IDs of the `about` edges leaving the source. */
async function aboutTargets(): Promise<string[]> {
  const res = await request(
    ctx.app,
    "GET",
    `/items/${source}/edges?edge_type=about&limit=100`,
    { key: ctx.workingKey },
  );
  expect(res.status, "the listing that proves what was created failed").toBe(
    200,
  );
  const body = (await res.json()) as { data: { target_id: string }[] };
  return body.data.map((e) => e.target_id);
}

let next = 0;
function target(): string {
  const id = targets[next];
  next += 1;
  if (id === undefined) throw new Error("the fixture ran out of edge ends");
  return id;
}

interface ValidationRefusal {
  error: {
    code: string;
    details?: { unknown_body_fields?: string[] };
  };
}

/** The keys a refusal names as undeclared. */
function named(details: unknown): string[] {
  return (
    (details as { unknown_body_fields?: string[] } | undefined)
      ?.unknown_body_fields ?? []
  );
}

describe.each<Caller>(["key", "app"])("as the %s", (caller) => {
  it("PATCH /edges/{id} refuses every undeclared key and writes nothing, where the declared body updates the edge", async () => {
    const created = await send(caller, "/edges", {
      edge_type: "about",
      source_id: source,
      target_id: target(),
      properties: { note: "first" },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const { edge } = (await created.json()) as { edge: { id: string } };
    const bearer = caller === "key" ? ctx.workingKey : appToken;

    const refused = await request(ctx.app, "PATCH", `/edges/${edge.id}`, {
      key: bearer,
      body: {
        version: 1,
        properties: { note: "second" },
        weight: 9,
        data: {},
      },
    });
    const body = (await refused.json()) as ValidationRefusal;
    expect(refused.status, JSON.stringify(body)).toBe(400);
    expect(body.error.code).toBe("validation_error");
    expect(named(body.error.details)).toEqual(["data", "weight"]);

    const read = async () => {
      const res = await request(ctx.app, "GET", `/edges/${edge.id}`, {
        key: ctx.workingKey,
      });
      return (
        (await res.json()) as {
          edge: { version: number; properties: Record<string, unknown> };
        }
      ).edge;
    };
    expect(await read()).toMatchObject({
      version: 1,
      properties: { note: "first" },
    });

    // The witness: the same change without the undeclared keys is written.
    const updated = await request(ctx.app, "PATCH", `/edges/${edge.id}`, {
      key: bearer,
      body: { version: 1, properties: { note: "second" } },
    });
    expect(updated.status, await updated.clone().text()).toBe(200);
    expect(await read()).toMatchObject({
      version: 2,
      properties: { note: "second" },
    });
  });

  it("POST /edges refuses every undeclared key and creates nothing, where the declared body creates the edge", async () => {
    const to = target();
    const refused = await send(caller, "/edges", {
      edge_type: "about",
      source_id: source,
      target_id: to,
      weight: 5,
      data: {},
    });
    const body = (await refused.json()) as ValidationRefusal;
    expect(refused.status, JSON.stringify(body)).toBe(400);
    expect(body.error.code).toBe("validation_error");
    expect(named(body.error.details)).toEqual(["data", "weight"]);
    expect(await aboutTargets()).not.toContain(to);

    // The witness: the same body without the undeclared keys is created,
    // so the absence above is the refusal and not the listing.
    const created = await send(caller, "/edges", {
      edge_type: "about",
      source_id: source,
      target_id: to,
    });
    expect(created.status, await created.clone().text()).toBe(201);
    expect(await aboutTargets()).toContain(to);
  });

  it("POST /edges/bulk refuses an undeclared top-level key and writes nothing", async () => {
    const to = target();
    const refused = await send(caller, "/edges/bulk", {
      atomc: false,
      edges: [{ edge_type: "about", source_id: source, target_id: to }],
    });
    const body = (await refused.json()) as ValidationRefusal;
    expect(refused.status, JSON.stringify(body)).toBe(400);
    expect(body.error.code).toBe("validation_error");
    expect(named(body.error.details)).toEqual(["atomc"]);
    expect(await aboutTargets()).not.toContain(to);
  });

  it("POST /edges/bulk under `atomic` rolls the page back on an entry's undeclared key", async () => {
    const first = target();
    const second = target();
    const refused = await send(caller, "/edges/bulk", {
      edges: [
        { edge_type: "about", source_id: source, target_id: first },
        {
          edge_type: "about",
          source_id: source,
          target_id: second,
          weight: 5,
        },
      ],
    });
    const body = (await refused.json()) as {
      error: {
        code: string;
        details: { index: number; code: string; details: unknown };
      };
    };
    expect(refused.status, JSON.stringify(body)).toBe(400);
    expect(body.error.code).toBe("bulk_atomic_rollback");
    expect(body.error.details.index).toBe(1);
    expect(body.error.details.code).toBe("validation_error");
    expect(named(body.error.details.details)).toEqual(["weight"]);
    const listed = await aboutTargets();
    expect(listed).not.toContain(first);
    expect(listed).not.toContain(second);
  });

  it("POST /edges/bulk without `atomic` errors the entry with an undeclared key and writes the others", async () => {
    const kept = target();
    const refusedEnd = target();
    const answered = await send(caller, "/edges/bulk", {
      atomic: false,
      edges: [
        { edge_type: "about", source_id: source, target_id: kept },
        {
          edge_type: "about",
          source_id: source,
          target_id: refusedEnd,
          weight: 5,
          data: {},
        },
      ],
    });
    const body = (await answered.json()) as {
      results: {
        outcome: string;
        error?: { code: string; details?: unknown };
      }[];
    };
    expect(answered.status, JSON.stringify(body)).toBe(200);
    expect(body.results[0]?.outcome).toBe("created");
    expect(body.results[1]?.outcome).toBe("errored");
    expect(body.results[1]?.error?.code).toBe("validation_error");
    expect(named(body.results[1]?.error?.details)).toEqual(["data", "weight"]);
    const listed = await aboutTargets();
    expect(listed).toContain(kept);
    expect(listed).not.toContain(refusedEnd);
  });
});

it("keys inside `properties` are the edge type's, not the door's", async () => {
  const res = await send("key", "/edges", {
    edge_type: "about",
    source_id: source,
    target_id: target(),
    properties: { weight: 5 },
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const { edge } = (await res.json()) as {
    edge: { properties: Record<string, unknown> };
  };
  expect(edge.properties.weight).toBe(5);
});

describe("the order POST /edges/bulk judges an undeclared key in", () => {
  const page = (second: string, third: string, undeclared: boolean) => [
    { edge_type: "about", source_id: "not-an-id", target_id: source },
    {
      edge_type: "about",
      source_id: source,
      target_id: second,
      ...(undeclared && { weight: 1 }),
    },
    { edge_type: "about", source_id: source, target_id: third },
  ];

  it("under `atomic`, answers a later entry's undeclared key before an earlier entry's malformed id", async () => {
    const second = target();
    const third = target();
    const refused = await send("key", "/edges/bulk", {
      edges: page(second, third, true),
    });
    const body = (await refused.json()) as {
      error: { code: string; details: { index: number; code: string } };
    };
    expect(refused.status, JSON.stringify(body)).toBe(400);
    expect(body.error.code).toBe("bulk_atomic_rollback");
    expect(body.error.details.index).toBe(1);
    expect(body.error.details.code).toBe("validation_error");

    // The witness: without the undeclared key, the earlier entry answers.
    const alone = await send("key", "/edges/bulk", {
      edges: page(second, third, false),
    });
    const witness = (await alone.json()) as {
      error: { details: { index: number; code: string } };
    };
    expect(alone.status).toBe(400);
    expect(witness.error.details).toMatchObject({
      index: 0,
      code: "invalid_id",
    });
    const listed = await aboutTargets();
    expect(listed).not.toContain(second);
    expect(listed).not.toContain(third);
  });

  it("without `atomic`, judges each entry alone", async () => {
    const second = target();
    const third = target();
    const answered = await send("key", "/edges/bulk", {
      atomic: false,
      edges: page(second, third, true),
    });
    const body = (await answered.json()) as {
      results: { outcome: string; error?: { code: string } }[];
    };
    expect(answered.status, JSON.stringify(body)).toBe(200);
    expect(body.results.map((r) => [r.outcome, r.error?.code])).toEqual([
      ["errored", "invalid_id"],
      ["errored", "validation_error"],
      ["created", undefined],
    ]);
    const listed = await aboutTargets();
    expect(listed).not.toContain(second);
    expect(listed).toContain(third);
  });
});
