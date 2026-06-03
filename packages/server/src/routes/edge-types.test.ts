import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

// Unique namespace per run — the edge-type registry is module-level in
// @withmarfa/shared and would leak across test files if they share a worker.
const NS = `test.et-${Math.random().toString(36).slice(2, 8)}`;

interface EdgeType {
  id: string;
  cardinality: string;
  cascade_on_delete: string;
  source_type_constraints: string[];
  target_type_constraints: string[];
}

interface EdgeTypeListResponse {
  edge_types: EdgeType[];
}

interface ErrorBody {
  error: { code: string };
}

async function createMemberKey(label: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/keys", {
    key: ctx.adminKey,
    body: {
      label,
      source: `${label}-${Math.random().toString(36).slice(2, 10)}`,
      role: "member",
      default_tier: "library",
      type_permissions: { "*": "write" },
      edge_permissions: { "*": "write" },
    },
  });
  const data = (await res.json()) as { key: string };
  return data.key;
}

describe("Edge-type endpoints — auth gate", () => {
  it("POST /edge-types rejects unauthenticated", async () => {
    const res = await request(ctx.app, "POST", "/edge-types", {
      body: { id: `${NS}.unauth`, cardinality: "many-to-many" },
    });
    expect(res.status).toBe(401);
  });

  it("DELETE /edge-types/:id rejects unauthenticated", async () => {
    const res = await request(ctx.app, "DELETE", `/edge-types/${NS}.unauth`);
    expect(res.status).toBe(401);
  });
});

describe("Edge-type endpoints — admin gate", () => {
  it("POST /edge-types rejects non-admin keys with 403", async () => {
    const memberKey = await createMemberKey("et-post-member");
    const res = await request(ctx.app, "POST", "/edge-types", {
      key: memberKey,
      body: { id: `${NS}.admin-gate`, cardinality: "many-to-many" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("forbidden");
  });

  it("DELETE /edge-types/:id rejects non-admin keys with 403", async () => {
    const memberKey = await createMemberKey("et-delete-member");
    const res = await request(ctx.app, "DELETE", `/edge-types/${NS}.x`, {
      key: memberKey,
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /edge-types — happy path and validation", () => {
  it("admin registers a custom edge type (201)", async () => {
    const id = `${NS}.happy`;
    const res = await request(ctx.app, "POST", "/edge-types", {
      key: ctx.adminKey,
      body: {
        id,
        label: "Happy",
        cardinality: "many-to-many",
        cascade_on_delete: "orphan",
      },
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { edge_type: EdgeType };
    expect(data.edge_type.id).toBe(id);
    expect(data.edge_type.cardinality).toBe("many-to-many");
    expect(data.edge_type.cascade_on_delete).toBe("orphan");
    // Default constraint wildcards applied when omitted.
    expect(data.edge_type.source_type_constraints).toEqual(["*"]);
    expect(data.edge_type.target_type_constraints).toEqual(["*"]);
  });

  it("409 on redefinition of a core edge type", async () => {
    const res = await request(ctx.app, "POST", "/edge-types", {
      key: ctx.adminKey,
      body: { id: "about", cardinality: "many-to-many" },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("conflict");
  });

  it("400 when `extends` is supplied (unsupported)", async () => {
    const res = await request(ctx.app, "POST", "/edge-types", {
      key: ctx.adminKey,
      body: {
        id: `${NS}.inherit`,
        cardinality: "many-to-many",
        extends: "about",
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("validation_error");
  });

  it("400 on an invalid type identifier", async () => {
    const res = await request(ctx.app, "POST", "/edge-types", {
      key: ctx.adminKey,
      body: { id: "INVALID", cardinality: "many-to-many" },
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /edge-types — list", () => {
  it("returns core types plus just-registered custom types", async () => {
    const id = `${NS}.list`;
    const create = await request(ctx.app, "POST", "/edge-types", {
      key: ctx.adminKey,
      body: { id, cardinality: "many-to-many" },
    });
    expect(create.status).toBe(201);

    const res = await request(ctx.app, "GET", "/edge-types", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as EdgeTypeListResponse;
    const ids = data.edge_types.map((t) => t.id);
    expect(ids).toContain("about"); // core
    expect(ids).toContain("parent-of"); // core
    expect(ids).toContain(id); // custom, just created
  });
});

describe("DELETE /edge-types/:id — happy path and errors", () => {
  it("admin deletes a custom edge type (200), then it is gone from list", async () => {
    const id = `${NS}.delete-me`;
    const create = await request(ctx.app, "POST", "/edge-types", {
      key: ctx.adminKey,
      body: { id, cardinality: "many-to-many" },
    });
    expect(create.status).toBe(201);

    const del = await request(ctx.app, "DELETE", `/edge-types/${id}`, {
      key: ctx.adminKey,
    });
    expect(del.status).toBe(200);
    const body = (await del.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const list = await request(ctx.app, "GET", "/edge-types", {
      key: ctx.adminKey,
    });
    const data = (await list.json()) as EdgeTypeListResponse;
    expect(data.edge_types.map((t) => t.id)).not.toContain(id);
  });

  it("400 when attempting to delete a core edge type", async () => {
    const res = await request(ctx.app, "DELETE", "/edge-types/about", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("validation_error");
  });

  it("404 when deleting an unknown custom edge type", async () => {
    const res = await request(
      ctx.app,
      "DELETE",
      `/edge-types/${NS}.does-not-exist`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("edge_type_not_found");
  });
});
