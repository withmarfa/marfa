import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import { generateId } from "@withmarfa/shared";
import type { Metadata } from "@withmarfa/shared";

/** Hydrated item shape on the wire: base Item plus optional include extras. */
interface HydratedItem {
  id: string;
  type: string;
  edges?: Record<string, { edges: { target_id: string }[] }>;
  extensions?: Record<string, Record<string, unknown>>;
}

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

interface BulkGetResponse {
  items: HydratedItem[];
  metadata?: Metadata[];
}

/** Create N notes via the API and return their ids. */
async function createNotes(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: `bulk-get note ${String(i)}` },
      },
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { item: { id: string } };
    ids.push(data.item.id);
  }
  return ids;
}

describe("POST /items/bulk-get", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const res = await request(ctx.app, "POST", "/items/bulk-get", {
      body: { ids: ["itm_does_not_matter"] },
    });
    expect(res.status).toBe(401);
  });

  it("returns the requested items in one response", async () => {
    const ids = await createNotes(3);
    const res = await request(ctx.app, "POST", "/items/bulk-get", {
      key: ctx.adminKey,
      body: { ids },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as BulkGetResponse;
    expect(data.items).toHaveLength(3);
    expect(new Set(data.items.map((i) => i.id))).toEqual(new Set(ids));
    expect(data.metadata).toBeUndefined();
  });

  it("omits a missing / nonexistent id rather than 404ing the request", async () => {
    const ids = await createNotes(2);
    const res = await request(ctx.app, "POST", "/items/bulk-get", {
      key: ctx.adminKey,
      body: { ids: [...ids, generateId()] },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as BulkGetResponse;
    expect(data.items).toHaveLength(2);
    expect(new Set(data.items.map((i) => i.id))).toEqual(new Set(ids));
  });

  it("hydrates metadata, edges, and extensions when requested via include", async () => {
    // Host + target so there's an edge to hydrate.
    const targetRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "edge target" } },
    });
    const targetId = ((await targetRes.json()) as { item: { id: string } }).item
      .id;

    const hostRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "edge host" },
        tags: ["alpha", "beta"],
        edges: { references: [targetId] },
      },
    });
    const hostId = ((await hostRes.json()) as { item: { id: string } }).item.id;

    // Set an extension namespace so the extensions include has something.
    const extRes = await request(
      ctx.app,
      "PUT",
      `/items/${hostId}/extensions/custom.ns`,
      {
        key: ctx.adminKey,
        body: { data: { flag: true } },
      },
    );
    expect([200, 201]).toContain(extRes.status);

    const res = await request(ctx.app, "POST", "/items/bulk-get", {
      key: ctx.adminKey,
      body: {
        ids: [hostId],
        include: ["edges", "metadata", "extensions"],
      },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as BulkGetResponse;
    expect(data.items).toHaveLength(1);

    const host = data.items[0];
    expect(host?.edges?.references?.edges).toHaveLength(1);
    expect(host?.edges?.references?.edges[0]?.target_id).toBe(targetId);
    expect(host?.extensions?.["custom.ns"]).toEqual({ data: { flag: true } });

    expect(data.metadata).toBeDefined();
    const meta = data.metadata?.find((m) => m.item_id === hostId);
    expect(meta?.tags.sort()).toEqual(["alpha", "beta"]);
  });

  it("rejects an over-cap request with a 400", async () => {
    const ids = Array.from({ length: 101 }, () => generateId());
    const res = await request(ctx.app, "POST", "/items/bulk-get", {
      key: ctx.adminKey,
      body: { ids },
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: { code: string } };
    expect(data.error.code).toBe("validation_error");
  });

  // The critical security test: ids belonging to another space must never
  // surface, even to a space_admin requesting them by exact id. `getMany`
  // filters by space_id, so the cross-space rows are simply absent.
  it("never returns items from another space (cross-space isolation)", async () => {
    if (!ctx.storage.spaces) return;

    const spaceA = await ctx.storage.spaces.create("bulk-get-space-a");
    const spaceB = await ctx.storage.spaces.create("bulk-get-space-b");

    // An item owned by space B.
    const bItem = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "space B secret" } },
      spaceB.id,
    );
    // An item owned by space A.
    const aItem = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "space A note" } },
      spaceA.id,
    );

    // A key bound to space A. The type map is named rather than left empty,
    // because it is the whole of what this key can read and the case is about
    // the space fence rather than the types: an unnamed map withholds both
    // ids and the assertion passes for the wrong reason. No space permission
    // is named because `bulk-get` asks for none.
    const suffix = Math.random().toString(36).slice(2, 8);
    const rawKey = `marfa_k1_bulkget_a_${suffix}`;
    await ctx.storage.keys.create(
      {
        label: `bulkget-a-${suffix}`,
        source: `bulkget-a-${suffix}`,
        type_permissions: { "*": "read" },
        default_tier: "library",
        is_operator: false,
      },
      hashApiKey(rawKey, TEST_API_KEY_SALT),
      spaceA.id,
    );

    const res = await request(ctx.app, "POST", "/items/bulk-get", {
      key: rawKey,
      // Ask for BOTH ids — only space A's may come back.
      body: { ids: [aItem.id, bItem.id] },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as BulkGetResponse;
    expect(data.items.map((i) => i.id)).toEqual([aItem.id]);
    expect(data.items.some((i) => i.id === bItem.id)).toBe(false);
  });

  it("omits items whose type the caller cannot read (implicit denial)", async () => {
    // A key that can read core.note but not core.bookmark. It carries no
    // space, so the schema requires the operator flag; the type map is still
    // the whole of what it can read.
    const suffix = Math.random().toString(36).slice(2, 8);
    const rawKey = `marfa_k1_bulkget_narrow_${suffix}`;
    await ctx.storage.keys.create(
      {
        label: `bulkget-narrow-${suffix}`,
        source: `bulkget-narrow-${suffix}`,
        type_permissions: { "core.note": "read" },
        default_tier: "library",
        is_operator: true,
      },
      hashApiKey(rawKey, TEST_API_KEY_SALT),
    );

    const noteRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "readable" } },
    });
    const noteId = ((await noteRes.json()) as { item: { id: string } }).item.id;

    const bookmarkRes = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.bookmark",
        properties: { url: "https://example.com" },
      },
    });
    const bookmarkId = ((await bookmarkRes.json()) as { item: { id: string } })
      .item.id;

    const res = await request(ctx.app, "POST", "/items/bulk-get", {
      key: rawKey,
      body: { ids: [noteId, bookmarkId] },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as BulkGetResponse;
    expect(data.items.map((i) => i.id)).toEqual([noteId]);
  });
});

/**
 * The `system` token on the third surface that reads it.
 *
 * `bulk-get` filters in JavaScript — `if (!includeSystem &&
 * item.type.startsWith("system.")) continue;` — rather than through the SQL
 * exclusion the two listing routes compile. So the mutation controls on those
 * routes do not reach it: delete that line and every other test in the
 * repository still passes, while this door starts handing `system.*` rows to
 * every caller regardless of the token.
 *
 * It is also the door where a caller most confidently believes it asked for
 * the row, because it named the id. A dropped system row leaves the array
 * short with no signal, exactly like an id the caller may not read.
 */
describe("POST /items/bulk-get and the system token", () => {
  async function seedPair(
    marker: string,
  ): Promise<{ noteId: string; deviceId: string }> {
    const note = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: `bulk-sys-${marker}` } },
    });
    const device = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "system.device",
        properties: { name: `bulk-sys-${marker}`, kind: "laptop" },
      },
    });
    expect(note.status).toBe(201);
    expect(device.status).toBe(201);
    const { item: n } = (await note.json()) as { item: { id: string } };
    const { item: d } = (await device.json()) as { item: { id: string } };
    return { noteId: n.id, deviceId: d.id };
  }

  async function fetched(ids: string[], include?: string[]): Promise<string[]> {
    const res = await request(ctx.app, "POST", "/items/bulk-get", {
      key: ctx.adminKey,
      body: { ids, ...(include === undefined ? {} : { include }) },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as BulkGetResponse;
    return data.items.map((i) => i.id);
  }

  it("drops a system id the caller named, when the token is absent", async () => {
    const { noteId, deviceId } = await seedPair("absent");
    const got = await fetched([noteId, deviceId]);
    // The ordinary id as well, so this cannot pass against an empty response.
    expect(got).toContain(noteId);
    expect(got).not.toContain(deviceId);
  });

  it("returns it when the token is present", async () => {
    const { noteId, deviceId } = await seedPair("present");
    const got = await fetched([noteId, deviceId], ["system"]);
    expect(got).toContain(noteId);
    expect(got).toContain(deviceId);
  });

  it("refuses a token it does not declare", async () => {
    // Unlike the listing routes, this door's `include` is a closed enum, so a
    // misspelling is a 400 here and silently ignored there.
    const res = await request(ctx.app, "POST", "/items/bulk-get", {
      key: ctx.adminKey,
      body: { ids: [], include: ["sytem"] },
    });
    expect(res.status).toBe(400);
  });
});
