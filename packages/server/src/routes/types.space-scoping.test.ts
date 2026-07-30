/**
 * Custom item-type space scoping.
 *
 * Custom item types are stored per space in `custom_types`, but the in-memory
 * type registry that the create-time gate consults must resolve a space's own
 * custom types plus the global core/system set — never another space's. This
 * proves the isolation end to end: space A registers a custom item type;
 * space B cannot see it and cannot create items of it (`unknown_type`), while
 * space A can. Two spaces registering the same id independently, and core
 * types resolving for everyone, round out the coverage.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
  type TestContext,
} from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

let ctx: TestContext;

const spaceA = `space-a-${Math.random().toString(36).slice(2, 10)}`;
const spaceB = `space-b-${Math.random().toString(36).slice(2, 10)}`;
let adminA: string;
let adminB: string;

// Unique id per run — the type registry is module-level in @withmarfa/shared
// and would otherwise leak across test files sharing a worker. Both spaces
// register under the SAME id to prove per-space namespacing: the composite
// (space_id, id) PK lets both coexist.
const TYPE_ID = `user.recipe_${Math.random().toString(36).slice(2, 8)}`;

interface TypeSchema {
  id: string;
  version: number;
}
interface ErrorBody {
  error: { code: string };
}

async function mintSpaceAdmin(label: string, spaceId: string): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 14);
  const raw = `marfa_k1_ty_scope_${suffix}`;
  await ctx.storage.keys.create(
    {
      label,
      source: `${label}-${suffix}`,
      role: "space_admin",
      default_tier: "library",
      type_permissions: { "*": "write" },
      edge_permissions: { "*": "write" },
      // Custom-type registration is gated on metadata.types:write for
      // non-admin credentials; space_admin bypasses, but grant it
      // explicitly so the intent is legible.
      metadata_permissions: { types: "write" },
      is_platform: false,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    spaceId,
  );
  return raw;
}

/** Registers a custom item type with a single optional `name` string field. */
async function registerType(key: string, id: string): Promise<Response> {
  return request(ctx.app, "POST", "/types", {
    key,
    body: {
      id,
      label: "Recipe",
      fields: { name: { type: "string" } },
    },
  });
}

/**
 * Attempts to create an item of `type`; returns the raw response. Supplies a
 * `body` (core.note's required field) plus a `name` (the custom recipe type's
 * field) so the same helper works for both.
 */
async function createItem(key: string, type: string): Promise<Response> {
  const suffix = Math.random().toString(36).slice(2);
  return request(ctx.app, "POST", "/items", {
    key,
    body: { type, properties: { body: `b-${suffix}`, name: `n-${suffix}` } },
  });
}

beforeAll(async () => {
  ctx = await createTestContext();
  adminA = await mintSpaceAdmin("ty-admin-a", spaceA);
  adminB = await mintSpaceAdmin("ty-admin-b", spaceB);
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("custom item types — registration is space-scoped", () => {
  it("space_admin registers a custom item type scoped to their space (201)", async () => {
    const res = await registerType(adminA, TYPE_ID);
    expect(res.status).toBe(201);
    const data = (await res.json()) as { type: TypeSchema };
    expect(data.type.id).toBe(TYPE_ID);
  });

  it("a second space registers the SAME id independently (per-space namespace)", async () => {
    // The composite PK means space B's registration of an id space A
    // already used is NOT a conflict — each space owns its own vocabulary.
    const res = await registerType(adminB, TYPE_ID);
    expect(res.status).toBe(201);
    const data = (await res.json()) as { type: TypeSchema };
    expect(data.type.id).toBe(TYPE_ID);
  });

  it("re-registering the same id within the same space is a 409", async () => {
    const res = await registerType(adminA, TYPE_ID);
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("type_already_exists");
  });
});

describe("custom item types — cross-space isolation", () => {
  it("space B cannot create an item of a type only space A registered (unknown_type)", async () => {
    // The heart of the leak: a custom type only space A defined must NOT
    // resolve in space B's create-time gate.
    const onlyA = `user.onlya_${Math.random().toString(36).slice(2, 8)}`;
    const reg = await registerType(adminA, onlyA);
    expect(reg.status).toBe(201);

    const res = await createItem(adminB, onlyA);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("unknown_type");
  });

  it("space A CAN create an item of its own custom type", async () => {
    const aType = `user.aown_${Math.random().toString(36).slice(2, 8)}`;
    const reg = await registerType(adminA, aType);
    expect(reg.status).toBe(201);

    const res = await createItem(adminA, aType);
    expect(res.status).toBe(201);
    const data = (await res.json()) as { item: { type: string } };
    expect(data.item.type).toBe(aType);
  });

  it("space B's type list does not see space A's distinct custom type", async () => {
    const onlyA = `user.listonlya_${Math.random().toString(36).slice(2, 8)}`;
    const create = await registerType(adminA, onlyA);
    expect(create.status).toBe(201);

    const listB = await request(ctx.app, "GET", "/types", { key: adminB });
    expect(listB.status).toBe(200);
    const dataB = (await listB.json()) as { id: string }[];
    const idsB = dataB.map((t) => t.id);
    expect(idsB).not.toContain(onlyA);
    // But B still sees the global core types.
    expect(idsB).toContain("core.note");

    // A sees its own.
    const listA = await request(ctx.app, "GET", "/types", { key: adminA });
    const dataA = (await listA.json()) as { id: string }[];
    expect(dataA.map((t) => t.id)).toContain(onlyA);
  });

  it("space B cannot fetch a custom type that only space A owns (404)", async () => {
    const onlyA = `user.getonlya_${Math.random().toString(36).slice(2, 8)}`;
    const reg = await registerType(adminA, onlyA);
    expect(reg.status).toBe(201);

    const getB = await request(ctx.app, "GET", `/types/${onlyA}`, {
      key: adminB,
    });
    expect(getB.status).toBe(404);

    // A can fetch its own.
    const getA = await request(ctx.app, "GET", `/types/${onlyA}`, {
      key: adminA,
    });
    expect(getA.status).toBe(200);
  });
});

describe("custom item types — core types resolve for every space", () => {
  it("both spaces can create core.note items", async () => {
    const resA = await createItem(adminA, "core.note");
    expect(resA.status).toBe(201);
    const resB = await createItem(adminB, "core.note");
    expect(resB.status).toBe(201);
  });
});
