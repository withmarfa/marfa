import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  waitForAudit,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
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

describe("POST /items — batched atomic edge validation", () => {
  it("rejects the whole request when one edge target is missing", async () => {
    // Mixed batch: one valid target, one missing. Batched validator must
    // surface the missing-item error rather than silently accepting the
    // half that would have succeeded.
    const validTarget = await createItem();
    const missingTarget = "019d0000-0000-7000-a000-000000000000";
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "batch fails atomically" },
        edges: { about: [validTarget, missingTarget] },
      },
    });
    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: { code: string } };
    expect(data.error.code).toBe("item_not_found");
  });

  it("rejects cardinality violations discovered across a single batch", async () => {
    // parent-of is one-to-many on the target — a single child can have at
    // most one parent. Batching [target, target] under parent-of means the
    // first proposal consumes the target's single inbound slot; the second
    // must see the in-batch accumulator and reject.
    const target = await createItem();
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: {
        type: "core.note",
        properties: { body: "cardinality in-batch" },
        edges: { "parent-of": [target, target] },
      },
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: { code: string } };
    expect(data.error.code).toBe("edge_constraint_violation");
  });
});

describe("PATCH /items — batched replace triggers cycle detection", () => {
  it("rejects a parent-of replacement that would close a cycle", async () => {
    // A parent-of B already exists. PATCH B with edges { parent-of: [A] }
    // would make B a parent of A while A is still B's ancestor — the
    // batched validator must still catch the cycle after the delete-by-
    // source pass that the PATCH handler runs first.
    const a = await createItem();
    const b = await createItem();
    const ab = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: { source_id: a, target_id: b, edge_type: "parent-of" },
    });
    expect(ab.status).toBe(201);
    const cyclePatch = await request(ctx.app, "PATCH", `/items/${b}`, {
      key: ctx.adminKey,
      body: { edges: { "parent-of": [a] } },
    });
    expect(cyclePatch.status).toBe(400);
    const data = (await cyclePatch.json()) as { error: { code: string } };
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
    const patch = await request(ctx.app, "PATCH", `/edges/${created.edge.id}`, {
      key: ctx.adminKey,
      body: { properties: { position: 2 } },
    });
    expect(patch.status).toBe(200);
    const data = (await patch.json()) as {
      edge: { properties: { position: number } };
    };
    expect(data.edge.properties.position).toBe(2);
  });

  it("emits an audit row on success", async () => {
    // Sibling POST and DELETE handlers emit `edge.create` / `edge.delete`
    // audit rows; this verifies PATCH emits one too.
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
    const patch = await request(ctx.app, "PATCH", `/edges/${created.edge.id}`, {
      key: ctx.adminKey,
      body: { properties: { position: 7 } },
    });
    expect(patch.status).toBe(200);

    // Audit insert is fire-and-forget. Poll briefly for the row.
    const auditData = await waitForAudit(
      async () => {
        const auditRes = await request(ctx.app, "GET", "/audit?limit=20", {
          key: ctx.adminKey,
        });
        return (await auditRes.json()) as {
          data: {
            action: string;
            resource_id: string;
            resource_type: string;
            details?: { edge_type?: string };
          }[];
        };
      },
      (result) =>
        result.data.some(
          (e) =>
            e.action === "edge.update" && e.resource_id === created.edge.id,
        ),
    );
    const updateEntry = auditData.data.find(
      (e) => e.action === "edge.update" && e.resource_id === created.edge.id,
    );
    expect(updateEntry).toBeDefined();
    expect(updateEntry?.resource_type).toBe("edge");
    expect(updateEntry?.details?.edge_type).toBe("in-thread");
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
    const del = await request(ctx.app, "DELETE", `/edges/${created.edge.id}`, {
      key: ctx.adminKey,
    });
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

describe("Custom edge-type registration", () => {
  it("admin registers a custom edge type via POST /edge-types", async () => {
    const res = await request(ctx.app, "POST", "/edge-types", {
      key: ctx.adminKey,
      body: {
        id: "test.custom-link",
        cardinality: "many-to-many",
        cascade_on_delete: "orphan",
      },
    });
    expect(res.status).toBe(201);

    // Now edges of this type should be creatable
    const a = await createItem();
    const b = await createItem();
    const useRes = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: {
        source_id: a,
        target_id: b,
        edge_type: "test.custom-link",
      },
    });
    expect(useRes.status).toBe(201);
  });

  it("rejects redefinition of a core edge type", async () => {
    const res = await request(ctx.app, "POST", "/edge-types", {
      key: ctx.adminKey,
      body: {
        id: "about",
        cardinality: "many-to-many",
      },
    });
    expect(res.status).toBe(409);
  });

  it("rejects `extends` on custom edge type", async () => {
    const res = await request(ctx.app, "POST", "/edge-types", {
      key: ctx.adminKey,
      body: {
        id: "test.inherit",
        cardinality: "many-to-many",
        extends: "about",
      },
    });
    expect(res.status).toBe(400);
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
        default_tier: "library",
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
        default_tier: "library",
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

describe("event_log accepts item_id=null for edge rows", () => {
  it("append({item_id: null, edge_id: <id>}) round-trips as null/id", async () => {
    // Exercise the persistence layer directly — the test-utils bootstrap
    // doesn't call initEventLog() so publishEdge() won't persist at the
    // HTTP layer during tests. What we care about here is the column
    // nullability (Q10 fix): item_id can be null, edge_id is set, and
    // getAfter returns them as null / <id> respectively.
    const id = await ctx.storage.eventLog.append({
      event_type: "edge_created",
      item_id: null,
      edge_id: "019d0000-0000-7000-a000-000000000abc",
      space_id: undefined,
      payload: JSON.stringify({ type: "edge.created", edge: { id: "x" } }),
    });
    expect(id > 0n).toBe(true);
    const batch = await ctx.storage.eventLog.getAfter(id - 1n, 10);
    const mine = batch.find((e) => e.id === id);
    expect(mine).toBeDefined();
    expect(mine?.item_id).toBeNull();
    expect(mine?.edge_id).toBe("019d0000-0000-7000-a000-000000000abc");
  });
});

describe("PATCH /items/:id with edges (replace-all-for-specified-types)", () => {
  it("replaces edges of mentioned types, preserves other types", async () => {
    const source = await createItem();
    const aboutTarget1 = await createItem();
    const aboutTarget2 = await createItem();
    const derivedTarget = await createItem();

    // Seed: source has about->aboutTarget1 and derived-from->derivedTarget
    await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: {
        source_id: source,
        target_id: aboutTarget1,
        edge_type: "about",
      },
    });
    await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: {
        source_id: source,
        target_id: derivedTarget,
        edge_type: "derived-from",
      },
    });

    // PATCH replaces `about` with [aboutTarget2], leaves derived-from alone.
    const patch = await request(ctx.app, "PATCH", `/items/${source}`, {
      key: ctx.adminKey,
      body: { edges: { about: [aboutTarget2] } },
    });
    expect(patch.status).toBe(200);

    const out = await request(ctx.app, "GET", `/items/${source}/edges`, {
      key: ctx.adminKey,
    });
    const data = (await out.json()) as {
      data: { edge_type: string; target_id: string }[];
    };
    const aboutEdges = data.data.filter((e) => e.edge_type === "about");
    const derivedEdges = data.data.filter(
      (e) => e.edge_type === "derived-from",
    );
    expect(aboutEdges.length).toBe(1);
    expect(aboutEdges[0]?.target_id).toBe(aboutTarget2);
    expect(derivedEdges.length).toBe(1);
    expect(derivedEdges[0]?.target_id).toBe(derivedTarget);
  });

  it("empty array deletes all edges of that type", async () => {
    const source = await createItem();
    const t1 = await createItem();
    const t2 = await createItem();
    for (const target of [t1, t2]) {
      await request(ctx.app, "POST", "/edges", {
        key: ctx.adminKey,
        body: { source_id: source, target_id: target, edge_type: "about" },
      });
    }
    const patch = await request(ctx.app, "PATCH", `/items/${source}`, {
      key: ctx.adminKey,
      body: { edges: { about: [] } },
    });
    expect(patch.status).toBe(200);

    const out = await request(ctx.app, "GET", `/items/${source}/edges`, {
      key: ctx.adminKey,
    });
    const data = (await out.json()) as { data: unknown[] };
    expect(data.data.length).toBe(0);
  });

  it("rolls back the whole PATCH on any invalid target", async () => {
    const source = await createItem();
    const preexistingTarget = await createItem();
    await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: {
        source_id: source,
        target_id: preexistingTarget,
        edge_type: "about",
      },
    });
    const goodTarget = await createItem();
    const patch = await request(ctx.app, "PATCH", `/items/${source}`, {
      key: ctx.adminKey,
      body: {
        edges: {
          about: [goodTarget, "019d0000-0000-7000-a000-000000000000"],
        },
      },
    });
    expect(patch.status).toBe(404);

    // Rollback: preexisting edge survives, good target was NOT added.
    const out = await request(ctx.app, "GET", `/items/${source}/edges`, {
      key: ctx.adminKey,
    });
    const data = (await out.json()) as {
      data: { target_id: string }[];
    };
    expect(data.data.length).toBe(1);
    expect(data.data[0]?.target_id).toBe(preexistingTarget);
  });

  it("rejects PATCH with neither properties nor edges", async () => {
    const source = await createItem();
    const patch = await request(ctx.app, "PATCH", `/items/${source}`, {
      key: ctx.adminKey,
      body: {},
    });
    expect(patch.status).toBe(400);
  });

  it("PATCH edges gates by edge-type permission for non-admin keys", async () => {
    const keyRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: {
        label: "patch-edge-denied",
        source: `patch-edge-denied-${String(Math.random())}`,
        role: "member",
        default_tier: "library",
        type_permissions: { "*": "write" },
        edge_permissions: {}, // explicitly denies edges
      },
    });
    const memberKey = ((await keyRes.json()) as { key: string }).key;

    const source = await createItem();
    const target = await createItem();
    const res = await request(ctx.app, "PATCH", `/items/${source}`, {
      key: memberKey,
      body: { edges: { about: [target] } },
    });
    expect(res.status).toBe(403);
  });
});

describe("Edge permission matrix (admin / type-only / edge-only / both / neither)", () => {
  async function mkKey(
    typePerms: Record<string, "read" | "write" | "none"> | undefined,
    edgePerms: Record<string, "read" | "write"> | undefined,
    role: "instance_admin" | "space_admin" | "member" = "member",
  ): Promise<string> {
    const res = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: {
        label: `matrix-${String(Math.random())}`,
        source: `matrix-${String(Math.random())}`,
        role,
        default_tier: "library",
        ...(typePerms && { type_permissions: typePerms }),
        ...(edgePerms && { edge_permissions: edgePerms }),
      },
    });
    return ((await res.json()) as { key: string }).key;
  }

  it("admin passes create + update + delete without permissions", async () => {
    // ctx.adminKey is already admin; demonstrate end-to-end.
    const a = await createItem();
    const b = await createItem();
    const create = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: { source_id: a, target_id: b, edge_type: "about" },
    });
    expect(create.status).toBe(201);
    const id = ((await create.json()) as { edge: { id: string } }).edge.id;
    const patch = await request(ctx.app, "PATCH", `/edges/${id}`, {
      key: ctx.adminKey,
      body: { properties: { note: "admin" } },
    });
    expect(patch.status).toBe(200);
    const del = await request(ctx.app, "DELETE", `/edges/${id}`, {
      key: ctx.adminKey,
    });
    expect(del.status).toBe(200);
  });

  it("type-only member denies edge create (FORBIDDEN)", async () => {
    const key = await mkKey({ "*": "write" }, {});
    const a = await createItem();
    const b = await createItem();
    const res = await request(ctx.app, "POST", "/edges", {
      key,
      body: { source_id: a, target_id: b, edge_type: "about" },
    });
    expect(res.status).toBe(403);
    const err = (await res.json()) as { error: { code: string } };
    expect(err.error.code).toBe("edge_permission_denied");
  });

  it("edge-only member denies edge create (source-type gate fails)", async () => {
    const key = await mkKey({}, { "*": "write" });
    const a = await createItem();
    const b = await createItem();
    const res = await request(ctx.app, "POST", "/edges", {
      key,
      body: { source_id: a, target_id: b, edge_type: "about" },
    });
    expect(res.status).toBe(403);
  });

  it("both-granted member succeeds on create", async () => {
    const key = await mkKey({ "*": "write" }, { "*": "write" });
    const a = await createItem();
    const b = await createItem();
    const res = await request(ctx.app, "POST", "/edges", {
      key,
      body: { source_id: a, target_id: b, edge_type: "about" },
    });
    expect(res.status).toBe(201);
  });

  it("neither-granted member is rejected", async () => {
    const key = await mkKey({}, {});
    const a = await createItem();
    const b = await createItem();
    const res = await request(ctx.app, "POST", "/edges", {
      key,
      body: { source_id: a, target_id: b, edge_type: "about" },
    });
    expect(res.status).toBe(403);
  });

  it("type-only member succeeds on read listings (edges read uses no gate today)", async () => {
    // Reads follow the item-type read permission; edges hydrated on
    // outbound list don't add a second gate.
    const key = await mkKey({ "*": "read" }, {});
    const a = await createItem();
    const res = await request(ctx.app, "GET", `/items/${a}/edges`, {
      key,
    });
    expect(res.status).toBe(200);
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

describe("GET /edges", () => {
  it("rejects unauthenticated", async () => {
    const res = await request(ctx.app, "GET", "/edges");
    expect(res.status).toBe(401);
  });

  it("lists edges of a given type across the space", async () => {
    const tag = `globlist-${String(Math.random()).slice(2, 8)}`;
    const root = await createItem();
    const a = await createItem();
    const b = await createItem();
    // Two parent-of edges off `root`. The `tag` is just a property to
    // identify the edges in this run.
    for (const target of [a, b]) {
      await request(ctx.app, "POST", "/edges", {
        key: ctx.adminKey,
        body: {
          source_id: root,
          target_id: target,
          edge_type: "parent-of",
          properties: { tag },
        },
      });
    }
    // Also create a different-typed edge that should not match the filter.
    const other = await createItem();
    await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: {
        source_id: root,
        target_id: other,
        edge_type: "supersedes",
        properties: { tag },
      },
    });

    const res = await request(
      ctx.app,
      "GET",
      "/edges?edge_type=parent-of&limit=500",
      { key: ctx.adminKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      data: { edge_type: string; properties: Record<string, unknown> }[];
      cursor: string | null;
      has_more: boolean;
    };
    const matching = data.data.filter(
      (e) => (e.properties as { tag?: string }).tag === tag,
    );
    expect(matching).toHaveLength(2);
    for (const edge of matching) {
      expect(edge.edge_type).toBe("parent-of");
    }
  });

  it("rejects edge_type with too many entries", async () => {
    const tooMany = Array.from({ length: 11 }, (_, i) => `t${String(i)}`).join(
      ",",
    );
    const res = await request(ctx.app, "GET", `/edges?edge_type=${tooMany}`, {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(400);
  });

  it("paginates with cursor", async () => {
    // Create more than a small page worth of edges with a unique type so
    // pagination can be reasoned about deterministically.
    const edgeType = "parent-of";
    const root = await createItem();
    const tagged: string[] = [];
    for (let i = 0; i < 6; i++) {
      const child = await createItem();
      const tag = `pag-${String(i)}-${String(Math.random()).slice(2, 6)}`;
      tagged.push(tag);
      await request(ctx.app, "POST", "/edges", {
        key: ctx.adminKey,
        body: {
          source_id: root,
          target_id: child,
          edge_type: edgeType,
          properties: { tag },
        },
      });
    }
    const first = await request(
      ctx.app,
      "GET",
      `/edges?edge_type=${edgeType}&limit=2`,
      { key: ctx.adminKey },
    );
    const firstData = (await first.json()) as {
      data: { properties: Record<string, unknown> }[];
      cursor: string | null;
      has_more: boolean;
    };
    expect(firstData.data.length).toBe(2);
    expect(firstData.has_more).toBe(true);
    expect(firstData.cursor).toBeTruthy();

    const second = await request(
      ctx.app,
      "GET",
      `/edges?edge_type=${edgeType}&limit=2&cursor=${encodeURIComponent(firstData.cursor ?? "")}`,
      { key: ctx.adminKey },
    );
    const secondData = (await second.json()) as {
      data: { properties: Record<string, unknown> }[];
    };
    expect(secondData.data.length).toBe(2);
    // The two pages should not overlap.
    const firstTags = new Set(
      firstData.data.map((e) => (e.properties as { tag?: string }).tag),
    );
    for (const e of secondData.data) {
      expect(firstTags.has((e.properties as { tag?: string }).tag)).toBe(false);
    }
  });
});

describe("PATCH/DELETE /edges/:id — source-type gate on trashed source", () => {
  async function createMemberKey(
    typePermissions: Record<string, "read" | "write" | "none">,
    edgePermissions: Record<string, "read" | "write"> = { "*": "write" },
  ): Promise<string> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: {
        label: `edge-gate-${suffix}`,
        source: `edge-gate-${suffix}`,
        role: "member",
        default_tier: "feed",
        type_permissions: typePermissions,
        extension_permissions: {},
        edge_permissions: edgePermissions,
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { key: string };
    return body.key;
  }

  it("PATCH /edges/:id still gates on source type when the source item is trashed", async () => {
    // Admin creates a source and a target, then an edge between them.
    const sourceId = await createItem("core.note");
    const targetId = await createItem("core.note");
    const createEdge = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: {
        source_id: sourceId,
        target_id: targetId,
        edge_type: "about",
        properties: { note: "v1" },
      },
    });
    const { edge } = (await createEdge.json()) as { edge: { id: string } };

    // Admin trashes the source item.
    const del = await request(ctx.app, "DELETE", `/items/${sourceId}`, {
      key: ctx.adminKey,
    });
    expect(del.status).toBe(200);

    // Restricted credential: no core.note write (read only), but broad edge write.
    const restrictedKey = await createMemberKey(
      { "core.note": "read" },
      { "*": "write" },
    );

    // Previously: storage.items.get() returned null for trashed, so the
    // type gate was silently skipped and PATCH would succeed. Now it
    // must 403.
    const patch = await request(ctx.app, "PATCH", `/edges/${edge.id}`, {
      key: restrictedKey,
      body: { properties: { note: "v2-should-fail" } },
    });
    expect(patch.status).toBe(403);
  });

  it("DELETE /edges/:id still gates on source type when the source item is trashed", async () => {
    const sourceId = await createItem("core.note");
    const targetId = await createItem("core.note");
    const createEdge = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: {
        source_id: sourceId,
        target_id: targetId,
        edge_type: "about",
      },
    });
    const { edge } = (await createEdge.json()) as { edge: { id: string } };

    const del = await request(ctx.app, "DELETE", `/items/${sourceId}`, {
      key: ctx.adminKey,
    });
    expect(del.status).toBe(200);

    const restrictedKey = await createMemberKey(
      { "core.note": "read" },
      { "*": "write" },
    );

    const deleteEdge = await request(ctx.app, "DELETE", `/edges/${edge.id}`, {
      key: restrictedKey,
    });
    expect(deleteEdge.status).toBe(403);

    // Edge must still exist — the gate throws before the delete.
    const listBackrefs = await request(
      ctx.app,
      "GET",
      `/items/${targetId}/backrefs`,
      { key: ctx.adminKey },
    );
    expect(listBackrefs.status).toBe(200);
  });

  it("admin DELETE /edges/:id succeeds when the source is trashed", async () => {
    const sourceId = await createItem("core.note");
    const targetId = await createItem("core.note");
    const createEdge = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: {
        source_id: sourceId,
        target_id: targetId,
        edge_type: "about",
      },
    });
    const { edge } = (await createEdge.json()) as { edge: { id: string } };

    const trash = await request(ctx.app, "DELETE", `/items/${sourceId}`, {
      key: ctx.adminKey,
    });
    expect(trash.status).toBe(200);

    const deleteEdge = await request(ctx.app, "DELETE", `/edges/${edge.id}`, {
      key: ctx.adminKey,
    });
    expect(deleteEdge.status).toBe(200);
  });
});

// On SQLite / RLS-off deployments the application-layer fence is the only
// thing standing between space A and space B's edges on the single-edge
// PATCH/DELETE path. These tests run in hosted mode with two spaces and a
// space-scoped key for space A, then attempt to mutate/delete an edge that
// lives entirely in space B by its id.
describe("Single-edge mutate/delete — cross-space fence", () => {
  let hostedCtx: TestContext;
  let spaceA: string;
  let spaceB: string;
  // Space A's caller (space_admin API key) — the would-be attacker.
  let keyA: string;
  // An edge that lives entirely in space B.
  let spaceBEdgeId: string;
  // Source + target items in space A, for the same-space success cases.
  let aSource: string;
  let aTarget: string;

  beforeAll(async () => {
    hostedCtx = await createTestContext({ authMode: "hosted" });
    const a = await hostedCtx.storage.spaces!.create("space-a");
    const b = await hostedCtx.storage.spaces!.create("space-b");
    spaceA = a.id;
    spaceB = b.id;

    // Mint a space_admin API key bound to space A.
    const rawA = "marfa_k1_a_" + Math.random().toString(36).slice(2);
    await hostedCtx.storage.keys.create(
      {
        label: "space-a-admin",
        source: "space-a-admin",
        role: "space_admin",
        type_permissions: {},
        default_tier: "library",
        is_platform: false,
      },
      hashApiKey(rawA, TEST_API_KEY_SALT),
      spaceA,
    );
    keyA = rawA;

    // Seed space B's items + an edge between them — entirely outside A.
    const bSource = await hostedCtx.storage.items.create(
      { type: "core.note", properties: { body: "b-source" } },
      spaceB,
    );
    const bTarget = await hostedCtx.storage.items.create(
      { type: "core.note", properties: { body: "b-target" } },
      spaceB,
    );
    const bEdge = await hostedCtx.storage.edges.createRaw(
      {
        source_id: bSource.id,
        target_id: bTarget.id,
        edge_type: "about",
      },
      spaceB,
    );
    spaceBEdgeId = bEdge.id;

    // Seed space A's own items for the same-space success cases.
    const aSrc = await hostedCtx.storage.items.create(
      { type: "core.note", properties: { body: "a-source" } },
      spaceA,
    );
    const aTgt = await hostedCtx.storage.items.create(
      { type: "core.note", properties: { body: "a-target" } },
      spaceA,
    );
    aSource = aSrc.id;
    aTarget = aTgt.id;
  });

  afterAll(async () => {
    await hostedCtx.cleanup();
  });

  it("PATCH /edges/:id on another space's edge returns 404 (cloaked)", async () => {
    const res = await request(
      hostedCtx.app,
      "PATCH",
      `/edges/${spaceBEdgeId}`,
      {
        key: keyA,
        body: { properties: { tampered: true } },
      },
    );
    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: { code: string } };
    expect(data.error.code).toBe("edge_not_found");

    // The edge must be untouched — read it back from space B's scope.
    const stillThere = await hostedCtx.storage.edges.get(spaceBEdgeId);
    expect(stillThere).not.toBeNull();
    expect(stillThere?.properties).not.toHaveProperty("tampered");
  });

  it("DELETE /edges/:id on another space's edge returns 404 (cloaked) and does not delete", async () => {
    const res = await request(
      hostedCtx.app,
      "DELETE",
      `/edges/${spaceBEdgeId}`,
      { key: keyA },
    );
    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: { code: string } };
    expect(data.error.code).toBe("edge_not_found");

    // The edge must still exist in space B.
    const stillThere = await hostedCtx.storage.edges.get(spaceBEdgeId);
    expect(stillThere).not.toBeNull();
  });

  it("same-space PATCH /edges/:id still succeeds", async () => {
    const created = await request(hostedCtx.app, "POST", "/edges", {
      key: keyA,
      body: { source_id: aSource, target_id: aTarget, edge_type: "about" },
    });
    expect(created.status).toBe(201);
    const { edge } = (await created.json()) as { edge: { id: string } };

    const res = await request(hostedCtx.app, "PATCH", `/edges/${edge.id}`, {
      key: keyA,
      body: { properties: { note: "mine" } },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      edge: { properties: Record<string, unknown> };
    };
    expect(data.edge.properties.note).toBe("mine");
  });

  it("same-space DELETE /edges/:id still succeeds", async () => {
    // Fresh source/target so we don't collide with the one-to-... edge above.
    const src = await hostedCtx.storage.items.create(
      { type: "core.note", properties: { body: "a-del-source" } },
      spaceA,
    );
    const tgt = await hostedCtx.storage.items.create(
      { type: "core.note", properties: { body: "a-del-target" } },
      spaceA,
    );
    const created = await request(hostedCtx.app, "POST", "/edges", {
      key: keyA,
      body: {
        source_id: src.id,
        target_id: tgt.id,
        edge_type: "references",
      },
    });
    expect(created.status).toBe(201);
    const { edge } = (await created.json()) as { edge: { id: string } };

    const res = await request(hostedCtx.app, "DELETE", `/edges/${edge.id}`, {
      key: keyA,
    });
    expect(res.status).toBe(200);

    // Gone for real.
    const gone = await hostedCtx.storage.edges.get(edge.id);
    expect(gone).toBeNull();
  });
});

describe("an edge conflict names its code in the header", () => {
  it("stamps X-Error-Code on the refusal", async () => {
    const a = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "edge header a" } },
    });
    const b = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "edge header b" } },
    });
    const aId = ((await a.json()) as { item: { id: string } }).item.id;
    const bId = ((await b.json()) as { item: { id: string } }).item.id;

    const created = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: { source_id: aId, target_id: bId, edge_type: "references" },
    });
    expect(created.status).toBe(201);
    const edge = (
      (await created.json()) as {
        edge: { id: string; version: number };
      }
    ).edge;

    // Move it on, so the version below is stale.
    await request(ctx.app, "PATCH", `/edges/${edge.id}`, {
      key: ctx.adminKey,
      body: { properties: { weight: 1 }, version: edge.version },
    });

    const stale = await request(ctx.app, "PATCH", `/edges/${edge.id}`, {
      key: ctx.adminKey,
      body: { properties: { weight: 2 }, version: edge.version },
    });
    expect(stale.status).toBe(409);
    // Returned rather than thrown, so nothing else sets this. Same rule as
    // the item door.
    expect(stale.headers.get("X-Error-Code")).toBe("version_conflict");
  });
});

describe("the edge conflict envelope describes itself", () => {
  it("carries a message, as the item door does", async () => {
    const a = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "edge msg a" } },
    });
    const b = await request(ctx.app, "POST", "/items", {
      key: ctx.adminKey,
      body: { type: "core.note", properties: { body: "edge msg b" } },
    });
    const aId = ((await a.json()) as { item: { id: string } }).item.id;
    const bId = ((await b.json()) as { item: { id: string } }).item.id;

    const created = await request(ctx.app, "POST", "/edges", {
      key: ctx.adminKey,
      body: { source_id: aId, target_id: bId, edge_type: "references" },
    });
    const edge = (
      (await created.json()) as { edge: { id: string; version: number } }
    ).edge;

    await request(ctx.app, "PATCH", `/edges/${edge.id}`, {
      key: ctx.adminKey,
      body: { properties: { weight: 1 }, version: edge.version },
    });
    const stale = await request(ctx.app, "PATCH", `/edges/${edge.id}`, {
      key: ctx.adminKey,
      body: { properties: { weight: 2 }, version: edge.version },
    });
    expect(stale.status).toBe(409);

    const body = (await stale.json()) as {
      error: { code: string; status: number; message: string };
    };
    // An envelope that describes itself on one door and not its sibling is
    // the disagreement a client discovers the hard way.
    expect(body.error.code).toBe("version_conflict");
    expect(body.error.status).toBe(409);
    expect(body.error.message).toContain(String(edge.version));
  });
});
