/**
 * Every door that creates an edge refuses a body key it does not declare,
 * for a key and for an app the owner signed in alike, and creates nothing.
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
  for (let i = 0; i < 13; i += 1) targets.push(await note());
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
    details?: { errors?: { path: string; message: string }[] };
  };
}

function messages(details: unknown): string {
  return (
    (details as { errors?: { message: string }[] } | undefined)?.errors ?? []
  )
    .map((e) => e.message)
    .join(" ");
}

describe.each<Caller>(["key", "app"])("as the %s", (caller) => {
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
    expect(messages(body.error.details)).toContain('"weight"');
    expect(messages(body.error.details)).toContain('"data"');
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
    expect(messages(body.error.details)).toContain('"atomc"');
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
    expect(messages(body.error.details.details)).toContain('"weight"');
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
    expect(messages(body.results[1]?.error?.details)).toContain('"weight"');
    expect(messages(body.results[1]?.error?.details)).toContain('"data"');
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
