/**
 * The operator surface for shipped types the build no longer carries.
 *
 * Drift is derived at boot, so these tests set it directly rather than
 * booting an instance against a doctored database. What that leaves
 * uncovered is one line at each dialect's warmup; the derivation itself is
 * tested against real storage in `storage/platform-drift.test.ts`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { setPlatformDrift } from "../storage/platform-drift.js";
import type { TypeSchema } from "@withmarfa/shared";

const contexts: TestContext[] = [];

async function newContext(): Promise<TestContext> {
  const ctx = await createTestContext();
  contexts.push(ctx);
  return ctx;
}

afterEach(async () => {
  // Module state, so a test that leaves drift set would decide the next
  // one's answer.
  setPlatformDrift([]);
  while (contexts.length > 0) {
    const ctx = contexts.pop();
    if (ctx) await ctx.cleanup();
  }
});

/** Registers a platform row the build does not ship, and reports it drifted. */
async function seedDriftedType(ctx: TestContext): Promise<string> {
  const id = `core.retired_${Math.random().toString(36).slice(2, 8)}`;
  await ctx.storage.types.create(
    {
      id,
      version: 1,
      fields: { name: { type: "string", required: true } },
    },
    undefined,
    { origin: "platform", family: "core" },
  );
  setPlatformDrift([id]);
  return id;
}

describe("GET /admin/platform-types/drift", () => {
  it("refuses a caller who is not a platform admin", async () => {
    const ctx = await newContext();
    const res = await request(ctx.app, "GET", "/admin/platform-types/drift");
    expect(res.status).toBe(401);
  });

  it("lists the drifted rows with their live item counts", async () => {
    const ctx = await newContext();
    const id = await seedDriftedType(ctx);

    const res = await request(ctx.app, "GET", "/admin/platform-types/drift", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      types: { id: string; item_count: number; removable: boolean }[];
    };
    expect(body.types).toEqual([{ id, item_count: 0, removable: true }]);
  });

  it("reports a row as not removable while items carry it", async () => {
    const ctx = await newContext();
    const id = await seedDriftedType(ctx);
    await ctx.storage.items.create({
      type: id,
      properties: { name: "still here" },
      source: "test",
      source_id: "drift-1",
    });

    const res = await request(ctx.app, "GET", "/admin/platform-types/drift", {
      key: ctx.adminKey,
    });
    const body = (await res.json()) as {
      types: { item_count: number; removable: boolean }[];
    };
    expect(body.types[0]?.item_count).toBe(1);
    expect(body.types[0]?.removable).toBe(false);
  });
});

describe("POST /admin/platform-types/{id}/remove", () => {
  it("refuses a caller who is not a platform admin", async () => {
    const ctx = await newContext();
    const res = await request(
      ctx.app,
      "POST",
      "/admin/platform-types/core.anything/remove",
    );
    expect(res.status).toBe(401);
  });

  it("removes a drifted row", async () => {
    const ctx = await newContext();
    const id = await seedDriftedType(ctx);

    const res = await request(
      ctx.app,
      "POST",
      `/admin/platform-types/${id}/remove`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);

    // Gone from the table, which is what makes it stop resolving at the
    // next boot.
    const rows = await ctx.storage.types.loadCustomTypes();
    expect(rows.map((r) => r.schema.id)).not.toContain(id);
  });

  it("refuses a type the build still ships", async () => {
    // The guard that matters most: a row exists for every shipped type
    // too, so testing existence alone would make this able to remove a
    // live one.
    const ctx = await newContext();
    setPlatformDrift([]);

    const res = await request(
      ctx.app,
      "POST",
      "/admin/platform-types/core.note/remove",
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("conflict");

    // And it is still there.
    const rows = await ctx.storage.types.loadCustomTypes();
    expect(rows.map((r) => r.schema.id)).toContain("core.note");
  });

  it("cannot reach a space's row of the same identifier", async () => {
    // The primary key is (space_id, id) and the seed writes an empty
    // space, so scoping the delete on origin alone would let this remove a
    // space's own registration that happens to share a name.
    const ctx = await newContext();
    const id = `acme.shared_${Math.random().toString(36).slice(2, 8)}`;
    const space = (await ctx.storage.spaces!.create("drift-scope")).id;
    const schema: TypeSchema = {
      id,
      version: 1,
      fields: { name: { type: "string", required: true } },
    };
    await ctx.storage.types.create(schema, undefined, {
      origin: "platform",
      family: "core",
    });
    await ctx.storage.types.create(schema, space, { origin: "user" });
    setPlatformDrift([id]);

    const res = await request(
      ctx.app,
      "POST",
      `/admin/platform-types/${id}/remove`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);

    const rows = await ctx.storage.types.loadCustomTypes();
    const survivors = rows.filter((r) => r.schema.id === id);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.space_id).toBe(space);
    expect(survivors[0]?.origin).toBe("user");
  });

  it("cannot reach a platform-origin row inside a space", async () => {
    // The origin clause alone happens to be sufficient today, because
    // nothing but the seed writes `origin = "platform"` and the seed
    // writes an empty space. That is an accident of the current writers
    // rather than a property, so the space clause is what makes the scope
    // hold if a future writer appears. Without a case like this the clause
    // can be deleted with every other test still green.
    const ctx = await newContext();
    const id = `acme.platformish_${Math.random().toString(36).slice(2, 8)}`;
    const space = (await ctx.storage.spaces!.create("drift-origin")).id;
    const schema: TypeSchema = {
      id,
      version: 1,
      fields: { name: { type: "string", required: true } },
    };
    await ctx.storage.types.create(schema, undefined, {
      origin: "platform",
      family: "core",
    });
    await ctx.storage.types.create(schema, space, {
      origin: "platform",
      family: "core",
    });
    setPlatformDrift([id]);

    const res = await request(
      ctx.app,
      "POST",
      `/admin/platform-types/${id}/remove`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);

    const survivors = (await ctx.storage.types.loadCustomTypes()).filter(
      (r) => r.schema.id === id,
    );
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.space_id).toBe(space);
  });

  it("declines while items still carry the identifier", async () => {
    // Orphaning readable data to tidy a registry is the wrong trade: the
    // row is what makes those items resolve.
    const ctx = await newContext();
    const id = await seedDriftedType(ctx);
    await ctx.storage.items.create({
      type: id,
      properties: { name: "still here" },
      source: "test",
      source_id: "drift-2",
    });

    const res = await request(
      ctx.app,
      "POST",
      `/admin/platform-types/${id}/remove`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(409);

    const rows = await ctx.storage.types.loadCustomTypes();
    expect(rows.map((r) => r.schema.id)).toContain(id);
  });
});

describe("/health reports the count", () => {
  it("degrades while an instance carries a type the build does not", async () => {
    const ctx = await newContext();
    setPlatformDrift(["core.retired_health"]);

    const res = await request(ctx.app, "GET", "/health");
    const body = (await res.json()) as {
      status: string;
      components: Record<string, { status: string; count?: number }>;
    };
    expect(body.components.platform_types).toEqual({
      status: "degraded",
      count: 1,
    });
    expect(body.status).toBe("degraded");
    // The identifiers are not here: this endpoint is unauthenticated.
    expect(JSON.stringify(body)).not.toContain("core.retired_health");
  });

  it("is ok and silent about identifiers when there is no drift", async () => {
    const ctx = await newContext();
    setPlatformDrift([]);
    const res = await request(ctx.app, "GET", "/health");
    const body = (await res.json()) as {
      components: Record<string, { status: string; count?: number }>;
    };
    expect(body.components.platform_types).toEqual({ status: "ok", count: 0 });
  });
});
