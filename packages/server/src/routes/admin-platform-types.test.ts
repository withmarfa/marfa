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
import { hashApiKey } from "../middleware/auth.js";
import { TEST_API_KEY_SALT } from "../test-utils.js";

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

/**
 * A `role: "instance_admin"` credential bound to one space.
 *
 * The distinction this exists to test: it authenticates, so a request
 * carrying it never reaches the 401 an unauthenticated one gets. Only the
 * platform-authority half of `requireAdmin` refuses it, and a test that
 * sends no credential at all cannot tell the two apart: it would pass
 * against `requireSpaceAdmin` just as happily.
 */
async function mintSpaceBoundAdmin(ctx: TestContext): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 12);
  const raw = `marfa_k1_platform_types_${suffix}`;
  await ctx.storage.keys.create(
    {
      label: `space-admin-${suffix}`,
      source: `space-admin-${suffix}`,
      role: "instance_admin",
      default_tier: "library",
      type_permissions: {},
      is_platform: false,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    (await ctx.storage.spaces!.create("bound")).id,
  );
  return raw;
}

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
  it("refuses an unauthenticated caller", async () => {
    const ctx = await newContext();
    const res = await request(ctx.app, "GET", "/admin/platform-types/drift");
    expect(res.status).toBe(401);
  });

  it("refuses an admin bound to a space", async () => {
    const ctx = await newContext();
    const res = await request(ctx.app, "GET", "/admin/platform-types/drift", {
      key: await mintSpaceBoundAdmin(ctx),
    });
    expect(res.status).toBe(403);
  });

  it("lists the drifted rows with their live item counts", async () => {
    const ctx = await newContext();
    const id = await seedDriftedType(ctx);

    const res = await request(ctx.app, "GET", "/admin/platform-types/drift", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      types: {
        id: string;
        item_count: number;
        child_types: string[];
        removable: boolean;
      }[];
    };
    expect(body.types).toEqual([
      { id, item_count: 0, child_types: [], removable: true },
    ]);
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
  it("refuses an unauthenticated caller", async () => {
    const ctx = await newContext();
    const res = await request(
      ctx.app,
      "POST",
      "/admin/platform-types/core.anything/remove",
    );
    expect(res.status).toBe(401);
  });

  it("refuses an admin bound to a space", async () => {
    const ctx = await newContext();
    const res = await request(
      ctx.app,
      "POST",
      "/admin/platform-types/core.anything/remove",
      { key: await mintSpaceBoundAdmin(ctx) },
    );
    expect(res.status).toBe(403);
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

  it("declines while another type inherits from it", async () => {
    // The guard the item count cannot stand in for. An abstract parent
    // carries no items of its own, so it is the type most certain to
    // report zero and the one whose removal costs the most: every child
    // would resolve without the fields it inherits, silently, because
    // ancestor collection degrades to a partial view rather than failing.
    const ctx = await newContext();
    const parent = await seedDriftedType(ctx);
    const child = `${parent}.child`;
    await ctx.storage.types.create(
      {
        id: child,
        parent,
        version: 1,
        fields: { extra: { type: "string" } },
      },
      undefined,
      { origin: "platform", family: "core" },
    );

    const res = await request(
      ctx.app,
      "POST",
      `/admin/platform-types/${parent}/remove`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(409);

    const rows = await ctx.storage.types.loadCustomTypes();
    expect(rows.map((r) => r.schema.id)).toContain(parent);
  });

  it("reports a parent as not removable in the listing", async () => {
    const ctx = await newContext();
    const parent = await seedDriftedType(ctx);
    const child = `${parent}.child`;
    await ctx.storage.types.create(
      {
        id: child,
        parent,
        version: 1,
        fields: { extra: { type: "string" } },
      },
      undefined,
      { origin: "platform", family: "core" },
    );

    const res = await request(ctx.app, "GET", "/admin/platform-types/drift", {
      key: ctx.adminKey,
    });
    const body = (await res.json()) as {
      types: { id: string; child_types: string[]; removable: boolean }[];
    };
    const row = body.types.find((t) => t.id === parent);
    expect(row?.child_types).toEqual([child]);
    expect(row?.removable).toBe(false);
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

describe("/health reports drift and does not degrade on it", () => {
  it("reports the count while the overall status stays ok", async () => {
    const ctx = await newContext();
    setPlatformDrift(["core.retired_health", "core.retired_second"]);

    const res = await request(ctx.app, "GET", "/health");
    const body = (await res.json()) as {
      status: string;
      components: Record<string, { status: string; count?: number }>;
      platform_types: { drifted: number };
    };

    // Asserted before the status claim, so a fixture that stopped
    // producing drift fails here rather than passing vacuously: an `ok`
    // status on an instance carrying no drift proves nothing.
    expect(body.platform_types).toEqual({ drifted: 2 });

    expect(body.status).toBe("ok");
    // Not a component. A status is the thing this removed, so the entry
    // has to be absent rather than reporting a constant `ok` that a
    // consumer could still key on.
    expect(body.components.platform_types).toBeUndefined();
    // The identifiers are not here: this endpoint is unauthenticated.
    expect(JSON.stringify(body)).not.toContain("core.retired_health");
    expect(JSON.stringify(body)).not.toContain("core.retired_second");
  });

  it("reports zero when there is no drift", async () => {
    const ctx = await newContext();
    setPlatformDrift([]);
    const res = await request(ctx.app, "GET", "/health");
    const body = (await res.json()) as {
      status: string;
      components: Record<string, { status: string; count?: number }>;
      platform_types: { drifted: number };
    };
    expect(body.platform_types).toEqual({ drifted: 0 });
    expect(body.components.platform_types).toBeUndefined();
    expect(body.status).toBe("ok");
  });
});
