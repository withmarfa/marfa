/**
 * The natural-key upsert is validated like every other write, on the merged
 * result: a re-sync sending a null title keeps the null on a field the type
 * declares required, and without the check it would leave an item that could
 * not have been created in the state it sits in, with nothing said.
 *
 * These drive the upsert specifically, a create resolved onto an existing row
 * by its natural key, which the validation tests over `POST /items` and
 * `PATCH /items/:id` do not reach.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestContext } from "../test-utils.js";
import { createTestContext, mintWorkingKey, request } from "../test-utils.js";

let ctx: TestContext;

const ITEM_SOURCE = "upsert-validation";
let RUNTIME_KEY = "marfa_k1_test_upsert_validation";

beforeAll(async () => {
  ctx = await createTestContext();
  RUNTIME_KEY = await mintWorkingKey(ctx, {
    permissions: [],
    extension_permissions: {},
    edge_permissions: {},
    metadata_permissions: {},
    profile_permissions: {},
    label: "upsert-validation",
    source: ITEM_SOURCE,
    type_permissions: { "*": "write" },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

/** First sync of an upstream record, through the door the connector uses. */
async function seed(
  sourceId: string,
  properties: Record<string, unknown>,
): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: RUNTIME_KEY,
    body: { type: "core.event", properties, source_id: sourceId },
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

/** A later sync of the same upstream record, resolved by natural key. */
async function resync(
  sourceId: string,
  properties: Record<string, unknown>,
): Promise<Response> {
  return request(ctx.app, "POST", "/items", {
    key: RUNTIME_KEY,
    body: { type: "core.event", properties, source_id: sourceId },
  });
}

describe("a re-sync that would clear a required field", () => {
  it("is refused, and says which field", async () => {
    const id = await seed("upstream-required", {
      title: "Standup",
      place: "Room 2",
    });

    const res = await resync("upstream-required", { title: null });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string; details?: unknown };
    };
    expect(body.error.code).toBe("invalid_properties");
    expect(JSON.stringify(body.error)).toContain("title");

    // And nothing was written: the item still has the title it had.
    const read = await request(ctx.app, "GET", `/items/${id}`, {
      key: ctx.workingKey,
    });
    const item = (await read.json()) as {
      item: { properties: { title?: unknown } };
    };
    expect(item.item.properties.title).toBe("Standup");
  });

  it("is refused when the merge, not the body, is what leaves it missing", async () => {
    // The body alone looks harmless. Only the merged result shows the
    // null sitting on the required field, which is why this has to be
    // judged on the value the row ends up with.
    const id = await seed("upstream-merge", {
      title: "Retro",
      place: "Room 3",
    });
    const res = await resync("upstream-merge", {
      place: "Room 4",
      title: null,
    });
    expect(res.status).toBe(400);

    const read = await request(ctx.app, "GET", `/items/${id}`, {
      key: ctx.workingKey,
    });
    const item = (await read.json()) as {
      item: { properties: { title?: unknown; place?: unknown } };
    };
    expect(item.item.properties.title).toBe("Retro");
    expect(item.item.properties.place).toBe("Room 3");
  });
});

describe("a re-sync carrying a value of the wrong shape", () => {
  it("is refused rather than stored unvalidated", async () => {
    await seed("upstream-shape", { title: "Offsite" });
    const res = await resync("upstream-shape", { starts_at: 12345 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_properties");
  });
});

describe("an ordinary re-sync", () => {
  it("still updates values the way it always did", async () => {
    const id = await seed("upstream-plain", { title: "Before" });
    const res = await resync("upstream-plain", { title: "After" });
    expect(res.status).toBe(200);
    const read = await request(ctx.app, "GET", `/items/${id}`, {
      key: ctx.workingKey,
    });
    const item = (await read.json()) as {
      item: { properties: { title?: unknown } };
    };
    expect(item.item.properties.title).toBe("After");
  });
});

/**
 * The type in the body plays no part in resolving the row — the natural key
 * does that on `POST /items`, and the id does it on `PATCH`. So the claim
 * used to be dropped, and a caller that declared one type while landing on
 * another was reinterpreted rather than refused.
 *
 * The rule is agreement, not absence, and the difference is not cosmetic.
 * Refusing any `type` on `PATCH` was the tidier rule to describe and would
 * have broken most of the fleet on its first request: the handlers build one
 * input object and hand it to either `createItem` or `updateItem`, so a type
 * rides along on nearly every reactive update and matches the row every
 * time. Only a disagreement means anything.
 */
describe("the type a write declares", () => {
  it("is accepted on PATCH when it is the item's own", async () => {
    // The shape the fleet actually sends: one `{ type, properties }` object
    // built for create and reused for update.
    const id = await seed("claim-agrees", { title: "Standup" });
    const res = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: RUNTIME_KEY,
      body: {
        type: "core.event",
        properties: { title: "Standup, moved" },
        version: 1,
      },
    });
    expect(res.status, await res.clone().text()).toBe(200);

    const read = await request(ctx.app, "GET", `/items/${id}`, {
      key: ctx.workingKey,
    });
    const item = (await read.json()) as {
      item: { type: string; properties: { title?: unknown } };
    };
    expect(item.item.type).toBe("core.event");
    expect(item.item.properties.title).toBe("Standup, moved");
  });

  it("is refused on PATCH when it is not", async () => {
    const id = await seed("claim-disagrees-patch", { title: "Standup" });
    const res = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: RUNTIME_KEY,
      body: {
        type: "core.note",
        properties: { title: "Re-typed" },
        version: 1,
      },
    });
    expect(res.status).toBe(409);
    const err = (await res.json()) as { error: { code: string } };
    expect(err.error.code).toBe("type_mismatch");

    const read = await request(ctx.app, "GET", `/items/${id}`, {
      key: ctx.workingKey,
    });
    const item = (await read.json()) as {
      item: { type: string; properties: { title?: unknown } };
    };
    expect(item.item.type).toBe("core.event");
    // The refusal has to land before the write, not after it.
    expect(item.item.properties.title).toBe("Standup");
  });

  it("is refused on PATCH when it is not even a string", async () => {
    // `type` is absent from the schema, so nothing upstream has checked
    // its shape by the time the claim is read out of the raw body.
    const id = await seed("claim-nonsense", { title: "Standup" });
    const res = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: RUNTIME_KEY,
      body: {
        type: { nested: true },
        properties: { title: "Re-typed" },
        version: 1,
      },
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: { code: string } };
    expect(err.error.code).toBe("validation_error");
  });

  it("is refused on a natural-key re-sync when it is not the row's", async () => {
    const id = await seed("claim-disagrees-upsert", { title: "Standup" });
    const res = await request(ctx.app, "POST", "/items", {
      key: RUNTIME_KEY,
      body: {
        type: "core.note",
        properties: { title: "Re-typed" },
        source_id: "claim-disagrees-upsert",
      },
    });
    expect(res.status).toBe(409);
    const err = (await res.json()) as { error: { code: string } };
    expect(err.error.code).toBe("type_mismatch");

    const read = await request(ctx.app, "GET", `/items/${id}`, {
      key: ctx.workingKey,
    });
    const item = (await read.json()) as {
      item: { type: string; properties: { title?: unknown } };
    };
    expect(item.item.type).toBe("core.event");
    expect(item.item.properties.title).toBe("Standup");
  });
});
