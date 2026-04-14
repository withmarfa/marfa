import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(() => {
  ctx.cleanup();
});

interface ItemResponse {
  item: { id: string; type: string };
  metadata: unknown;
}

async function createItem(type = "core.note"): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.adminKey,
    body: { type, properties: { body: `item-${String(Math.random())}` } },
  });
  const data = (await res.json()) as ItemResponse;
  return data.item.id;
}

describe("Edge endpoints — auth gate", () => {
  it("POST /edges rejects unauthenticated", async () => {
    const res = await request(ctx.app, "POST", "/edges", {
      body: { source_id: "x", target_id: "y", edge_type: "about" },
    });
    expect(res.status).toBe(401);
  });

  it("GET /items/:id/edges rejects unauthenticated", async () => {
    const res = await request(ctx.app, "GET", "/items/deadbeef/edges");
    expect(res.status).toBe(401);
  });
});

describe("POST /edges — happy path + validation", () => {
  it("creates a valid about edge", async () => {
    const source = await createItem();
    const target = await createItem();
    const res = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: {
        source_id: source,
        target_id: target,
        edge_type: "about",
      },
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as {
      edge: { source_id: string; target_id: string; edge_type: string };
    };
    expect(data.edge.source_id).toBe(source);
    expect(data.edge.target_id).toBe(target);
    expect(data.edge.edge_type).toBe("about");
  });

  it("rejects unknown edge type", async () => {
    const source = await createItem();
    const target = await createItem();
    const res = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: {
        source_id: source,
        target_id: target,
        edge_type: "nope.does-not-exist",
      },
    });
    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: { code: string } };
    expect(data.error.code).toBe("edge_type_not_found");
  });

  it("rejects self-edge", async () => {
    const id = await createItem();
    const res = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: { source_id: id, target_id: id, edge_type: "about" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects exact duplicate edge", async () => {
    const source = await createItem();
    const target = await createItem();
    const r1 = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: { source_id: source, target_id: target, edge_type: "about" },
    });
    expect(r1.status).toBe(201);
    const r2 = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: { source_id: source, target_id: target, edge_type: "about" },
    });
    expect(r2.status).toBe(400);
    const data = (await r2.json()) as { error: { code: string } };
    expect(data.error.code).toBe("edge_constraint_violation");
  });

  it("rejects missing source item", async () => {
    const target = await createItem();
    const res = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: {
        source_id: "019d0000-0000-7000-a000-000000000000",
        target_id: target,
        edge_type: "about",
      },
    });
    expect(res.status).toBe(404);
  });
});

describe("Cardinality — parent-of (one-to-many)", () => {
  it("rejects a second parent for the same child", async () => {
    const p1 = await createItem();
    const p2 = await createItem();
    const child = await createItem();
    // p1 parent-of child — ok
    const r1 = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: { source_id: p1, target_id: child, edge_type: "parent-of" },
    });
    expect(r1.status).toBe(201);
    // p2 parent-of child — reject (child already has a parent)
    const r2 = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: { source_id: p2, target_id: child, edge_type: "parent-of" },
    });
    expect(r2.status).toBe(400);
    const data = (await r2.json()) as { error: { code: string } };
    expect(data.error.code).toBe("edge_constraint_violation");
  });
});

describe("Cardinality — in-thread (many-to-one)", () => {
  it("rejects a second thread for the same source", async () => {
    const thread1 = await createItem();
    const thread2 = await createItem();
    const member = await createItem();
    const r1 = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: {
        source_id: member,
        target_id: thread1,
        edge_type: "in-thread",
      },
    });
    expect(r1.status).toBe(201);
    const r2 = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: {
        source_id: member,
        target_id: thread2,
        edge_type: "in-thread",
      },
    });
    expect(r2.status).toBe(400);
  });
});

describe("Cardinality — supersedes (one-to-one)", () => {
  it("rejects a second successor for the same predecessor", async () => {
    const older = await createItem();
    const newer1 = await createItem();
    const newer2 = await createItem();
    const r1 = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: {
        source_id: newer1,
        target_id: older,
        edge_type: "supersedes",
      },
    });
    expect(r1.status).toBe(201);
    const r2 = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: {
        source_id: newer2,
        target_id: older,
        edge_type: "supersedes",
      },
    });
    expect(r2.status).toBe(400);
  });
});

describe("Cycle detection — parent-of", () => {
  it("rejects parent-of(X, A) when X is already a descendant of A", async () => {
    // A parent-of B parent-of X. Then try X parent-of A — should cycle.
    const a = await createItem();
    const b = await createItem();
    const x = await createItem();
    const e1 = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: { source_id: a, target_id: b, edge_type: "parent-of" },
    });
    expect(e1.status).toBe(201);
    const e2 = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: { source_id: b, target_id: x, edge_type: "parent-of" },
    });
    expect(e2.status).toBe(201);
    const cycle = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: { source_id: x, target_id: a, edge_type: "parent-of" },
    });
    expect(cycle.status).toBe(400);
    const data = (await cycle.json()) as { error: { code: string } };
    expect(data.error.code).toBe("edge_cycle");
  });
});

describe("PATCH /edges/:id — properties only", () => {
  it("updates properties", async () => {
    const source = await createItem();
    const target = await createItem();
    const create = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: {
        source_id: source,
        target_id: target,
        edge_type: "in-thread",
        properties: { position: 1 },
      },
    });
    const created = (await create.json()) as { edge: { id: string } };
    const patch = await request(
      ctx.app,
      "PATCH",
      `/edges/${created.edge.id}`,
      {
        key: ctx.adminKey,
        body: { properties: { position: 2 } },
      },
    );
    expect(patch.status).toBe(200);
    const data = (await patch.json()) as {
      edge: { properties: { position: number } };
    };
    expect(data.edge.properties.position).toBe(2);
  });
});

describe("DELETE /edges/:id", () => {
  it("deletes an edge", async () => {
    const source = await createItem();
    const target = await createItem();
    const create = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: {
        source_id: source,
        target_id: target,
        edge_type: "about",
      },
    });
    const created = (await create.json()) as { edge: { id: string } };
    const del = await request(
      ctx.app,
      "DELETE",
      `/edges/${created.edge.id}`,
      {
        key: ctx.adminKey,
      },
    );
    expect(del.status).toBe(200);
    const fetched = await request(
      ctx.app,
      "PATCH",
      `/edges/${created.edge.id}`,
      {
        key: ctx.adminKey,
        body: { properties: {} },
      },
    );
    expect(fetched.status).toBe(404);
  });
});

describe("GET /items/:id/edges + /backrefs", () => {
  it("lists outbound and inbound edges separately", async () => {
    const a = await createItem();
    const b = await createItem();
    const c = await createItem();
    // a about b; a about c; b about a
    for (const body of [
      { source_id: a, target_id: b, edge_type: "about" },
      { source_id: a, target_id: c, edge_type: "about" },
      { source_id: b, target_id: a, edge_type: "about" },
    ]) {
      await request(ctx.app, "POST", "/edges", { key: ctx.adminKey, body });
    }
    const out = await request(ctx.app, "GET", `/items/${a}/edges`, {
      key: ctx.adminKey,
    });
    expect(out.status).toBe(200);
    const outData = (await out.json()) as { data: unknown[] };
    expect(outData.data.length).toBe(2);

    const back = await request(ctx.app, "GET", `/items/${a}/backrefs`, {
      key: ctx.adminKey,
    });
    expect(back.status).toBe(200);
    const backData = (await back.json()) as { data: unknown[] };
    expect(backData.data.length).toBe(1);
  });

  it("filters by comma-separated edge_type", async () => {
    const a = await createItem();
    const b = await createItem();
    const c = await createItem();
    await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: { source_id: a, target_id: b, edge_type: "about" },
    });
    await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: { source_id: a, target_id: c, edge_type: "derived-from" },
    });
    const onlyAbout = await request(
      ctx.app,
      "GET",
      `/items/${a}/edges?edge_type=about`,
      { key: ctx.adminKey },
    );
    const aboutData = (await onlyAbout.json()) as { data: unknown[] };
    expect(aboutData.data.length).toBe(1);
    const both = await request(
      ctx.app,
      "GET",
      `/items/${a}/edges?edge_type=about,derived-from`,
      { key: ctx.adminKey },
    );
    const bothData = (await both.json()) as { data: unknown[] };
    expect(bothData.data.length).toBe(2);
  });
});

describe("Atomic POST /items with edges", () => {
  it("creates item and edges in one transaction", async () => {
    const parent = await createItem();
    const about = await createItem();
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "atomic" },
        edges: {
          "parent-of": [], // new item is the parent (source) of nothing here
          about: [about],
        },
      },
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as ItemResponse;
    const outbound = await request(
      ctx.app,
      "GET",
      `/items/${data.item.id}/edges`,
      { key: ctx.adminKey },
    );
    const od = (await outbound.json()) as {
      data: { edge_type: string }[];
    };
    expect(od.data.some((e) => e.edge_type === "about")).toBe(true);
    expect(parent).toBeTruthy();
  });

  it("rolls back everything when an edge target is missing", async () => {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "atomic-fail" },
        edges: { about: ["019d0000-0000-7000-a000-000000000000"] },
      },
    });
    expect(res.status).toBe(404);
  });
});

describe("Query-language: edge[X]=Y and backref[X]=Y", () => {
  it("filters items by outbound edge via ?edge[X]=Y", async () => {
    const target = await createItem();
    const a = await createItem();
    const b = await createItem();
    // a → about → target; b unrelated.
    await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: { source_id: a, target_id: target, edge_type: "about" },
    });
    const res = await request(
      ctx.app,
      "GET",
      `/items?type=core.note&limit=200&edge[about]=${target}`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { data: { id: string }[] };
    const ids = data.data.map((d) => d.id);
    expect(ids).toContain(a);
    expect(ids).not.toContain(b);
  });

  it("filters items by inbound edge via ?backref[X]=Y", async () => {
    const source = await createItem();
    const a = await createItem();
    const b = await createItem();
    // source → about → a. Looking up `backref[about]=source` returns a.
    await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: { source_id: source, target_id: a, edge_type: "about" },
    });
    const res = await request(
      ctx.app,
      "GET",
      `/items?type=core.note&limit=200&backref[about]=${source}`,
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { data: { id: string }[] };
    const ids = data.data.map((d) => d.id);
    expect(ids).toContain(a);
    expect(ids).not.toContain(b);
  });
});

describe("Edge permission enforcement", () => {
  it("rejects a non-admin key without edge permissions", async () => {
    // Create a non-admin key with type_permissions but no edge_permissions.
    const keyRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: {
        label: "member-no-edge",
        source: `member-no-edge-${String(Math.random())}`,
        role: "member",
        default_library: true,
        type_permissions: { "core.note": "write" },
        edge_permissions: {},
      },
    });
    const keyData = (await keyRes.json()) as { key: string };
    const memberKey = keyData.key;

    const source = await createItem();
    const target = await createItem();
    const res = await request(ctx.app, "POST", "/edges", {
      key: memberKey,
      body: {
        source_id: source,
        target_id: target,
        edge_type: "about",
      },
    });
    expect(res.status).toBe(403);
    const err = (await res.json()) as { error: { code: string } };
    expect(err.error.code).toBe("edge_permission_denied");
  });

  it("accepts a non-admin key with edge.*:write wildcard", async () => {
    const keyRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: {
        label: "member-edge-all",
        source: `member-edge-all-${String(Math.random())}`,
        role: "member",
        default_library: true,
        type_permissions: { "core.note": "write" },
        edge_permissions: { "*": "write" },
      },
    });
    const keyData = (await keyRes.json()) as { key: string };
    const memberKey = keyData.key;

    const source = await createItem();
    const target = await createItem();
    const res = await request(ctx.app, "POST", "/edges", {
      key: memberKey,
      body: {
        source_id: source,
        target_id: target,
        edge_type: "about",
      },
    });
    expect(res.status).toBe(201);
  });
});

describe("Edge hydration on item reads", () => {
  it("hydrates outbound edges on GET /items/:id", async () => {
    const source = await createItem();
    const tgt1 = await createItem();
    const tgt2 = await createItem();
    for (const target of [tgt1, tgt2]) {
      await request(ctx.app, "POST", "/edges", {
        key: ctx.adminKey,
        body: { source_id: source, target_id: target, edge_type: "about" },
      });
    }
    const res = await request(ctx.app, "GET", `/items/${source}`, {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      item: { edges?: Record<string, { edges: { target_id: string }[] }> };
    };
    expect(data.item.edges).toBeDefined();
    const about = data.item.edges?.about;
    expect(about).toBeDefined();
    expect(about?.edges.length).toBe(2);
  });

  it("skips edge hydration on GET /items unless include=edges", async () => {
    const source = await createItem();
    const target = await createItem();
    await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: { source_id: source, target_id: target, edge_type: "about" },
    });
    const withoutInclude = await request(
      ctx.app,
      "GET",
      `/items?type=core.note&limit=50`,
      { key: ctx.adminKey },
    );
    const data = (await withoutInclude.json()) as {
      data: { id: string; edges?: unknown }[];
    };
    const found = data.data.find((d) => d.id === source);
    expect(found).toBeDefined();
    expect(found?.edges).toBeUndefined();

    const withInclude = await request(
      ctx.app,
      "GET",
      `/items?type=core.note&limit=50&include=edges`,
      { key: ctx.adminKey },
    );
    const inclData = (await withInclude.json()) as {
      data: { id: string; edges?: Record<string, unknown> }[];
    };
    const foundIncl = inclData.data.find((d) => d.id === source);
    expect(foundIncl?.edges).toBeDefined();
  });
});

describe("Cascade-on-delete for parent-of", () => {
  it("soft-deleting a parent cascades to its children", async () => {
    const parent = await createItem();
    const childA = await createItem();
    const childB = await createItem();
    for (const tgt of [childA, childB]) {
      await request(ctx.app, "POST", "/edges", {
        key: ctx.adminKey,
        body: { source_id: parent, target_id: tgt, edge_type: "parent-of" },
      });
    }
    const del = await request(ctx.app, "DELETE", `/items/${parent}`, {
      key: ctx.adminKey,
    });
    expect(del.status).toBe(200);
    // GET /items/:id hides trashed items — a 404 means the item is trashed
    // (active items would return 200). Confirms cascade fired.
    for (const id of [parent, childA, childB]) {
      const r = await request(ctx.app, "GET", `/items/${id}`, {
        key: ctx.adminKey,
      });
      expect(r.status).toBe(404);
    }
  });
});
