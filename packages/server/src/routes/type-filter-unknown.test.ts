/**
 * A concrete `type` filter naming a type this server does not know is
 * refused on every list surface, and the case that looks like it is not.
 *
 * An empty page is the one answer a client cannot tell from a quiet instance:
 * a typo in a type name, a type registered under another handle, and a type
 * deleted since the client last hydrated all read as "no items here", and
 * the client carries on believing a filter it is not applying. So an
 * unknown concrete type is `400 unknown_type` on `GET /items`, `GET /search`
 * and `GET /export`. A wildcard over nothing is still an empty page, because
 * nothing is a correct answer to "everything under this root". A registered
 * type the credential cannot read is a different refusal, `403`, pinned for
 * every door in `type-filter-unreadable.test.ts`. A type removed by force is
 * unknown from then on, and the rows it kept are reached by id or under a
 * wildcard.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, mintWorkingKey, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;
let narrowKey: string;

beforeAll(async () => {
  ctx = await createTestContext();
  // A credential that reads tasks and nothing else, so `core.note` is a
  // registered type it cannot read. The narrow map is the whole subject, so
  // the key is an ordinary working one holding only that.
  const suffix = Math.random().toString(36).slice(2, 12);
  narrowKey = await mintWorkingKey(ctx, {
    label: `narrow-${suffix}`,
    source: `narrow-${suffix}`,
    type_permissions: { "core.task": "read" },
    edge_permissions: {},
    metadata_permissions: {},
    extension_permissions: {},
    profile_permissions: {},
    permissions: [],
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

async function errorCode(res: Response): Promise<string | undefined> {
  const body = (await res.json()) as { error?: { code?: string } };
  return body.error?.code;
}

const SURFACES: { name: string; path: (type: string) => string }[] = [
  { name: "GET /items", path: (t) => `/items?type=${t}` },
  { name: "GET /search", path: (t) => `/search?q=anything&type=${t}` },
  { name: "GET /export", path: (t) => `/export?type=${t}` },
];

describe("an unknown concrete type is refused on every list surface", () => {
  for (const surface of SURFACES) {
    it(`${surface.name} answers 400 unknown_type`, async () => {
      const res = await request(
        ctx.app,
        "GET",
        surface.path("core.nonexistent_filter_type"),
        { key: ctx.workingKey },
      );
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("unknown_type");
      expect(res.headers.get("x-error-code")).toBe("unknown_type");
    });
  }

  it("the grammar refusal comes first and keeps its own code", async () => {
    const res = await request(ctx.app, "GET", "/items?type=not%20a%20type", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("validation_error");
  });
});

describe("the case that looks like an unknown type is not refused", () => {
  it("a wildcard over a root nothing is registered under answers an empty page", async () => {
    const res = await request(ctx.app, "GET", "/items?type=acme.*", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: unknown[];
      next_cursor: string | null;
    };
    expect(body.data).toEqual([]);
    expect(body.next_cursor).toBeNull();
  });

  it("a type removed by force is unknown from then on, and its kept rows are reached under a wildcard", async () => {
    const type = "acme.forced_away";
    const registered = await request(ctx.app, "POST", "/types", {
      key: ctx.workingKey,
      body: { id: type, version: 1, fields: { name: { type: "string" } } },
    });
    expect(registered.status).toBe(201);
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type, properties: { name: "kept" } },
    });
    expect(created.status).toBe(201);
    const { item } = (await created.json()) as { item: { id: string } };
    const itemId = item.id;
    const removed = await request(
      ctx.app,
      "DELETE",
      `/types/${type}?force=true`,
      { key: ctx.workingKey },
    );
    expect(removed.status).toBe(200);

    // The kept row is behind the refusal by type until the type is
    // registered again, and still listed under its root and read by id.
    const byType = await request(ctx.app, "GET", `/items?type=${type}`, {
      key: ctx.workingKey,
    });
    expect(byType.status).toBe(400);
    expect(await errorCode(byType)).toBe("unknown_type");
    const byRoot = await request(ctx.app, "GET", "/items?type=acme.*", {
      key: ctx.workingKey,
    });
    expect(byRoot.status).toBe(200);
    const listed = (await byRoot.json()) as { data: { id: string }[] };
    expect(listed.data.map((i) => i.id)).toContain(itemId);
    const byId = await request(ctx.app, "GET", `/items/${itemId}`, {
      key: ctx.workingKey,
    });
    expect(byId.status).toBe(200);
  });

  it("the same credential is still refused for a type nobody registered", async () => {
    // Refusing an unknown type reveals nothing about the grant: the
    // registry is the same for every caller.
    const res = await request(
      ctx.app,
      "GET",
      "/items?type=core.nonexistent_filter_type",
      { key: narrowKey },
    );
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("unknown_type");
  });
});
