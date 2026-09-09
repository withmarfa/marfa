/**
 * The natural-key upsert is the one write path that skipped validation, and
 * it is also the one where an explicit null clears a value rather than
 * setting it. So an integration re-sync sending a null title removed a field
 * the type declares required, leaving an item that could not have been
 * created in the state it now sat in, and nothing said so.
 *
 * These drive the integration path specifically: the null-clearing branch is
 * reachable only for a runtime credential re-syncing its own connection's
 * rows, so the existing validation tests over `POST /items` and
 * `PATCH /items/:id` never touch it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import { runtimeCredentialItemSource } from "../connections/lifecycle-lock.js";

let ctx: TestContext;

const CONNECTION_ID = "conn_upsert_validation";
const ITEM_SOURCE = runtimeCredentialItemSource({ name: CONNECTION_ID });
const RUNTIME_KEY = "marfa_k1_test_upsert_validation";

beforeAll(async () => {
  ctx = await createTestContext();
  await ctx.storage.keys.createRuntimeCredential(
    {
      label: "upsert-validation",
      source: "upsert-validation",
      type_permissions: { "*": "write" },
      connection_id: CONNECTION_ID,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      item_source: ITEM_SOURCE,
    },
    hashApiKey(RUNTIME_KEY, TEST_API_KEY_SALT),
    ctx.spaceId,
  );
});

afterAll(async () => {
  await ctx.cleanup();
});

/** First sync of an upstream record, through the door the integration uses. */
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
      key: ctx.adminKey,
    });
    const item = (await read.json()) as {
      item: { properties: { title?: unknown } };
    };
    expect(item.item.properties.title).toBe("Standup");
  });

  it("is refused when the merge, not the body, is what leaves it missing", async () => {
    // The body alone looks harmless — it names no required field at all.
    // Only the merged result shows the clear, which is why this has to be
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
      key: ctx.adminKey,
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
  it("still clears an optional field the upstream dropped", async () => {
    // The null-clearing contract is why this path exists: an upstream that
    // removed a value has to be able to say so. Only a required field is
    // out of bounds.
    const id = await seed("upstream-optional", {
      title: "Lunch",
      place: "Canteen",
    });
    const res = await resync("upstream-optional", { place: null });
    expect(res.status, await res.clone().text()).toBe(200);

    const read = await request(ctx.app, "GET", `/items/${id}`, {
      key: ctx.adminKey,
    });
    const item = (await read.json()) as {
      item: { properties: Record<string, unknown> };
    };
    expect(item.item.properties.place).toBeUndefined();
    expect(item.item.properties.title).toBe("Lunch");
  });

  it("still updates values the way it always did", async () => {
    const id = await seed("upstream-plain", { title: "Before" });
    const res = await resync("upstream-plain", { title: "After" });
    expect(res.status).toBe(200);
    const read = await request(ctx.app, "GET", `/items/${id}`, {
      key: ctx.adminKey,
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
      body: { type: "core.event", properties: { title: "Standup, moved" } },
    });
    expect(res.status, await res.clone().text()).toBe(200);

    const read = await request(ctx.app, "GET", `/items/${id}`, {
      key: ctx.adminKey,
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
      body: { type: "core.note", properties: { title: "Re-typed" } },
    });
    expect(res.status).toBe(409);
    const err = (await res.json()) as { error: { code: string } };
    expect(err.error.code).toBe("type_mismatch");

    const read = await request(ctx.app, "GET", `/items/${id}`, {
      key: ctx.adminKey,
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
      body: { type: { nested: true }, properties: { title: "Re-typed" } },
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
      key: ctx.adminKey,
    });
    const item = (await read.json()) as {
      item: { type: string; properties: { title?: unknown } };
    };
    expect(item.item.type).toBe("core.event");
    expect(item.item.properties.title).toBe("Standup");
  });
});
