import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import { subscribe } from "../pubsub.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("POST /items/bulk", () => {
  it("creates items in bulk (upsert default)", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "Bulk test 1" },
            source_id: `bulk-${suffix}-1`,
          },
          {
            type: "core.note",
            properties: { body: "Bulk test 2" },
            source_id: `bulk-${suffix}-2`,
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      counts: {
        created: number;
        updated: number;
        skipped: number;
        errored: number;
      };
      results: { outcome: string; id?: string }[];
    };
    expect(data.counts.created).toBe(2);
    expect(data.counts.updated).toBe(0);
    expect(data.counts.skipped).toBe(0);
    expect(data.counts.errored).toBe(0);
    expect(data.results).toHaveLength(2);
    for (const r of data.results) {
      expect(r.outcome).toBe("created");
      expect(r.id).toBeDefined();
    }
  });

  it("upsert mode updates existing rows matched by (source, source_id)", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const sourceId = `upsert-${suffix}`;

    const first = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "initial" },
            source_id: sourceId,
          },
        ],
      },
    });
    const firstBody = (await first.json()) as {
      results: { id: string }[];
    };
    const originalId = firstBody.results[0]!.id;

    const second = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "updated" },
            source_id: sourceId,
          },
        ],
      },
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as {
      counts: { created: number; updated: number };
      results: { outcome: string; id: string }[];
    };
    expect(body.counts.updated).toBe(1);
    expect(body.counts.created).toBe(0);
    expect(body.results[0]!.id).toBe(originalId);

    const getRes = await request(ctx.app, "GET", `/items/${originalId}`, {
      key: ctx.workingKey,
    });
    const itemBody = (await getRes.json()) as {
      item: { properties: { body: string } };
    };
    expect(itemBody.item.properties.body).toBe("updated");
  });

  it("upsert mode updates existing rows matched by id (no source_id)", async () => {
    // Offline-first clients (Swift / TS SDKs) assign UUIDs locally and
    // expect `mode: upsert` to update by primary id when a row already
    // exists server-side — e.g. migrating a local-mode Notes store whose
    // items were seeded earlier. Before this path existed, the second
    // call fell through to `items.create` and tripped a unique-
    // constraint violation (opaque 500).
    const suffix = Math.random().toString(36).slice(2, 8);

    const first = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "initial by id" },
            // No source_id — exercises the id-only match path.
          },
        ],
      },
    });
    const firstBody = (await first.json()) as {
      results: { id: string }[];
    };
    const assignedId = firstBody.results[0]!.id;

    const second = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        items: [
          {
            id: assignedId,
            type: "core.note",
            properties: { body: `updated by id ${suffix}` },
          },
        ],
      },
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as {
      counts: { created: number; updated: number };
      results: { outcome: string; id: string }[];
    };
    expect(body.counts.updated).toBe(1);
    expect(body.counts.created).toBe(0);
    expect(body.results[0]!.id).toBe(assignedId);

    const getRes = await request(ctx.app, "GET", `/items/${assignedId}`, {
      key: ctx.workingKey,
    });
    const itemBody = (await getRes.json()) as {
      item: { properties: { body: string } };
    };
    expect(itemBody.item.properties.body).toBe(`updated by id ${suffix}`);
  });

  it("create_only mode skips existing rows matched by id with duplicate_id reason", async () => {
    const first = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "seed" },
          },
        ],
      },
    });
    const firstBody = (await first.json()) as {
      results: { id: string }[];
    };
    const assignedId = firstBody.results[0]!.id;

    const second = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        items: [
          {
            id: assignedId,
            type: "core.note",
            properties: { body: "should be skipped" },
          },
        ],
        mode: "create_only",
      },
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as {
      counts: { skipped: number; created: number; updated: number };
      results: { outcome: string; id: string; reason?: string }[];
    };
    expect(body.counts.skipped).toBe(1);
    expect(body.counts.created).toBe(0);
    expect(body.counts.updated).toBe(0);
    expect(body.results[0]!.outcome).toBe("skipped");
    expect(body.results[0]!.id).toBe(assignedId);
    expect(body.results[0]!.reason).toBe("duplicate_id");

    const getRes = await request(ctx.app, "GET", `/items/${assignedId}`, {
      key: ctx.workingKey,
    });
    const itemBody = (await getRes.json()) as {
      item: { properties: { body: string } };
    };
    expect(itemBody.item.properties.body).toBe("seed");
  });

  it("create_only mode skips matching rows without updating", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const sourceId = `createonly-${suffix}`;

    await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "original" },
            source_id: sourceId,
          },
        ],
        mode: "create_only",
      },
    });

    const second = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "should not overwrite" },
            source_id: sourceId,
          },
        ],
        mode: "create_only",
      },
    });
    const body = (await second.json()) as {
      counts: { created: number; skipped: number };
      results: { outcome: string; reason?: string }[];
    };
    expect(body.counts.skipped).toBe(1);
    expect(body.counts.created).toBe(0);
    expect(body.results[0]!.outcome).toBe("skipped");
    expect(body.results[0]!.reason).toBe("duplicate_source");
  });

  it("atomic=true rolls back the whole batch on any error", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const tag = `atomic-${suffix}`;

    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "good" },
            tags: [tag],
            source_id: `atomic-${suffix}-good`,
          },
          {
            // Invalid type identifier — triggers the error path
            type: "NOT a valid type id",
            properties: {},
            tags: [tag],
            source_id: `atomic-${suffix}-bad`,
          },
        ],
        atomic: true,
      },
    });
    expect(res.status).toBe(400);
    const errBody = (await res.json()) as {
      error: { code: string; details?: { index?: number } };
    };
    expect(errBody.error.code).toBe("bulk_atomic_rollback");
    expect(errBody.error.details?.index).toBe(1);

    // Neither item should exist — rollback worked. Query by the
    // shared tag instead of source_id (filter-SQL doesn't project
    // source_id as a queryable field).
    const list = await request(ctx.app, "GET", `/items?tags=${tag}`, {
      key: ctx.workingKey,
    });
    const listBody = (await list.json()) as { data: unknown[] };
    expect(listBody.data).toHaveLength(0);
  });

  it("atomic=false collects errors and continues", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "first" },
            source_id: `ne-${suffix}-1`,
          },
          {
            type: "NOT a valid type",
            properties: {},
            source_id: `ne-${suffix}-bad`,
          },
          {
            type: "core.note",
            properties: { body: "third" },
            source_id: `ne-${suffix}-3`,
          },
        ],
        atomic: false,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      counts: { created: number; errored: number };
      results: { outcome: string; error?: { code: string } }[];
    };
    expect(body.counts.created).toBe(2);
    expect(body.counts.errored).toBe(1);
    expect(body.results[1]!.outcome).toBe("errored");
    expect(body.results[1]!.error?.code).toBe("invalid_type");
  });

  it("accepts inline edges on create", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);

    // Create a target item first
    const targetRes = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.entity",
        properties: { name: "Edge target" },
        source_id: `edge-target-${suffix}`,
      },
    });
    const targetBody = (await targetRes.json()) as { item: { id: string } };
    const targetId = targetBody.item.id;

    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "Has inline edge" },
            source_id: `edge-source-${suffix}`,
            edges: { about: [targetId] },
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { id: string }[] };
    const sourceId = body.results[0]!.id;

    const getRes = await request(
      ctx.app,
      "GET",
      `/items/${sourceId}/edges?edge_type=about`,
      { key: ctx.workingKey },
    );
    const edgesBody = (await getRes.json()) as {
      data: { target_id: string }[];
    };
    expect(edgesBody.data).toHaveLength(1);
    expect(edgesBody.data[0]!.target_id).toBe(targetId);
  });

  it("rejects an inline-edge bulk create that violates cardinality", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const mk = async (label: string): Promise<string> => {
      const res = await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: { type: "core.note", properties: { body: label } },
      });
      const b = (await res.json()) as { item: { id: string } };
      return b.item.id;
    };
    const targetA = await mk(`bulk-card-a-${suffix}`);
    const targetB = await mk(`bulk-card-b-${suffix}`);

    // `supersedes` is one-to-one: two outbound edges from one source breach
    // the cap. atomic (default) → the whole batch rolls back with 400.
    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "bulk inline cardinality" },
            source_id: `bulk-card-src-${suffix}`,
            edges: { supersedes: [targetA, targetB] },
          },
        ],
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bulk_atomic_rollback");
  });

  it("rejects an inline-edge bulk upsert that introduces a parent-of cycle", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);

    // Seed A and B, then make A parent-of B.
    const seed = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "bulk cycle A" },
            source_id: `bulk-cyc-a-${suffix}`,
          },
          {
            type: "core.note",
            properties: { body: "bulk cycle B" },
            source_id: `bulk-cyc-b-${suffix}`,
          },
        ],
      },
    });
    const seedBody = (await seed.json()) as { results: { id: string }[] };
    const aId = seedBody.results[0]!.id;
    const bId = seedBody.results[1]!.id;

    const aParent = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "bulk cycle A parent" },
            source_id: `bulk-cyc-a-${suffix}`,
            edges: { "parent-of": [bId] },
          },
        ],
      },
    });
    expect(aParent.status).toBe(200);

    // Upsert B with parent-of A — closes the cycle. atomic → 400 rollback.
    const bParent = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "bulk cycle B parent" },
            source_id: `bulk-cyc-b-${suffix}`,
            edges: { "parent-of": [aId] },
          },
        ],
      },
    });
    expect(bParent.status).toBe(400);
    const errBody = (await bParent.json()) as { error: { code: string } };
    expect(errBody.error.code).toBe("bulk_atomic_rollback");

    // B's parent-of edges remain empty — the delete rolled back.
    const edgesRes = await request(
      ctx.app,
      "GET",
      `/items/${bId}/edges?edge_type=parent-of`,
      { key: ctx.workingKey },
    );
    const edgesBody = (await edgesRes.json()) as { data: unknown[] };
    expect(edgesBody.data).toHaveLength(0);
  });

  it("surfaces an inline-edge violation per-item in best-effort (atomic=false) mode", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const mk = async (label: string): Promise<string> => {
      const res = await request(ctx.app, "POST", "/items", {
        key: ctx.workingKey,
        body: { type: "core.note", properties: { body: label } },
      });
      const b = (await res.json()) as { item: { id: string } };
      return b.item.id;
    };
    const targetA = await mk(`be-card-a-${suffix}`);
    const targetB = await mk(`be-card-b-${suffix}`);

    // best-effort (atomic=false): the violating item errors, the valid item
    // still lands. The violating item's delete must not leak — validation
    // failure rolls back applyInlineEdges' own transaction.
    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        atomic: false,
        items: [
          {
            type: "core.note",
            properties: { body: "be valid" },
            source_id: `be-valid-${suffix}`,
            edges: { about: [targetA] },
          },
          {
            type: "core.note",
            properties: { body: "be violating" },
            source_id: `be-violating-${suffix}`,
            edges: { supersedes: [targetA, targetB] },
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      counts: { created: number; errored: number };
      results: { outcome: string; error?: { code: string } }[];
    };
    expect(body.counts.created).toBe(1);
    expect(body.counts.errored).toBe(1);
    const errored = body.results.find((r) => r.outcome === "errored");
    expect(errored?.error?.code).toBe("edge_constraint_violation");
  });

  it("caps at MAX_BULK_ITEMS (5000)", async () => {
    const items = Array.from({ length: 5001 }, (_, i) => ({
      type: "core.note",
      properties: { body: `over-cap-${String(i)}` },
    }));
    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: { items },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("admits a credential with write on the item's type (matches POST /items)", async () => {
    // Bulk write authorization mirrors single-item POST /items: a credential
    // holding write on the type can bulk-create it, so the type map is the
    // whole of what decides `core.note`.
    const rawKey = `marfa_k1_scoped_${Math.random().toString(36).slice(2)}`;
    const keyHash = hashApiKey(rawKey, "test-salt");
    await ctx.storage.keys.create(
      {
        label: "bulk-scoped-allowed",
        source: `bulk-scoped-ok-${rawKey.slice(-6)}`,
        type_permissions: { "core.note": "write" },
        is_operator: false,
      },
      keyHash,
    );

    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: rawKey,
      body: {
        items: [{ type: "core.note", properties: { body: "scoped-ok" } }],
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { counts: { created: number } };
    expect(body.counts.created).toBe(1);
  });

  it("rejects a credential without write on the item's type (atomic 400)", async () => {
    // No type_permissions → no writable types. The atomic pre-check aborts
    // the whole batch with bulk_atomic_rollback carrying type_not_permitted.
    const rawKey = `marfa_k1_scoped_${Math.random().toString(36).slice(2)}`;
    const keyHash = hashApiKey(rawKey, "test-salt");
    await ctx.storage.keys.create(
      {
        label: "bulk-scoped-denied",
        source: `bulk-scoped-no-${rawKey.slice(-6)}`,
        type_permissions: {},
        is_operator: false,
      },
      keyHash,
    );

    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: rawKey,
      body: {
        items: [{ type: "core.note", properties: { body: "nope" } }],
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details?: { code?: string } };
    };
    expect(body.error.code).toBe("bulk_atomic_rollback");
    expect(body.error.details?.code).toBe("type_not_permitted");
  });

  it("surfaces a per-item type_not_permitted error in non-atomic mode", async () => {
    const rawKey = `marfa_k1_scoped_${Math.random().toString(36).slice(2)}`;
    const keyHash = hashApiKey(rawKey, "test-salt");
    await ctx.storage.keys.create(
      {
        label: "bulk-scoped-mixed",
        source: `bulk-scoped-mix-${rawKey.slice(-6)}`,
        type_permissions: { "core.note": "write" },
        is_operator: false,
      },
      keyHash,
    );

    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: rawKey,
      body: {
        items: [
          { type: "core.note", properties: { body: "allowed" } },
          { type: "core.task", properties: { title: "denied" } },
        ],
        atomic: false,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      counts: { created: number; errored: number };
      results: { outcome: string; error?: { code: string } }[];
    };
    expect(body.counts.created).toBe(1);
    expect(body.counts.errored).toBe(1);
    expect(body.results[1]!.error?.code).toBe("type_not_permitted");
  });

  it("stamps source from the credential and ignores forged payload source", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const forgedSource = "forged.origin";
    const payloadSourceId = `stamp-${suffix}`;

    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: `stamp test ${suffix}` },
            source: forgedSource,
            source_id: payloadSourceId,
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: { id: string }[];
    };
    const createdId = body.results[0]!.id;

    const getRes = await request(ctx.app, "GET", `/items/${createdId}`, {
      key: ctx.workingKey,
    });
    const item = (await getRes.json()) as {
      item: { source?: string; source_id?: string };
    };
    expect(item.item.source).not.toBe(forgedSource);
    // Against the credential's own `source` rather than a prefix, so the
    // claim is that the stamp came from the caller's row and not that the
    // fixture happens to name its keys a certain way.
    const credential = await ctx.storage.keys.validate(
      hashApiKey(ctx.workingKey, "test-salt"),
    );
    expect(item.item.source).toBe(credential?.source);
    expect(item.item.source_id).toBe(payloadSourceId);
  });

  it("returns an empty-counts shape for an empty items array", async () => {
    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: { items: [] },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      counts: {
        created: number;
        updated: number;
        skipped: number;
        errored: number;
      };
      results: unknown[];
    };
    expect(body.counts).toEqual({
      created: 0,
      updated: 0,
      skipped: 0,
      errored: 0,
    });
    expect(body.results).toEqual([]);
  });
});

/**
 * Whether a bulk write announces itself.
 *
 * It always does, and `enable_fanout` does not change that. The flag
 * decides whether those events also drive outbound work — webhook
 * delivery, integration reactions — and defaults off, because one call
 * here writes thousands of rows.
 *
 * These watch the emitter, which every published event reaches whatever
 * the flag says. What the flag gates sits downstream of it, and the
 * durable half is held in `bulk-reaches-the-log.test.ts`, which reads the
 * event log rather than the bus.
 */
describe("POST /items/bulk — announcing writes", () => {
  const noteBatch = (suffix: string) => [
    {
      type: "core.note",
      properties: { body: "announce 1" },
      source_id: `emit-${suffix}-1`,
    },
    {
      type: "core.note",
      properties: { body: "announce 2" },
      source_id: `emit-${suffix}-2`,
    },
  ];

  /**
   * Starts the listener and returns a promise for the next `count` item ids.
   *
   * The first `next()` is what attaches the emitter listener, and the emitter
   * has no replay buffer, so it has to be in flight before the request that
   * publishes. Awaiting it here instead would block until an event arrived,
   * which is a request that never gets issued and a test that times out.
   */
  const collect = (count: number) => {
    const iter = subscribe()[Symbol.asyncIterator]();
    const ids = (async (): Promise<string[]> => {
      const out: string[] = [];
      while (out.length < count) {
        const next = await iter.next();
        if (next.done) break;
        out.push(next.value.item.id);
      }
      return out;
    })();
    void ids.catch(() => undefined);
    return { ids, close: () => void iter.return(undefined) };
  };

  it("publishes one event per written item when fan-out is asked for", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const stream = collect(2);

    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: { items: noteBatch(suffix), enable_fanout: true },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { id?: string }[] };

    const seen = await stream.ids;
    stream.close();
    expect(seen.slice().sort()).toEqual(
      body.results
        .map((r) => r.id)
        .filter((id): id is string => Boolean(id))
        .sort(),
    );
  });

  it("publishes one event per written item with no flag set", async () => {
    // This asserted silence once. A bulk write that published nothing
    // wrote nothing to the event log either, because publishing is what
    // appends the row — so a five-thousand-row import was invisible to
    // every client rebuilding its state from the stream, permanently.
    //
    // The sentinel technique survives the inversion and is what makes the
    // count exact: the marker is published after the batch, so its arrival
    // proves the batch's own events are all in already. A test asserting
    // "at least two" would pass on a route that published one.
    const suffix = Math.random().toString(36).slice(2, 8);
    const stream = collect(3);

    const quiet = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: { items: noteBatch(suffix) },
    });
    expect(quiet.status).toBe(200);
    const written = (
      (await quiet.json()) as { results: { id?: string }[] }
    ).results
      .map((r) => r.id)
      .filter((id): id is string => Boolean(id));
    expect(written).toHaveLength(2);

    const marker = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        properties: { body: "sentinel" },
        source_id: `emit-${suffix}-sentinel`,
      },
    });
    expect(marker.status).toBe(201);
    const markerId = ((await marker.json()) as { item: { id: string } }).item
      .id;

    const seen = await stream.ids;
    stream.close();
    expect(seen).toEqual([...written, markerId]);
  });
});

describe("POST /items/bulk — a repeated id in create_only", () => {
  /**
   * The bulk contract answers per entry, so the acknowledgement takes the
   * shape this door already has: `skipped` with `duplicate_id`. What was
   * wrong is the lookup behind it, which hid trashed rows — so a repeat
   * landing on a row the user had since deleted fell through to `create`,
   * tripped the primary key, and (since `atomic` defaults to true) rolled
   * the whole batch back for a write the server had already performed.
   */
  it("is skipped rather than rolling the batch back, even when trashed", async () => {
    const seed = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { body: "seeded" } },
    });
    expect(seed.status).toBe(201);
    const id = ((await seed.json()) as { item: { id: string } }).item.id;
    expect(
      (
        await request(ctx.app, "DELETE", `/items/${id}`, {
          key: ctx.workingKey,
        })
      ).status,
    ).toBe(200);

    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        mode: "create_only",
        items: [
          { type: "core.note", id, properties: { body: "the repeat" } },
          { type: "core.note", properties: { body: "a genuine create" } },
        ],
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: { index: number; outcome: string; reason?: string }[];
      counts: { created: number; skipped: number; errored: number };
    };
    expect(body.results[0]?.outcome).toBe("skipped");
    expect(body.results[0]?.reason).toBe("duplicate_id");
    // And the batch was not rolled back: the sibling entry landed.
    expect(body.results[1]?.outcome).toBe("created");
    expect(body.counts.errored).toBe(0);
  });
});
