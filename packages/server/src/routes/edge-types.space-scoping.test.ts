/**
 * Custom edge-type space scoping.
 *
 * A space-bound credential can register custom edge types scoped to its own
 * space.
 * The registry resolves a space's own custom edge types plus the global core
 * types — never another space's. This proves the isolation end to end: space
 * A registers an edge type; space B cannot see it, cannot create edges of it,
 * and gets `edge_type_not_found`; space A can. Reserved-name collision,
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
import { SPACE_PERMISSIONS } from "@withmarfa/shared";

let ctx: TestContext;

const spaceA = `space-a-${Math.random().toString(36).slice(2, 10)}`;
const spaceB = `space-b-${Math.random().toString(36).slice(2, 10)}`;
let keyA: string;
let keyB: string;

// Unique namespace per run — the edge-type registry is module-level in
// @withmarfa/shared and would otherwise leak across test files sharing a
// worker. Both spaces register under the SAME id to prove per-space
// namespacing: the composite (space_id, id) PK lets both coexist.
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

async function mintSpaceKey(label: string, spaceId: string): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 14);
  const raw = `marfa_k1_et_scope_${suffix}`;
  await ctx.storage.keys.create(
    {
      label,
      source: `${label}-${suffix}`,
      space_permissions: [...SPACE_PERMISSIONS],
      default_tier: "library",
      type_permissions: { "*": "write" },
      edge_permissions: { "*": "write" },
      // Registering an edge type is gated on the metadata map, deleting one on
      // `space.schema`. Both are named so the fixture reaches the whole
      // registry surface the isolation is measured across.
      metadata_permissions: { "*": "write" },
      is_operator: false,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    spaceId,
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
  keyA = await mintSpaceKey("et-key-a", spaceA);
  keyB = await mintSpaceKey("et-key-b", spaceB);
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("custom edge types — a space-bound key can register", () => {
  it("registers a custom edge type scoped to the caller's space (201)", async () => {
    const res = await request(ctx.app, "POST", "/edge-types", {
      key: keyA,
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

  it("a second space registers the SAME id independently (per-space namespace)", async () => {
    // The composite PK means space B's registration of an id space A
    // already used is NOT a conflict — each space owns its own vocabulary.
    const res = await request(ctx.app, "POST", "/edge-types", {
      key: keyB,
      body: { id: EDGE_ID, cardinality: "one-to-many" },
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { edge_type: EdgeType };
    expect(data.edge_type.id).toBe(EDGE_ID);
    // Space B's own cardinality, not space A's.
    expect(data.edge_type.cardinality).toBe("one-to-many");
  });

  it("re-registering the same id within the same space is a 409", async () => {
    const res = await request(ctx.app, "POST", "/edge-types", {
      key: keyA,
      body: { id: EDGE_ID, cardinality: "many-to-many" },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("conflict");
  });
});

describe("custom edge types — cross-space isolation", () => {
  it("space B's list does not see space A's distinct custom edge type", async () => {
    // A registers a second, B-invisible edge type.
    const onlyA = `user.only-a-${Math.random().toString(36).slice(2, 8)}`;
    const create = await request(ctx.app, "POST", "/edge-types", {
      key: keyA,
      body: { id: onlyA, cardinality: "many-to-many" },
    });
    expect(create.status).toBe(201);

    const listB = await request(ctx.app, "GET", "/edge-types", { key: keyB });
    expect(listB.status).toBe(200);
    const dataB = (await listB.json()) as EdgeTypeListResponse;
    const idsB = dataB.edge_types.map((t) => t.id);
    expect(idsB).not.toContain(onlyA);
    // But B still sees the global core types.
    expect(idsB).toContain("about");
    expect(idsB).toContain("parent-of");

    // A sees its own.
    const listA = await request(ctx.app, "GET", "/edge-types", { key: keyA });
    const dataA = (await listA.json()) as EdgeTypeListResponse;
    expect(dataA.edge_types.map((t) => t.id)).toContain(onlyA);
  });

  it("space B cannot create an edge of a type only space A registered", async () => {
    const onlyA = `user.aedge-${Math.random().toString(36).slice(2, 8)}`;
    const reg = await request(ctx.app, "POST", "/edge-types", {
      key: keyA,
      body: { id: onlyA, cardinality: "many-to-many" },
    });
    expect(reg.status).toBe(201);

    // B owns two items but the edge type is unknown in B's space.
    const bSource = await createNote(keyB);
    const bTarget = await createNote(keyB);
    const res = await request(ctx.app, "POST", "/edges", {
      key: keyB,
      body: { source_id: bSource, target_id: bTarget, edge_type: onlyA },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("edge_type_not_found");
  });

  it("space A CAN create an edge of its own custom edge type", async () => {
    const aEdge = `user.aown-${Math.random().toString(36).slice(2, 8)}`;
    const reg = await request(ctx.app, "POST", "/edge-types", {
      key: keyA,
      body: { id: aEdge, cardinality: "many-to-many" },
    });
    expect(reg.status).toBe(201);

    const aSource = await createNote(keyA);
    const aTarget = await createNote(keyA);
    const res = await request(ctx.app, "POST", "/edges", {
      key: keyA,
      body: { source_id: aSource, target_id: aTarget, edge_type: aEdge },
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { edge: { edge_type: string } };
    expect(data.edge.edge_type).toBe(aEdge);
  });

  it("space B cannot delete a custom edge type that only space A owns (404)", async () => {
    const onlyA = `user.adelete-${Math.random().toString(36).slice(2, 8)}`;
    const reg = await request(ctx.app, "POST", "/edge-types", {
      key: keyA,
      body: { id: onlyA, cardinality: "many-to-many" },
    });
    expect(reg.status).toBe(201);

    const delB = await request(ctx.app, "DELETE", `/edge-types/${onlyA}`, {
      key: keyB,
    });
    expect(delB.status).toBe(404);

    // A can still delete its own.
    const delA = await request(ctx.app, "DELETE", `/edge-types/${onlyA}`, {
      key: keyA,
    });
    expect(delA.status).toBe(200);
  });
});

describe("custom edge types — correctness rails preserved for a space key", () => {
  it("409 on redefining a core edge type", async () => {
    const res = await request(ctx.app, "POST", "/edge-types", {
      key: keyA,
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
      key: keyA,
      body: {
        id: constrained,
        cardinality: "many-to-many",
        source_type_constraints: ["core.event"],
        target_type_constraints: ["*"],
      },
    });
    expect(reg.status).toBe(201);

    const source = await createNote(keyA); // core.note, not core.event
    const target = await createNote(keyA);
    const res = await request(ctx.app, "POST", "/edges", {
      key: keyA,
      body: { source_id: source, target_id: target, edge_type: constrained },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("edge_constraint_violation");
  });

  it("core edge types still work for every space", async () => {
    const source = await createNote(keyB);
    const target = await createNote(keyB);
    const res = await request(ctx.app, "POST", "/edges", {
      key: keyB,
      body: { source_id: source, target_id: target, edge_type: "about" },
    });
    expect(res.status).toBe(201);
  });
});
