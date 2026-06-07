/**
 * Custom item-type tenant scoping.
 *
 * Custom item types are stored per tenant in `custom_types`, but the in-memory
 * type registry that the create-time gate consults must resolve a tenant's own
 * custom types plus the global core/system set — never another tenant's. This
 * proves the isolation end to end: tenant A registers a custom item type;
 * tenant B cannot see it and cannot create items of it (`unknown_type`), while
 * tenant A can. Two tenants registering the same id independently, and core
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

const tenantA = `tenant-a-${Math.random().toString(36).slice(2, 10)}`;
const tenantB = `tenant-b-${Math.random().toString(36).slice(2, 10)}`;
let adminA: string;
let adminB: string;

// Unique id per run — the type registry is module-level in @withmarfa/shared
// and would otherwise leak across test files sharing a worker. Both tenants
// register under the SAME id to prove per-tenant namespacing: the composite
// (tenant_id, id) PK lets both coexist.
const TYPE_ID = `user.recipe_${Math.random().toString(36).slice(2, 8)}`;

interface TypeSchema {
  id: string;
  version: number;
}
interface ErrorBody {
  error: { code: string };
}

async function mintTenantAdmin(
  label: string,
  tenantId: string,
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 14);
  const raw = `marfa_k1_ty_scope_${suffix}`;
  await ctx.storage.keys.create(
    {
      label,
      source: `${label}-${suffix}`,
      role: "tenant_admin",
      default_tier: "library",
      type_permissions: { "*": "write" },
      edge_permissions: { "*": "write" },
      // Custom-type registration is gated on metadata.types:write for
      // non-admin credentials; tenant_admin bypasses, but grant it
      // explicitly so the intent is legible.
      metadata_permissions: { types: "write" },
      is_platform: false,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    tenantId,
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
  adminA = await mintTenantAdmin("ty-admin-a", tenantA);
  adminB = await mintTenantAdmin("ty-admin-b", tenantB);
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("custom item types — registration is tenant-scoped", () => {
  it("tenant_admin registers a custom item type scoped to their tenant (201)", async () => {
    const res = await registerType(adminA, TYPE_ID);
    expect(res.status).toBe(201);
    const data = (await res.json()) as { type: TypeSchema };
    expect(data.type.id).toBe(TYPE_ID);
  });

  it("a second tenant registers the SAME id independently (per-tenant namespace)", async () => {
    // The composite PK means tenant B's registration of an id tenant A
    // already used is NOT a conflict — each tenant owns its own vocabulary.
    const res = await registerType(adminB, TYPE_ID);
    expect(res.status).toBe(201);
    const data = (await res.json()) as { type: TypeSchema };
    expect(data.type.id).toBe(TYPE_ID);
  });

  it("re-registering the same id within the same tenant is a 409", async () => {
    const res = await registerType(adminA, TYPE_ID);
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("type_already_exists");
  });
});

describe("custom item types — cross-tenant isolation", () => {
  it("tenant B cannot create an item of a type only tenant A registered (unknown_type)", async () => {
    // The heart of the leak: a custom type only tenant A defined must NOT
    // resolve in tenant B's create-time gate.
    const onlyA = `user.onlya_${Math.random().toString(36).slice(2, 8)}`;
    const reg = await registerType(adminA, onlyA);
    expect(reg.status).toBe(201);

    const res = await createItem(adminB, onlyA);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("unknown_type");
  });

  it("tenant A CAN create an item of its own custom type", async () => {
    const aType = `user.aown_${Math.random().toString(36).slice(2, 8)}`;
    const reg = await registerType(adminA, aType);
    expect(reg.status).toBe(201);

    const res = await createItem(adminA, aType);
    expect(res.status).toBe(201);
    const data = (await res.json()) as { item: { type: string } };
    expect(data.item.type).toBe(aType);
  });

  it("tenant B's type list does not see tenant A's distinct custom type", async () => {
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

  it("tenant B cannot fetch a custom type that only tenant A owns (404)", async () => {
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

describe("custom item types — core types resolve for every tenant", () => {
  it("both tenants can create core.note items", async () => {
    const resA = await createItem(adminA, "core.note");
    expect(resA.status).toBe(201);
    const resB = await createItem(adminB, "core.note");
    expect(resB.status).toBe(201);
  });
});
