/**
 * Custom edge-type tenant scoping.
 *
 * A tenant_admin can register custom edge types scoped to their own tenant.
 * The registry resolves a tenant's own custom edge types plus the global core
 * types — never another tenant's. This proves the isolation end to end: tenant
 * A registers an edge type; tenant B cannot see it, cannot create edges of it,
 * and gets `edge_type_not_found`; tenant A can. Reserved-name collision,
 * constraint validation, and core-type availability for everyone round out the
 * coverage.
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

// Unique namespace per run — the edge-type registry is module-level in
// @withmarfa/shared and would otherwise leak across test files sharing a
// worker. Both tenants register under the SAME id to prove per-tenant
// namespacing: the composite (tenant_id, id) PK lets both coexist.
const EDGE_ID = `user.benchmarks-${Math.random().toString(36).slice(2, 8)}`;

interface EdgeType {
  id: string;
  cardinality: string;
  source_type_constraints: string[];
  target_type_constraints: string[];
}
interface EdgeTypeListResponse {
  edge_types: EdgeType[];
}
interface ErrorBody {
  error: { code: string };
}

async function mintTenantAdmin(
  label: string,
  tenantId: string,
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 14);
  const raw = `marfa_k1_et_scope_${suffix}`;
  await ctx.storage.keys.create(
    {
      label,
      source: `${label}-${suffix}`,
      role: "tenant_admin",
      default_tier: "library",
      type_permissions: { "*": "write" },
      edge_permissions: { "*": "write" },
      is_platform: false,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    tenantId,
  );
  return raw;
}

async function createNote(key: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key,
    body: {
      type: "core.note",
      properties: { body: `n-${Math.random().toString(36).slice(2)}` },
    },
  });
  expect(res.status).toBe(201);
  const data = (await res.json()) as { item: { id: string } };
  return data.item.id;
}

beforeAll(async () => {
  ctx = await createTestContext();
  adminA = await mintTenantAdmin("et-admin-a", tenantA);
  adminB = await mintTenantAdmin("et-admin-b", tenantB);
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("custom edge types — tenant admin can register", () => {
  it("tenant_admin registers a custom edge type scoped to their tenant (201)", async () => {
    const res = await request(ctx.app, "POST", "/edge-types", {
      key: adminA,
      body: {
        id: EDGE_ID,
        label: "Benchmarks",
        cardinality: "many-to-many",
        cascade_on_delete: "orphan",
      },
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { edge_type: EdgeType };
    expect(data.edge_type.id).toBe(EDGE_ID);
  });

  it("a second tenant registers the SAME id independently (per-tenant namespace)", async () => {
    // The composite PK means tenant B's registration of an id tenant A
    // already used is NOT a conflict — each tenant owns its own vocabulary.
    const res = await request(ctx.app, "POST", "/edge-types", {
      key: adminB,
      body: { id: EDGE_ID, cardinality: "one-to-many" },
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { edge_type: EdgeType };
    expect(data.edge_type.id).toBe(EDGE_ID);
    // Tenant B's own cardinality, not tenant A's.
    expect(data.edge_type.cardinality).toBe("one-to-many");
  });

  it("re-registering the same id within the same tenant is a 409", async () => {
    const res = await request(ctx.app, "POST", "/edge-types", {
      key: adminA,
      body: { id: EDGE_ID, cardinality: "many-to-many" },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("conflict");
  });
});

describe("custom edge types — cross-tenant isolation", () => {
  it("tenant B's list does not see tenant A's distinct custom edge type", async () => {
    // A registers a second, B-invisible edge type.
    const onlyA = `user.only-a-${Math.random().toString(36).slice(2, 8)}`;
    const create = await request(ctx.app, "POST", "/edge-types", {
      key: adminA,
      body: { id: onlyA, cardinality: "many-to-many" },
    });
    expect(create.status).toBe(201);

    const listB = await request(ctx.app, "GET", "/edge-types", { key: adminB });
    expect(listB.status).toBe(200);
    const dataB = (await listB.json()) as EdgeTypeListResponse;
    const idsB = dataB.edge_types.map((t) => t.id);
    expect(idsB).not.toContain(onlyA);
    // But B still sees the global core types.
    expect(idsB).toContain("about");
    expect(idsB).toContain("parent-of");

    // A sees its own.
    const listA = await request(ctx.app, "GET", "/edge-types", { key: adminA });
    const dataA = (await listA.json()) as EdgeTypeListResponse;
    expect(dataA.edge_types.map((t) => t.id)).toContain(onlyA);
  });

  it("tenant B cannot create an edge of a type only tenant A registered", async () => {
    const onlyA = `user.aedge-${Math.random().toString(36).slice(2, 8)}`;
    const reg = await request(ctx.app, "POST", "/edge-types", {
      key: adminA,
      body: { id: onlyA, cardinality: "many-to-many" },
    });
    expect(reg.status).toBe(201);

    // B owns two items but the edge type is unknown in B's tenant.
    const bSource = await createNote(adminB);
    const bTarget = await createNote(adminB);
    const res = await request(ctx.app, "POST", "/edges", {
      key: adminB,
      body: { source_id: bSource, target_id: bTarget, edge_type: onlyA },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("edge_type_not_found");
  });

  it("tenant A CAN create an edge of its own custom edge type", async () => {
    const aEdge = `user.aown-${Math.random().toString(36).slice(2, 8)}`;
    const reg = await request(ctx.app, "POST", "/edge-types", {
      key: adminA,
      body: { id: aEdge, cardinality: "many-to-many" },
    });
    expect(reg.status).toBe(201);

    const aSource = await createNote(adminA);
    const aTarget = await createNote(adminA);
    const res = await request(ctx.app, "POST", "/edges", {
      key: adminA,
      body: { source_id: aSource, target_id: aTarget, edge_type: aEdge },
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { edge: { edge_type: string } };
    expect(data.edge.edge_type).toBe(aEdge);
  });

  it("tenant B cannot delete a custom edge type that only tenant A owns (404)", async () => {
    const onlyA = `user.adelete-${Math.random().toString(36).slice(2, 8)}`;
    const reg = await request(ctx.app, "POST", "/edge-types", {
      key: adminA,
      body: { id: onlyA, cardinality: "many-to-many" },
    });
    expect(reg.status).toBe(201);

    const delB = await request(ctx.app, "DELETE", `/edge-types/${onlyA}`, {
      key: adminB,
    });
    expect(delB.status).toBe(404);

    // A can still delete its own.
    const delA = await request(ctx.app, "DELETE", `/edge-types/${onlyA}`, {
      key: adminA,
    });
    expect(delA.status).toBe(200);
  });
});

describe("custom edge types — correctness rails preserved under tenant_admin", () => {
  it("409 on redefining a core edge type", async () => {
    const res = await request(ctx.app, "POST", "/edge-types", {
      key: adminA,
      body: { id: "about", cardinality: "many-to-many" },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("conflict");
  });

  it("constraint validation: edge rejected when source type is out of constraint", async () => {
    // Edge type constrained to a type no core.note satisfies.
    const constrained = `user.constrained-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const reg = await request(ctx.app, "POST", "/edge-types", {
      key: adminA,
      body: {
        id: constrained,
        cardinality: "many-to-many",
        source_type_constraints: ["core.event"],
        target_type_constraints: ["*"],
      },
    });
    expect(reg.status).toBe(201);

    const source = await createNote(adminA); // core.note, not core.event
    const target = await createNote(adminA);
    const res = await request(ctx.app, "POST", "/edges", {
      key: adminA,
      body: { source_id: source, target_id: target, edge_type: constrained },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("edge_constraint_violation");
  });

  it("core edge types still work for every tenant", async () => {
    const source = await createNote(adminB);
    const target = await createNote(adminB);
    const res = await request(ctx.app, "POST", "/edges", {
      key: adminB,
      body: { source_id: source, target_id: target, edge_type: "about" },
    });
    expect(res.status).toBe(201);
  });
});
