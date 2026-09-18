import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import { SPACE_PERMISSIONS } from "@withmarfa/shared";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("POST /items", () => {
  it("creates an item with valid properties", async () => {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "Hello world", title: "Test" },
      },
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as {
      item: Record<string, unknown>;
      metadata: unknown;
    };
    expect(data.item.type).toBe("core.note");
    expect(data.item.version).toBe(1);
    expect(data.item.state).toBe("active");
    expect(data.item).toHaveProperty("id");
    expect(data).toHaveProperty("metadata");
  });

  it("rejects missing required field", async () => {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "core.note", properties: { title: "No body" } },
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unregistered type with unknown_type", async () => {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "zzz.totally.unregistered", properties: { foo: "bar" } },
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: { code: string } };
    expect(data.error.code).toBe("unknown_type");
  });

  it("rejects an empty properties object that omits a required field", async () => {
    // An empty `{}` must run the same required-field validation as a
    // partially-filled body — a core.note with no `body` is invalid either way.
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "core.note", properties: {} },
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: { code: string } };
    expect(data.error.code).toBe("invalid_properties");
  });

  it("rejects a null byte in a string property with a 400, never a 500", async () => {
    // A U+0000 null byte is refused at the validation layer; without the
    // guard it reaches the driver and surfaces as a 500.
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "core.note", properties: { body: "a\u0000b" } },
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: { code: string } };
    expect(data.error.code).toBe("invalid_properties");
  });

  it("round-trips emoji, RTL, accents, newlines, and tabs byte-identically", async () => {
    // Only U+0000 is rejected; every other control character and higher
    // Unicode codepoint must survive the write unchanged.
    const body = "emoji 😀 rtl ‮ accent é em—dash\ttab\nnewline";
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "core.note", properties: { body } },
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { item: { id: string } };
    const fetched = await request(ctx.app, "GET", `/items/${data.item.id}`, {
      key: ctx.spaceKey,
    });
    const fetchedData = (await fetched.json()) as {
      item: { properties: { body: string } };
    };
    expect(fetchedData.item.properties.body).toBe(body);
  });

  it("rejects request without auth", async () => {
    const res = await request(ctx.app, "POST", "/items", {
      body: { type: "core.note", properties: { body: "Test" } },
    });
    expect(res.status).toBe(401);
  });

  it("stores tags in metadata (entity references live on edges)", async () => {
    const target = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "core.note", properties: { body: "target" } },
    });
    const targetData = (await target.json()) as { item: { id: string } };
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "Tagged" },
        tags: ["reading", "important"],
        edges: { about: [targetData.item.id] },
      },
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as {
      item: {
        edges?: Record<string, { edges: { target_id: string }[] }>;
      };
      metadata: { tags: string[] };
    };
    expect(data.metadata.tags).toEqual(["reading", "important"]);
    expect(data.item.edges?.about?.edges.length).toBe(1);
    expect(data.item.edges?.about?.edges[0]?.target_id).toBe(
      targetData.item.id,
    );
  });

  it("natural-key upsert: re-POST with same (source, source_id) updates in place", async () => {
    const first = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "First" },
        source_id: "natural-key-1",
      },
    });
    expect(first.status).toBe(201);
    const firstData = (await first.json()) as {
      item: { id: string; version: number };
    };

    const second = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "Second" },
        source_id: "natural-key-1",
      },
    });
    // 200 (not 201) signals the realized effect was an update via natural-key
    // match, not a fresh create.
    expect(second.status).toBe(200);
    const secondData = (await second.json()) as {
      item: { id: string; version: number; properties: { body?: string } };
    };
    // Same row, version incremented, properties merged.
    expect(secondData.item.id).toBe(firstData.item.id);
    expect(secondData.item.version).toBe(firstData.item.version + 1);
    expect(secondData.item.properties.body).toBe("Second");

    // Whole-batch retry shape: a third POST is also idempotent — no new row
    // is created, the existing row keeps being updated. This is the contract
    // inbound integration handlers (rss-watcher / Calendar) rely on to recover
    // from createItem-success / cursor-write-fail without producing duplicates.
    const third = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "Third" },
        source_id: "natural-key-1",
      },
    });
    expect(third.status).toBe(200);
    const thirdData = (await third.json()) as { item: { id: string } };
    expect(thirdData.item.id).toBe(firstData.item.id);

    // Audit row records the realized effect (`item.update`) and flags the
    // idempotent provenance so operators can spot natural-key re-syncs.
    const auditRes = await request(ctx.app, "GET", "/audit?limit=20", {
      key: ctx.spaceKey,
    });
    const auditData = (await auditRes.json()) as {
      data: {
        action: string;
        details?: { idempotent?: boolean; source_id?: string };
      }[];
    };
    const idempotentEntry = auditData.data.find(
      (e) => e.details?.idempotent === true,
    );
    expect(idempotentEntry).toBeDefined();
    expect(idempotentEntry?.action).toBe("item.update");
    expect(idempotentEntry?.details?.source_id).toBe("natural-key-1");
  });

  it("natural-key upsert: source_id absent → create path unchanged", async () => {
    // Two POSTs with no source_id → two distinct rows, both 201.
    const first = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "core.note", properties: { body: "no-key A" } },
    });
    const second = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "core.note", properties: { body: "no-key B" } },
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstData = (await first.json()) as { item: { id: string } };
    const secondData = (await second.json()) as { item: { id: string } };
    expect(firstData.item.id).not.toBe(secondData.item.id);
  });

  it("natural-key upsert: explicit `id` mismatching the resolved row is rejected", async () => {
    // First POST creates the row with a generated id; the natural key lives on
    // (source, source_id). A subsequent POST that explicitly carries a
    // different `id` along with the same source_id should not silently win
    // with the existing row's id — that would surprise the caller.
    const first = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "First" },
        source_id: "id-mismatch-key",
      },
    });
    expect(first.status).toBe(201);

    const conflicting = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "Conflicting id" },
        source_id: "id-mismatch-key",
        id: "019df7d6-0000-7000-8000-000000000000",
      },
    });
    expect(conflicting.status).toBe(400);
    const errBody = (await conflicting.json()) as {
      error: { code: string };
    };
    expect(errBody.error.code).toBe("validation_error");
  });

  it("natural-key upsert: source_id under different sources do not collide", async () => {
    // The upsert is keyed on (source, source_id). Different credentials with
    // different stamped sources but matching source_id values must produce
    // distinct rows. The test admin's source is `test-admin-<suffix>`; we
    // mint a second key with a different `source` to exercise the boundary.
    const altKeyRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.spaceKey,
      body: {
        label: "alt-source",
        source: "alt-source",
        // The map is named because nothing is implied: the rank that used to
        // reach every type regardless is gone, and the boundary under test is
        // the stamped `source`, not the reach.
        type_permissions: { "core.note": "write" },
      },
    });
    const altKey = (await altKeyRes.json()) as { key: string };

    const first = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "Admin source" },
        source_id: "shared-key",
      },
    });
    const second = await request(ctx.app, "POST", "/items", {
      key: altKey.key,
      body: {
        type: "core.note",
        properties: { body: "Alt source" },
        source_id: "shared-key",
      },
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstData = (await first.json()) as { item: { id: string } };
    const secondData = (await second.json()) as { item: { id: string } };
    expect(firstData.item.id).not.toBe(secondData.item.id);
  });
});

describe("natural-key upsert: inline edges are validated", () => {
  // The upsert short-circuit reconciles edges via applyInlineEdges. That path
  // must run the same edge validation as the create path — a re-sync that
  // introduces a cardinality / type-constraint violation or a graph cycle is
  // rejected, matching POST /items create.

  async function createNote(body: string): Promise<string> {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "core.note", properties: { body } },
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { item: { id: string } };
    return data.item.id;
  }

  it("rejects an inline-edge upsert that violates one-to-one cardinality", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const targetA = await createNote(`one-to-one target A ${suffix}`);
    const targetB = await createNote(`one-to-one target B ${suffix}`);

    // Establish the row via natural key first.
    const first = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "card-source" },
        source_id: `card-${suffix}`,
      },
    });
    expect(first.status).toBe(201);

    // `supersedes` is one-to-one: two outbound edges of it from one source
    // breach the source-side cap. The create path rejects this; the upsert
    // path must too.
    const second = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "card-source updated" },
        source_id: `card-${suffix}`,
        edges: { supersedes: [targetA, targetB] },
      },
    });
    expect(second.status).toBe(400);
    const errBody = (await second.json()) as { error: { code: string } };
    expect(errBody.error.code).toBe("edge_constraint_violation");

    // The rejected upsert left no edges behind — the delete rolled back.
    const firstData = (await first.json()) as { item: { id: string } };
    const edgesRes = await request(
      ctx.app,
      "GET",
      `/items/${firstData.item.id}/edges?edge_type=supersedes`,
      { key: ctx.spaceKey },
    );
    const edgesBody = (await edgesRes.json()) as { data: unknown[] };
    expect(edgesBody.data).toHaveLength(0);
  });

  it("rejects an inline-edge upsert that introduces a parent-of cycle", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);

    // Two natural-key rows, A and B.
    const aRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "cycle A" },
        source_id: `cycle-a-${suffix}`,
      },
    });
    expect(aRes.status).toBe(201);
    const a = (await aRes.json()) as { item: { id: string } };

    const bRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "cycle B" },
        source_id: `cycle-b-${suffix}`,
      },
    });
    expect(bRes.status).toBe(201);
    const b = (await bRes.json()) as { item: { id: string } };

    // Upsert A with parent-of B (A is parent of B).
    const aParentB = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "cycle A is parent" },
        source_id: `cycle-a-${suffix}`,
        edges: { "parent-of": [b.item.id] },
      },
    });
    expect(aParentB.status).toBe(200);

    // Now upsert B with parent-of A — closes the cycle A -> B -> A.
    const bParentA = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "cycle B is parent" },
        source_id: `cycle-b-${suffix}`,
        edges: { "parent-of": [a.item.id] },
      },
    });
    expect(bParentA.status).toBe(400);
    const errBody = (await bParentA.json()) as { error: { code: string } };
    expect(errBody.error.code).toBe("edge_cycle");

    // B's parent-of edges are untouched — the delete rolled back.
    const edgesRes = await request(
      ctx.app,
      "GET",
      `/items/${b.item.id}/edges?edge_type=parent-of`,
      { key: ctx.spaceKey },
    );
    const edgesBody = (await edgesRes.json()) as { data: unknown[] };
    expect(edgesBody.data).toHaveLength(0);
  });

  it("accepts a valid inline-edge upsert", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const targetA = await createNote(`valid target A ${suffix}`);
    const targetB = await createNote(`valid target B ${suffix}`);

    const first = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "valid-source" },
        source_id: `valid-${suffix}`,
        edges: { about: [targetA] },
      },
    });
    expect(first.status).toBe(201);
    const firstData = (await first.json()) as { item: { id: string } };

    // Re-sync with a different valid target set — replace-by-edge-type.
    const second = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "valid-source updated" },
        source_id: `valid-${suffix}`,
        edges: { about: [targetA, targetB] },
      },
    });
    expect(second.status).toBe(200);

    const edgesRes = await request(
      ctx.app,
      "GET",
      `/items/${firstData.item.id}/edges?edge_type=about`,
      { key: ctx.spaceKey },
    );
    const edgesBody = (await edgesRes.json()) as {
      data: { target_id: string }[];
    };
    expect(edgesBody.data).toHaveLength(2);
    const targets = edgesBody.data.map((e) => e.target_id).sort();
    expect(targets).toEqual([targetA, targetB].sort());
  });
});

describe("null on an optional property is treated as unset", () => {
  // Serializers routinely emit `null` for an absent value rather than omitting
  // the key. An optional property sent as `null` must be ignored (the field
  // ends up unset), not rejected as a type error. A required field sent as
  // `null` still rejects. Applies on create, PATCH, and bulk upsert.

  it("create: optional fields sent as null → 201 with those fields absent", async () => {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.bookmark",
        properties: {
          url: "https://example.com",
          title: null,
          image_url: null,
        },
      },
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as {
      item: { properties: Record<string, unknown> };
    };
    expect("title" in data.item.properties).toBe(false);
    expect("image_url" in data.item.properties).toBe(false);
    expect(data.item.properties.url).toBe("https://example.com");
  });

  it("create: a required field sent as null still rejects with 400", async () => {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "core.note", properties: { body: null } },
    });
    expect(res.status).toBe(400);
  });

  it("PATCH: optional field sent as null does not overwrite the stored value", async () => {
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.bookmark",
        properties: { url: "https://example.com", title: "Original" },
      },
    });
    const { item } = (await created.json()) as { item: { id: string } };

    const res = await request(ctx.app, "PATCH", `/items/${item.id}`, {
      key: ctx.spaceKey,
      body: { properties: { title: null } },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      item: { properties: Record<string, unknown> };
    };
    // null is "leave unset" — the previously-stored title survives.
    expect(data.item.properties.title).toBe("Original");
  });

  it("bulk upsert: optional fields sent as null → created with those fields absent", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.spaceKey,
      body: {
        items: [
          {
            type: "core.bookmark",
            properties: {
              url: "https://example.com",
              title: null,
              image_url: null,
            },
            source_id: `null-bulk-${suffix}`,
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      counts: { created: number; errored: number };
      results: { id?: string; outcome: string }[];
    };
    expect(data.counts.created).toBe(1);
    expect(data.counts.errored).toBe(0);
    const id = data.results[0]?.id;
    expect(id).toBeDefined();
    const fetched = await request(ctx.app, "GET", `/items/${id!}`, {
      key: ctx.spaceKey,
    });
    const fetchedData = (await fetched.json()) as {
      item: { properties: Record<string, unknown> };
    };
    expect("title" in fetchedData.item.properties).toBe(false);
    expect("image_url" in fetchedData.item.properties).toBe(false);
  });
});

describe("POST /items — the operator gate", () => {
  it("rejects a space credential writing system.* even with explicit type_permissions", async () => {
    // Only operator credentials may write `system.*` or `marfa.*`, and the
    // fence stands ahead of the type map: naming the literal does not open
    // it. Reads are unrestricted.
    const spaceKey = "marfa_k1_test_space_bound";
    await ctx.storage.keys.create(
      {
        label: "space-bound-not-operator",
        source: "space-bound-not-operator",
        space_permissions: [...SPACE_PERMISSIONS],
        type_permissions: { "system.connection": "write" },
        default_tier: "library",
        is_operator: false,
      },
      hashApiKey(spaceKey, TEST_API_KEY_SALT),
      "space-x",
    );

    const res = await request(ctx.app, "POST", "/items", {
      key: spaceKey,
      body: {
        type: "system.connection",
        properties: {
          kind: "app",
          client_id: "x",
          scopes: [],
          status: "active",
          granted_at: new Date().toISOString(),
        },
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.message).toMatch(/operator key/i);
    expect(body.error.message).toMatch(/system/);
  });

  it("stops the operator key at its own map rather than at the fence", async () => {
    // The positive arm of the gate, and it reaches no row. `is_operator` is
    // exactly what the fence asks for, so the operator key clears it — and is
    // then refused by its own type map, which the one unauthenticated mint
    // forces empty. Nothing writes a reserved row through a credential now,
    // which is why the platform's own machinery writes these rows through the
    // storage layer instead.
    //
    // The two refusals are told apart by what they name: the fence names the
    // namespace and this one names the type. Asserting the status alone would
    // pass against a gate that had started refusing the operator tier too.
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.operatorKey,
      body: {
        type: "system.connection",
        properties: {
          kind: "app",
          client_id: "platform-write-ok",
          scopes: [],
          status: "active",
          granted_at: new Date().toISOString(),
        },
      },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.message).not.toMatch(/operator key/i);
    expect(body.error.message).toContain("system.connection");
  });

  it("refuses the same exact literal on a credential that is not runtime-minted", async () => {
    // The admit rides the manifest projection, and only runtime mints
    // project. A hand-minted key naming the literal does not
    // carry the platform's declaration and stays outside the fence.
    const humanKey = "marfa_k1_test_human_marfa_literal";
    await ctx.storage.keys.create(
      {
        label: "human-marfa-literal",
        source: "human-marfa-literal",
        type_permissions: { "marfa.captured_email": "write" },
      },
      hashApiKey(humanKey, TEST_API_KEY_SALT),
      "space-x",
    );
    const res = await request(ctx.app, "POST", "/items", {
      key: humanKey,
      body: {
        type: "marfa.captured_email",
        properties: {
          from_address: "sender@example.com",
          to_address: "inbox@example.com",
        },
      },
    });
    expect(res.status).toBe(403);
  });

  it("does not gate reads to system.* (a space credential lists its own system.connection rows)", async () => {
    // Reads to reserved-namespace items are unrestricted (filtered by
    // space scoping at the storage layer); only writes need
    // is_operator.
    const spaceReaderKey = "marfa_k1_test_space_reader";
    await ctx.storage.keys.create(
      {
        label: "space-reader",
        source: "space-reader",
        space_permissions: [...SPACE_PERMISSIONS],
        type_permissions: { "system.connection": "read" },
        default_tier: "library",
        is_operator: false,
      },
      hashApiKey(spaceReaderKey, TEST_API_KEY_SALT),
      "space-x",
    );
    const res = await request(ctx.app, "GET", "/items?type=system.connection", {
      key: spaceReaderKey,
    });
    expect(res.status).toBe(200);
  });
});

describe("GET /items/:id", () => {
  it("returns item with metadata", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "core.note", properties: { body: "Get test" } },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    const res = await request(ctx.app, "GET", `/items/${created.item.id}`, {
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data).toHaveProperty("item");
    expect(data).toHaveProperty("metadata");
  });

  it("returns 404 for non-existent item", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/items/019537a0-7b80-7000-8000-000000000000",
      {
        key: ctx.spaceKey,
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 for trashed item", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "core.note", properties: { body: "Will trash" } },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    await request(ctx.app, "DELETE", `/items/${created.item.id}`, {
      key: ctx.spaceKey,
    });

    const res = await request(ctx.app, "GET", `/items/${created.item.id}`, {
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /items", () => {
  it("lists items with pagination", async () => {
    const res = await request(ctx.app, "GET", "/items?limit=2", {
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data).toHaveProperty("data");
    expect(data).toHaveProperty("has_more");
    expect(data).toHaveProperty("cursor");
  });

  it("filters by type", async () => {
    const res = await request(ctx.app, "GET", "/items?type=core.note", {
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { data: { type: string }[] };
    for (const item of data.data) {
      expect(item.type).toBe("core.note");
    }
  });

  it("filters by tags", async () => {
    await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "Tag test" },
        tags: ["filter-test"],
      },
    });

    const res = await request(ctx.app, "GET", "/items?tags=filter-test", {
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { data: unknown[] };
    expect(data.data.length).toBeGreaterThanOrEqual(1);
  });
});

describe("PATCH /items/:id — retype", () => {
  /**
   * Moving an item between types, which every other write door refuses.
   *
   * It exists for one job: bringing a corpus written under one shape onto
   * the shape a person's mapping now names. Without it a mapping applies
   * to what arrives next and everything already there is stranded under
   * the old type, which no amount of re-syncing repairs.
   */
  async function entity(ctx: TestContext): Promise<string> {
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.entity",
        properties: { name: "Ada", kind: "person" },
      },
    });
    const { item } = (await created.json()) as { item: { id: string } };
    return item.id;
  }

  it("moves the item to the type asked for", async () => {
    const id = await entity(ctx);
    const res = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.spaceKey,
      body: {
        retype: true,
        type: "core.bookmark",
        properties_mode: "replace",
        properties: { url: "https://example.com", title: "Ada" },
      },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { item: { type: string } };
    expect(data.item.type).toBe("core.bookmark");

    // And it reads back as the new type rather than only reporting it.
    const after = await request(ctx.app, "GET", `/items/${id}`, {
      key: ctx.spaceKey,
    });
    const read = (await after.json()) as {
      item: { type: string; properties: Record<string, unknown> };
    };
    expect(read.item.type).toBe("core.bookmark");
    expect(read.item.properties).not.toHaveProperty("name");
  });

  it("still refuses a differing type when nobody asked to re-type", async () => {
    // The control, and the one that matters most. The fleet sends a type
    // on nearly every reactive update, so a route that re-typed whenever
    // the two disagreed would move a corpus on an ordinary sync bug.
    const id = await entity(ctx);
    const res = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.spaceKey,
      body: { type: "core.bookmark", properties: { title: "Ada" } },
    });
    expect(res.status).toBe(409);
    const after = await request(ctx.app, "GET", `/items/${id}`, {
      key: ctx.spaceKey,
    });
    const read = (await after.json()) as { item: { type: string } };
    expect(read.item.type).toBe("core.entity");
  });

  it("refuses a re-type that names no destination", async () => {
    const id = await entity(ctx);
    const res = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.spaceKey,
      body: { retype: true, properties: { name: "Ada" } },
    });
    // The code as well as the status. Five sites in this handler answer
    // 400, so a bare status assertion passes whichever one fired — and a
    // refusal produced by a guard other than the one under test is a
    // green that covers nothing.
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.message).toContain("retype");
  });

  it("refuses a move into a type the credential cannot write", async () => {
    // Write on the type being LEFT is not enough. A credential that may
    // write entities and not bookmarks must not be able to turn one into
    // the other, or the type map stops bounding what it can produce.
    //
    // The narrow key is the point: `ctx.spaceKey` holds `"*": "write"`, so
    // every other case in this block is silent about the permission the
    // route checks.
    const id = await entity(ctx);
    const scopedRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.spaceKey,
      body: {
        label: "entities-only",
        source: "entities-only",
        type_permissions: { "core.entity": "write" },
      },
    });
    const scoped = (await scopedRes.json()) as { key: string };

    const res = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: scoped.key,
      body: {
        retype: true,
        type: "core.bookmark",
        properties_mode: "replace",
        properties: { url: "https://example.com", title: "Ada" },
      },
    });
    // The type gate refusing, rather than the key failing to authenticate
    // — a mistyped fixture answers 401 and looks like a pass from here.
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("type_not_permitted");

    const after = await request(ctx.app, "GET", `/items/${id}`, {
      key: ctx.spaceKey,
    });
    const read = (await after.json()) as { item: { type: string } };
    expect(read.item.type).toBe("core.entity");
  });

  it("admits a move by a credential that may write both types", async () => {
    // The permissive direction, which no mutation can reach. A check that
    // refused every caller would satisfy the refusal case beside this one
    // and break the door completely, and removing code only ever makes a
    // guard more permissive — so the only thing that catches an
    // over-broad guard is asserting what must still be allowed.
    const id = await entity(ctx);
    const scopedRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.spaceKey,
      body: {
        label: "both-types",
        source: "both-types",
        type_permissions: {
          "core.entity": "write",
          "core.bookmark": "write",
        },
      },
    });
    const scoped = (await scopedRes.json()) as { key: string };

    const res = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: scoped.key,
      body: {
        retype: true,
        type: "core.bookmark",
        properties_mode: "replace",
        properties: { url: "https://example.com", title: "Ada" },
      },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { item: { type: string } };
    expect(data.item.type).toBe("core.bookmark");
  });

  it("refuses a move whose result the destination calls invalid", async () => {
    // Validated against the type being entered rather than the one being
    // left, which is the whole hazard of moving a corpus: `core.file`
    // requires fields `core.entity` knows nothing about.
    const id = await entity(ctx);
    const res = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.spaceKey,
      body: {
        retype: true,
        type: "core.file",
        properties_mode: "replace",
        properties: { name: "Ada" },
      },
    });
    // `invalid_properties` specifically: this has to be the destination
    // type refusing the shape, not the body failing an earlier check.
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_properties");

    const after = await request(ctx.app, "GET", `/items/${id}`, {
      key: ctx.spaceKey,
    });
    const read = (await after.json()) as { item: { type: string } };
    // Refused rather than half-applied: the type did not move either.
    expect(read.item.type).toBe("core.entity");
  });
});

describe("PATCH /items/:id — properties_mode", () => {
  /**
   * A caller that means the set it sends to BE the item's properties, rather
   * than to be laid over them.
   *
   * The clearing itself was reachable before this, but only by naming every
   * field to be removed — which puts the type's shape into every call site
   * and leaves the next one written from scratch with nothing. Nine such
   * lists were about to be hand-maintained across the integration estate,
   * which is the every-caller-must-remember shape rather than one mechanism.
   */
  async function bookmark(ctx: TestContext): Promise<string> {
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.bookmark",
        properties: {
          url: "https://example.com",
          title: "Original",
          description: "set by the family shape",
        },
      },
    });
    const { item } = (await created.json()) as { item: { id: string } };
    return item.id;
  }

  it("replaces the property set, so an unnamed field is gone", async () => {
    const id = await bookmark(ctx);
    const res = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.spaceKey,
      body: {
        properties_mode: "replace",
        properties: { url: "https://example.com", title: "Mapped" },
      },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      item: { properties: Record<string, unknown> };
    };
    expect(data.item.properties.title).toBe("Mapped");
    expect(data.item.properties).not.toHaveProperty("description");
  });

  it("still merges when nothing asks otherwise", async () => {
    // The control. Without it a replace that had become the default would
    // pass the case above and take every existing caller with it.
    const id = await bookmark(ctx);
    const res = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.spaceKey,
      body: { properties: { title: "Merged" } },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      item: { properties: Record<string, unknown> };
    };
    expect(data.item.properties.title).toBe("Merged");
    expect(data.item.properties.description).toBe("set by the family shape");
  });

  it("merges when asked to merge, which is the same thing said aloud", async () => {
    const id = await bookmark(ctx);
    const res = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.spaceKey,
      body: { properties_mode: "merge", properties: { title: "Merged" } },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      item: { properties: Record<string, unknown> };
    };
    expect(data.item.properties.description).toBe("set by the family shape");
  });

  it("refuses a replace that drops a field the type requires", async () => {
    // The property that makes this safe to hand an integration: a replace is
    // validated like any other write, so it cannot quietly produce a row the
    // type says is invalid. `core.entity` requires `name`, and this replace
    // does not name it.
    const created = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.entity",
        properties: { name: "Ada", kind: "person" },
      },
    });
    const { item } = (await created.json()) as { item: { id: string } };

    const res = await request(ctx.app, "PATCH", `/items/${item.id}`, {
      key: ctx.spaceKey,
      body: { properties_mode: "replace", properties: { kind: "person" } },
    });
    // The type refusing the resulting shape, rather than any of the other
    // four guards in this handler that also answer 400.
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_properties");

    const after = await request(ctx.app, "GET", `/items/${item.id}`, {
      key: ctx.spaceKey,
    });
    const data = (await after.json()) as {
      item: { properties: Record<string, unknown> };
    };
    // Refused rather than half-applied.
    expect(data.item.properties.name).toBe("Ada");
  });

  it("keeps the version check, so a replace cannot skip a conflict", async () => {
    const id = await bookmark(ctx);
    const res = await request(ctx.app, "PATCH", `/items/${id}`, {
      key: ctx.spaceKey,
      body: {
        properties_mode: "replace",
        version: 0,
        properties: { url: "https://example.com", title: "Stale" },
      },
    });
    expect(res.status).toBe(409);
  });
});

describe("PATCH /items/:id", () => {
  it("updates properties and returns wrapped { item, metadata }", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "Original", title: "Test" },
      },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    const res = await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.spaceKey,
      body: { properties: { title: "Updated" }, version: 1 },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      item: { version: number; properties: Record<string, unknown> };
      metadata: unknown;
    };
    expect(data.item.version).toBe(2);
    expect(data.item.properties.title).toBe("Updated");
    expect(data.item.properties.body).toBe("Original");
    expect(data).toHaveProperty("metadata");
  });

  it("returns 409 on conflicting field update", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "Base", title: "Base title" },
      },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.spaceKey,
      body: { properties: { title: "Server update" }, version: 1 },
    });

    const res = await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.spaceKey,
      body: { properties: { title: "Client update" }, version: 1 },
    });
    expect(res.status).toBe(409);
    const conflict = (await res.json()) as Record<string, unknown>;
    expect(conflict).toHaveProperty("conflicting_fields");
    expect(conflict).toHaveProperty("current");
    expect(conflict).toHaveProperty("ancestor");
    expect(conflict).toHaveProperty("merge_policy");
    const policy = conflict.merge_policy as {
      fields?: Record<string, string>;
      default?: string;
    };
    expect(policy.fields?.body).toBe("keep_both_copies");
    expect(policy.fields?.notes).toBe("keep_both_copies");
    expect(policy.default).toBe("last_writer_wins");
  });

  it("auto-merges non-conflicting field updates", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "Base body", title: "Base title" },
      },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.spaceKey,
      body: { properties: { title: "Server title" }, version: 1 },
    });

    const res = await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.spaceKey,
      body: { properties: { body: "Client body" }, version: 1 },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      item: { properties: Record<string, unknown> };
    };
    expect(data.item.properties.title).toBe("Server title");
    expect(data.item.properties.body).toBe("Client body");
  });

  it("returns 409 for version 0 (not 400)", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "core.note", properties: { body: "test" } },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    const res = await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.spaceKey,
      body: { properties: { body: "updated" }, version: 0 },
    });
    expect(res.status).toBe(409);
  });

  it("flips tier: feed → library on PATCH", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "feed" },
        tier: "feed",
      },
    });
    const created = (await createRes.json()) as {
      item: { id: string; tier: "library" | "feed" };
    };
    expect(created.item.tier).toBe("feed");

    const res = await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.spaceKey,
      body: { tier: "library" },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { item: { tier: "library" | "feed" } };
    expect(data.item.tier).toBe("library");
  });

  it("flips tier: library → feed on PATCH", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "library" },
        tier: "library",
      },
    });
    const created = (await createRes.json()) as { item: { id: string } };
    const res = await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.spaceKey,
      body: { tier: "feed" },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { item: { tier: "library" | "feed" } };
    expect(data.item.tier).toBe("feed");
  });

  it("tier-only PATCH (no properties) succeeds and bumps version", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "core.note", properties: { body: "x" }, tier: "feed" },
    });
    const created = (await createRes.json()) as {
      item: { id: string; version: number };
    };
    const res = await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.spaceKey,
      body: { tier: "library" },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      item: { tier: "library" | "feed"; version: number };
    };
    expect(data.item.tier).toBe("library");
    expect(data.item.version).toBe(created.item.version + 1);
  });

  it("PATCH with tier + properties applies both", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "before" },
        tier: "feed",
      },
    });
    const created = (await createRes.json()) as { item: { id: string } };
    const res = await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.spaceKey,
      body: { properties: { body: "after" }, tier: "library" },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      item: { tier: "library" | "feed"; properties: Record<string, unknown> };
    };
    expect(data.item.tier).toBe("library");
    expect(data.item.properties.body).toBe("after");
  });

  it("PATCH with no body fields returns 400", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "core.note", properties: { body: "x" } },
    });
    const created = (await createRes.json()) as { item: { id: string } };
    const res = await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.spaceKey,
      body: {},
    });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /items/:id — source_id mutation", () => {
  it("happy path: PATCH source_id updates the natural key + findBySourceId returns it", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "rename me" },
        source_id: "path/to/old-name.md",
      },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    const res = await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.spaceKey,
      body: { source_id: "path/to/new-name.md" },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { item: { source_id?: string } };
    expect(data.item.source_id).toBe("path/to/new-name.md");

    // findBySourceId now returns this item under the new key. The lookup is
    // space + source scoped — read it back via the GET-by-source path.
    const reread = await request(ctx.app, "GET", `/items/${created.item.id}`, {
      key: ctx.spaceKey,
    });
    const rereadData = (await reread.json()) as {
      item: { id: string; source_id?: string };
    };
    expect(rereadData.item.source_id).toBe("path/to/new-name.md");
  });

  it("collision: PATCH source_id to a value already used by another item under the same source → 409 source_id_conflict", async () => {
    // Two items under the same credential (same stamped source).
    const occupant = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "occupant" },
        source_id: "occupied-key",
      },
    });
    const mover = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "mover" },
        source_id: "mover-key",
      },
    });
    expect(occupant.status).toBe(201);
    expect(mover.status).toBe(201);
    const moverData = (await mover.json()) as { item: { id: string } };

    const res = await request(ctx.app, "PATCH", `/items/${moverData.item.id}`, {
      key: ctx.spaceKey,
      body: { source_id: "occupied-key" },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(body.error.code).toBe("source_id_conflict");
    expect(body.error.details?.source_id).toBe("occupied-key");
  });

  it("idempotent no-op: PATCH source_id to the value already held → 200, value unchanged", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "idempotent" },
        source_id: "stable-key",
      },
    });
    const created = (await createRes.json()) as {
      item: { id: string; version: number };
    };

    const res = await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.spaceKey,
      body: { source_id: "stable-key" },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      item: { source_id?: string; version: number };
    };
    expect(data.item.source_id).toBe("stable-key");
    // Update path still bumps version (a source_id PATCH is a column-set
    // change like tier/timestamp). The route doesn't short-circuit on
    // "same value" — only the conflict check is suppressed. Behavior
    // matches `tier`-only PATCH above.
    expect(data.item.version).toBe(created.item.version + 1);
  });

  it("answers a timestamp PATCH with the timestamp it stored", async () => {
    // The response is rebuilt from the pre-update snapshot rather than
    // re-read, so a column the update set has to be carried onto it
    // explicitly. `type` was carried after a re-type answered with the type
    // the row had stopped being; `timestamp` had the same gap, and it is
    // the field a caller is most likely to read straight back.
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "core.note", properties: { body: "restamp me" } },
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { item: { id: string } };

    const when = "2021-03-04T05:06:07.000Z";
    const res = await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.spaceKey,
      body: { timestamp: when },
    });
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { item: { timestamp: string } }).item.timestamp,
    ).toBe(when);

    // And the stored row agrees, so the answer is not merely self-consistent.
    const read = await request(ctx.app, "GET", `/items/${created.item.id}`, {
      key: ctx.spaceKey,
    });
    expect(
      ((await read.json()) as { item: { timestamp: string } }).item.timestamp,
    ).toBe(when);
  });

  it("source_id PATCH alongside properties + stale version: route still rejects on natural-key conflict (collision check runs before storage)", async () => {
    // Set up: an occupant under `occupied-key-v2`, and a mover currently at
    // mover-key-v2 with an explicit version pin that won't match after a
    // subsequent server-side update. We're asserting that the natural-key
    // gate runs before the version-merge path — collision is the failure
    // mode the caller sees, not version_conflict, even when the body
    // carries a stale version.
    const occupant = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "occupant v2" },
        source_id: "occupied-key-v2",
      },
    });
    const mover = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "mover v2" },
        source_id: "mover-key-v2",
      },
    });
    expect(occupant.status).toBe(201);
    expect(mover.status).toBe(201);
    const moverData = (await mover.json()) as {
      item: { id: string; version: number };
    };

    // Bump the mover so its current version is 2; the PATCH below will
    // carry stale version 1, which would normally enter the conflict path.
    await request(ctx.app, "PATCH", `/items/${moverData.item.id}`, {
      key: ctx.spaceKey,
      body: { properties: { body: "mover v2 bump" }, version: 1 },
    });

    // PATCH carries stale version + properties + colliding source_id.
    // The natural-key check runs first; the request fails with 409
    // source_id_conflict, NOT version_conflict.
    const res = await request(ctx.app, "PATCH", `/items/${moverData.item.id}`, {
      key: ctx.spaceKey,
      body: {
        properties: { body: "client try" },
        version: 1,
        source_id: "occupied-key-v2",
      },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("source_id_conflict");
  });

  it("cross-source isolation: same source_id under two different stamped sources coexists with no false collision", async () => {
    // Mint a key with a distinct stamped `source` (same pattern as the
    // existing natural-key-upsert cross-source test above).
    const altKeyRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.spaceKey,
      body: {
        label: "alt-source-rename",
        source: "alt-source-rename",
        type_permissions: { "core.note": "write" },
      },
    });
    const altKey = (await altKeyRes.json()) as { key: string };

    // Item A under admin's source, with the target natural-key occupied.
    const occupant = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "admin occupies cross-source-key" },
        source_id: "cross-source-key",
      },
    });
    expect(occupant.status).toBe(201);

    // Item B under altSource, currently holding a different source_id.
    const mover = await request(ctx.app, "POST", "/items", {
      key: altKey.key,
      body: {
        type: "core.note",
        properties: { body: "alt mover" },
        source_id: "alt-original-key",
      },
    });
    expect(mover.status).toBe(201);
    const moverData = (await mover.json()) as { item: { id: string } };

    // PATCH altSource's item to take on `cross-source-key`. Admin holds
    // the same source_id literal but under a DIFFERENT source — the
    // uniqueness scope is `(source, source_id)`, so this must succeed.
    const res = await request(ctx.app, "PATCH", `/items/${moverData.item.id}`, {
      key: altKey.key,
      body: { source_id: "cross-source-key" },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { item: { source_id?: string } };
    expect(data.item.source_id).toBe("cross-source-key");
  });
});

describe("DELETE /items/:id", () => {
  it("soft-deletes item and returns { ok: true }", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "core.note", properties: { body: "To delete" } },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    const res = await request(ctx.app, "DELETE", `/items/${created.item.id}`, {
      key: ctx.spaceKey,
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.ok).toBe(true);
  });
});

describe("POST /items/:id/restore", () => {
  it("restores trashed item and returns { item, metadata }", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "core.note", properties: { body: "To restore" } },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    await request(ctx.app, "DELETE", `/items/${created.item.id}`, {
      key: ctx.spaceKey,
    });

    const res = await request(
      ctx.app,
      "POST",
      `/items/${created.item.id}/restore`,
      {
        key: ctx.spaceKey,
      },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      item: { state: string };
      metadata: unknown;
    };
    expect(data.item.state).toBe("active");
    expect(data).toHaveProperty("metadata");
  });
});

describe("POST /items/:id/transition", () => {
  it("transitions item state and returns { item, metadata }", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "core.note", properties: { body: "State test" } },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    const res = await request(
      ctx.app,
      "POST",
      `/items/${created.item.id}/transition`,
      {
        key: ctx.spaceKey,
        body: { state: "archived" },
      },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      item: { state: string };
      metadata: unknown;
    };
    expect(data.item.state).toBe("archived");
    expect(data).toHaveProperty("metadata");
  });

  it("rejects invalid transition", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "Transition test" },
        state: "active",
      },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    const res = await request(
      ctx.app,
      "POST",
      `/items/${created.item.id}/transition`,
      {
        key: ctx.spaceKey,
        body: { state: "new" as unknown as "active" },
      },
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /items/:id/versions", () => {
  it("returns wrapped version history after update", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "core.note", properties: { body: "V1" } },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    await request(ctx.app, "PATCH", `/items/${created.item.id}`, {
      key: ctx.spaceKey,
      body: { properties: { body: "V2" }, version: 1 },
    });

    const res = await request(
      ctx.app,
      "GET",
      `/items/${created.item.id}/versions`,
      {
        key: ctx.spaceKey,
      },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { versions: { version: number }[] };
    expect(data.versions.length).toBe(1);
    expect(data.versions[0]).toHaveProperty("version", 1);
  });
});

// ---------------------------------------------------------------------------
// Filter query parameter (advanced query language)
// ---------------------------------------------------------------------------

describe("GET /items?filter=...", () => {
  it("filters by system field", async () => {
    // Create items with different states
    await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "Active note" },
        state: "active",
      },
    });
    await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "core.note", properties: { body: "New note" } },
    });

    const res = await request(
      ctx.app,
      "GET",
      `/items?filter=${encodeURIComponent('state eq "active"')}`,
      {
        key: ctx.spaceKey,
      },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { data: { state: string }[] };
    for (const item of data.data) {
      expect(item.state).toBe("active");
    }
  });

  it("filters by property value", async () => {
    await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.media.book",
        properties: { title: "1984", author: "Orwell", body: "" },
      },
    });
    await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.media.book",
        properties: { title: "Fahrenheit 451", author: "Bradbury", body: "" },
      },
    });

    const res = await request(
      ctx.app,
      "GET",
      `/items?filter=${encodeURIComponent('properties.author eq "Orwell"')}`,
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      data: { properties: Record<string, unknown> }[];
    };
    expect(data.data.length).toBeGreaterThanOrEqual(1);
    for (const item of data.data) {
      expect(item.properties.author).toBe("Orwell");
    }
  });

  it("filters with AND conditions", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/items?filter=${encodeURIComponent('state eq "active" AND type eq "core.media.book"')}`,
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      data: { state: string; type: string }[];
    };
    for (const item of data.data) {
      expect(item.state).toBe("active");
      expect(item.type).toBe("core.media.book");
    }
  });

  it("filters with OR conditions", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/items?filter=${encodeURIComponent('properties.author eq "Orwell" OR properties.author eq "Bradbury"')}`,
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      data: { properties: Record<string, unknown> }[];
    };
    for (const item of data.data) {
      expect(["Orwell", "Bradbury"]).toContain(item.properties.author);
    }
  });

  it("composes filter with existing type param", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/items?type=core.media.book&filter=${encodeURIComponent('properties.author eq "Orwell"')}`,
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      data: { type: string; properties: Record<string, unknown> }[];
    };
    for (const item of data.data) {
      expect(item.type).toBe("core.media.book");
      expect(item.properties.author).toBe("Orwell");
    }
  });

  it("returns 400 for invalid filter expression", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/items?filter=${encodeURIComponent("invalid_field eq test")}`,
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(400);
  });

  it("filters by tags contains", async () => {
    // Create an item with tags
    await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "Tagged note" },
        tags: ["fiction", "classic"],
      },
    });

    const res = await request(
      ctx.app,
      "GET",
      `/items?filter=${encodeURIComponent('tags contains "fiction"')}`,
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { data: unknown[] };
    expect(data.data.length).toBeGreaterThanOrEqual(1);
  });

  it("filters by property exists", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/items?filter=${encodeURIComponent("properties.author exists")}`,
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      data: { properties: Record<string, unknown> }[];
    };
    for (const item of data.data) {
      expect(item.properties).toHaveProperty("author");
    }
  });
});

describe("GET /items?sort=properties.<field>", () => {
  // Seed dedicated items so ordering assertions don't depend on other tests'
  // rows. Each helper filters the list response down to the ids it created.
  async function createBook(props: Record<string, unknown>): Promise<string> {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "core.media.book", properties: { body: "", ...props } },
    });
    expect(res.status).toBe(201);
    const item = (await res.json()) as { item: { id: string } };
    return item.item.id;
  }

  async function createTask(props: Record<string, unknown>): Promise<string> {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "core.task", properties: props },
    });
    expect(res.status).toBe(201);
    const item = (await res.json()) as { item: { id: string } };
    return item.item.id;
  }

  /** Fetch every page for a sort and return the ids restricted to `known`,
   *  preserving the server's order. Walking the cursor also exercises the
   *  property-field keyset pagination path. */
  async function orderedIds(
    sort: string,
    direction: "asc" | "desc",
    known: Set<string>,
  ): Promise<string[]> {
    const ordered: string[] = [];
    let cursor: string | null = null;
    do {
      const qs = new URLSearchParams({
        type: sort.startsWith("properties.due_at")
          ? "core.task"
          : "core.media.book",
        sort,
        direction,
        limit: "2",
      });
      if (cursor) qs.set("cursor", cursor);
      const res = await request(ctx.app, "GET", `/items?${qs.toString()}`, {
        key: ctx.spaceKey,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { id: string }[];
        cursor: string | null;
        has_more: boolean;
      };
      for (const row of body.data) if (known.has(row.id)) ordered.push(row.id);
      cursor = body.has_more ? body.cursor : null;
    } while (cursor);
    return ordered;
  }

  it("sorts by a numeric property ascending and descending, NULLS LAST", async () => {
    const small = await createBook({ title: "Small", page_count: 5 });
    const big = await createBook({ title: "Big", page_count: 100 });
    const mid = await createBook({ title: "Mid", page_count: 30 });
    const none = await createBook({ title: "None" }); // page_count absent → NULL
    const known = new Set([small, big, mid, none]);

    const asc = await orderedIds("properties.page_count", "asc", known);
    expect(asc).toEqual([small, mid, big, none]);

    const desc = await orderedIds("properties.page_count", "desc", known);
    expect(desc).toEqual([big, mid, small, none]);
  });

  it("sorts numerically, not lexically (2 before 10)", async () => {
    const two = await createBook({ title: "Two pages", page_count: 2 });
    const ten = await createBook({ title: "Ten pages", page_count: 10 });
    const known = new Set([two, ten]);
    const asc = await orderedIds("properties.page_count", "asc", known);
    // Lexical text ordering would place "10" before "2"; numeric must not.
    expect(asc).toEqual([two, ten]);
  });

  it("sorts by a datetime property ascending and descending, NULLS LAST", async () => {
    const early = await createTask({
      title: "Early",
      due_at: "2026-01-01T09:00:00.000Z",
    });
    const late = await createTask({
      title: "Late",
      due_at: "2026-12-31T17:30:00.000Z",
    });
    const mid = await createTask({
      title: "Mid",
      due_at: "2026-06-15T12:00:00.000Z",
    });
    const undated = await createTask({ title: "Undated" }); // due_at absent → NULL
    const known = new Set([early, late, mid, undated]);

    const asc = await orderedIds("properties.due_at", "asc", known);
    expect(asc).toEqual([early, mid, late, undated]);

    const desc = await orderedIds("properties.due_at", "desc", known);
    expect(desc).toEqual([late, mid, early, undated]);
  });

  it("rejects a malformed sort field with 400", async () => {
    const res = await request(
      ctx.app,
      "GET",
      `/items?sort=${encodeURIComponent("properties.Due At")}`,
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(400);
  });

  it("still honors the system-column sorts (back-compat)", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/items?sort=created_at&direction=asc&limit=3",
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { created_at: string }[] };
    const times = body.data.map((r) => r.created_at);
    const sorted = [...times].sort();
    expect(times).toEqual(sorted);
  });
});

describe("DELETE /items/:id/purge", () => {
  it("permanently deletes a trashed item", async () => {
    // Create and trash an item
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "Purge me", title: "Temporary" },
      },
    });
    const { item } = (await createRes.json()) as {
      item: { id: string };
    };

    await request(ctx.app, "DELETE", `/items/${item.id}`, {
      key: ctx.spaceKey,
    });

    // Purge the trashed item
    const purgeRes = await request(
      ctx.app,
      "DELETE",
      `/items/${item.id}/purge`,
      { key: ctx.spaceKey },
    );
    expect(purgeRes.status).toBe(200);

    // Verify the item is gone
    const getRes = await request(ctx.app, "GET", `/items/${item.id}`, {
      key: ctx.spaceKey,
    });
    expect(getRes.status).toBe(404);
  });

  it("rejects purge on non-trashed item", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "Active item", title: "Active" },
      },
    });
    const { item } = (await createRes.json()) as {
      item: { id: string };
    };

    const purgeRes = await request(
      ctx.app,
      "DELETE",
      `/items/${item.id}/purge`,
      { key: ctx.spaceKey },
    );
    expect(purgeRes.status).toBe(400);
  });
});

describe("schema_version stamping", () => {
  it("stamps schema_version: 1 on a newly-created core.note", async () => {
    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "core.note", properties: { body: "Schema-version test" } },
    });
    expect(res.status).toBe(201);
    const { item } = (await res.json()) as {
      item: { id: string; schema_version: number };
    };
    expect(item.schema_version).toBe(1);
  });

  it("preserves schema_version through update", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "core.note", properties: { body: "Update test" } },
    });
    const created = (await createRes.json()) as {
      item: { id: string; schema_version: number };
    };
    expect(created.item.schema_version).toBe(1);

    const updateRes = await request(
      ctx.app,
      "PATCH",
      `/items/${created.item.id}`,
      {
        key: ctx.spaceKey,
        body: { properties: { body: "Updated" } },
      },
    );
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as {
      item: { schema_version: number };
    };
    expect(updated.item.schema_version).toBe(1);
  });
});

describe("state lifecycle enum at the route boundary", () => {
  it("rejects POST /items/:id/transition with an unknown state", async () => {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "core.note", properties: { body: "Lifecycle test" } },
    });
    const created = (await createRes.json()) as { item: { id: string } };

    const res = await request(
      ctx.app,
      "POST",
      `/items/${created.item.id}/transition`,
      { key: ctx.spaceKey, body: { state: "draft" } },
    );
    expect(res.status).toBe(400);
  });
});

describe("query language: tier system field", () => {
  it('filters items by `tier eq "library"` via the filter query parameter', async () => {
    // Two items with explicit tier values
    await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "library item" },
        tier: "library",
      },
    });
    await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "feed item" },
        tier: "feed",
      },
    });

    const res = await request(
      ctx.app,
      "GET",
      `/items?type=core.note&filter=${encodeURIComponent('tier eq "library"')}&limit=200`,
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { tier: "library" | "feed" }[];
    };
    expect(body.data.length).toBeGreaterThan(0);
    for (const item of body.data) {
      expect(item.tier).toBe("library");
    }
  });
});

describe("tier default and tri-value filter on GET /items", () => {
  let libraryId: string;
  let feedId: string;

  beforeAll(async () => {
    const libRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "library marker for default test" },
        tier: "library",
      },
    });
    const libBody = (await libRes.json()) as { item: { id: string } };
    libraryId = libBody.item.id;

    const feedRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "feed marker for default test" },
        tier: "feed",
      },
    });
    const feedBody = (await feedRes.json()) as { item: { id: string } };
    feedId = feedBody.item.id;
  });

  it("returns both library and feed items when no tier param is supplied", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/items?type=core.note&limit=200",
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; tier: "library" | "feed" }[];
    };
    const ids = new Set(body.data.map((item) => item.id));
    expect(ids.has(libraryId)).toBe(true);
    expect(ids.has(feedId)).toBe(true);
  });

  it("returns library items only when ?tier=library", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/items?type=core.note&tier=library&limit=200",
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; tier: "library" | "feed" }[];
    };
    const ids = new Set(body.data.map((item) => item.id));
    expect(ids.has(libraryId)).toBe(true);
    expect(ids.has(feedId)).toBe(false);
    for (const item of body.data) {
      expect(item.tier).toBe("library");
    }
  });

  it("returns feed items only when ?tier=feed", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/items?type=core.note&tier=feed&limit=200",
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; tier: "library" | "feed" }[];
    };
    const ids = new Set(body.data.map((item) => item.id));
    expect(ids.has(libraryId)).toBe(false);
    expect(ids.has(feedId)).toBe(true);
    for (const item of body.data) {
      expect(item.tier).toBe("feed");
    }
  });

  it("treats ?tier=all as a synonym for unfiltered", async () => {
    const res = await request(
      ctx.app,
      "GET",
      "/items?type=core.note&tier=all&limit=200",
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; tier: "library" | "feed" }[];
    };
    const ids = new Set(body.data.map((item) => item.id));
    expect(ids.has(libraryId)).toBe(true);
    expect(ids.has(feedId)).toBe(true);
  });
});

describe("metadata.changed pubsub event", () => {
  it("fires from POST /items/:id/tags and surfaces with the canonical wire name", async () => {
    const { subscribe } = await import("../pubsub.js");

    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "Tag-event target" },
      },
    });
    const { item } = (await createRes.json()) as { item: { id: string } };

    // Subscribe before the mutation. The async generator yields on the
    // first event after subscribing — race the route call against a 500ms
    // timeout to fail fast if no event fires.
    const iter = subscribe();
    const nextEvent: Promise<{ type: string; item: { id: string } }> = iter
      .next()
      .then((r) => r.value as { type: string; item: { id: string } });

    const tagRes = await request(ctx.app, "POST", `/items/${item.id}/tags`, {
      key: ctx.spaceKey,
      body: { tags: ["interesting"] },
    });
    expect(tagRes.status).toBe(200);

    const event = await Promise.race([
      nextEvent,
      new Promise<{ type: string; item: { id: string } }>((_, reject) => {
        setTimeout(() => {
          reject(new Error("no event in 500ms"));
        }, 500);
      }),
    ]);
    expect(event.type).toBe("metadata_changed");
    expect(event.item.id).toBe(item.id);
    await iter.return(undefined);
  });
});

describe("metadata.extensions are permission-filtered on every read path", () => {
  async function createScopedKey(
    extPerms: Record<string, "read" | "write">,
    label: string,
  ): Promise<string> {
    const res = await request(ctx.app, "POST", "/keys", {
      key: ctx.spaceKey,
      body: {
        label,
        source: `${label}-src`,
        type_permissions: { "*": "write" },
        extension_permissions: extPerms,
      },
    });
    const { key } = (await res.json()) as { key: string };
    return key;
  }

  async function seedItemWithExtensions(): Promise<string> {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "ext-leak-fixture" },
        tags: ["ext-leak-fixture"],
      },
    });
    const { item } = (await createRes.json()) as { item: { id: string } };
    // Admin writes three extension namespaces. Member key below only has
    // read on `visible-app.prefs`; the other two must be hidden.
    for (const ns of [
      "visible-app.prefs",
      "hidden-app.prefs",
      "other-app.prefs",
    ]) {
      await request(ctx.app, "PUT", `/items/${item.id}/extensions/${ns}`, {
        key: ctx.spaceKey,
        body: { flag: ns },
      });
    }
    return item.id;
  }

  it("GET /items/:id only surfaces extension namespaces the caller can read", async () => {
    const id = await seedItemWithExtensions();
    const narrowKey = await createScopedKey(
      { "visible-app.prefs": "read" },
      "ext-leak-single",
    );

    const res = await request(ctx.app, "GET", `/items/${id}`, {
      key: narrowKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      metadata: { extensions: Record<string, unknown> };
    };
    expect(Object.keys(body.metadata.extensions).sort()).toEqual([
      "visible-app.prefs",
    ]);
  });

  it("GET /items?include=metadata filters extensions per item", async () => {
    const id = await seedItemWithExtensions();
    const narrowKey = await createScopedKey(
      { "visible-app.prefs": "read" },
      "ext-leak-list",
    );

    const res = await request(
      ctx.app,
      "GET",
      `/items?type=core.note&include=metadata&limit=200`,
      { key: narrowKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        item: { id: string };
        metadata: { extensions: Record<string, unknown> };
      }[];
    };
    const row = body.data.find((r) => r.item.id === id);
    expect(row).toBeDefined();
    expect(Object.keys(row?.metadata.extensions ?? {}).sort()).toEqual([
      "visible-app.prefs",
    ]);
  });

  it("GET /items/:id/metadata filters extensions", async () => {
    const id = await seedItemWithExtensions();
    const narrowKey = await createScopedKey(
      { "visible-app.prefs": "read" },
      "ext-leak-meta",
    );

    const res = await request(ctx.app, "GET", `/items/${id}/metadata`, {
      key: narrowKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      metadata: { extensions: Record<string, unknown> };
    };
    expect(Object.keys(body.metadata.extensions).sort()).toEqual([
      "visible-app.prefs",
    ]);
  });

  it("/search filters extensions on every result", async () => {
    await seedItemWithExtensions();
    const narrowKey = await createScopedKey(
      { "visible-app.prefs": "read" },
      "ext-leak-search",
    );

    const res = await request(ctx.app, "GET", `/search?q=ext-leak-fixture`, {
      key: narrowKey,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: { metadata: { extensions: Record<string, unknown> } }[];
    };
    expect(body.results.length).toBeGreaterThan(0);
    for (const result of body.results) {
      const namespaces = Object.keys(result.metadata.extensions);
      for (const ns of namespaces) {
        expect(ns).toBe("visible-app.prefs");
      }
    }
  });

  it("a key holding every namespace still sees every extension", async () => {
    const id = await seedItemWithExtensions();
    const res = await request(ctx.app, "GET", `/items/${id}`, {
      key: ctx.spaceKey,
    });
    const body = (await res.json()) as {
      metadata: { extensions: Record<string, unknown> };
    };
    expect(Object.keys(body.metadata.extensions).sort()).toEqual([
      "hidden-app.prefs",
      "other-app.prefs",
      "visible-app.prefs",
    ]);
  });

  it("implicit own-namespace rule still exposes a member's own namespace", async () => {
    const id = await seedItemWithExtensions();
    // Key with no explicit grants — the own-namespace rule should let it
    // see an extension namespace that matches its label.
    const ownerKey = await createScopedKey({}, "visible-app.prefs");
    const res = await request(ctx.app, "GET", `/items/${id}`, {
      key: ownerKey,
    });
    const body = (await res.json()) as {
      metadata: { extensions: Record<string, unknown> };
    };
    expect(Object.keys(body.metadata.extensions).sort()).toEqual([
      "visible-app.prefs",
    ]);
  });
});

describe("GET /items?include=extensions", () => {
  async function createScopedKey(
    extPerms: Record<string, "read" | "write">,
    label: string,
  ): Promise<string> {
    const res = await request(ctx.app, "POST", "/keys", {
      key: ctx.spaceKey,
      body: {
        label,
        source: `${label}-src`,
        type_permissions: { "*": "write" },
        extension_permissions: extPerms,
      },
    });
    const { key } = (await res.json()) as { key: string };
    return key;
  }

  async function seedItem(marker: string): Promise<string> {
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: `include-ext-${marker}` },
        tags: [`include-ext-${marker}`],
      },
    });
    const { item } = (await createRes.json()) as { item: { id: string } };
    for (const ns of ["visible.prefs", "hidden.prefs", "other.prefs"]) {
      await request(ctx.app, "PUT", `/items/${item.id}/extensions/${ns}`, {
        key: ctx.spaceKey,
        body: { flag: ns },
      });
    }
    return item.id;
  }

  it("omits extensions when include is not set (lists stay lean)", async () => {
    const id = await seedItem("lean");
    const res = await request(
      ctx.app,
      "GET",
      `/items?type=core.note&tags=include-ext-lean`,
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; extensions?: unknown }[];
    };
    const row = body.data.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row?.extensions).toBeUndefined();
  });

  it("hydrates extensions inline when include=extensions is set", async () => {
    const id = await seedItem("admin");
    const res = await request(
      ctx.app,
      "GET",
      `/items?type=core.note&tags=include-ext-admin&include=extensions`,
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; extensions?: Record<string, unknown> }[];
    };
    const row = body.data.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(Object.keys(row?.extensions ?? {}).sort()).toEqual([
      "hidden.prefs",
      "other.prefs",
      "visible.prefs",
    ]);
  });

  it("filters extensions per caller permissions", async () => {
    const id = await seedItem("filtered");
    const narrowKey = await createScopedKey(
      { "visible.prefs": "read" },
      "include-ext-filtered",
    );
    const res = await request(
      ctx.app,
      "GET",
      `/items?type=core.note&tags=include-ext-filtered&include=extensions`,
      { key: narrowKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; extensions?: Record<string, unknown> }[];
    };
    const row = body.data.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(Object.keys(row?.extensions ?? {}).sort()).toEqual([
      "visible.prefs",
    ]);
  });

  it("composes with include=edges in a single request", async () => {
    const targetRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "core.note", properties: { body: "combo target" } },
    });
    const { item: target } = (await targetRes.json()) as {
      item: { id: string };
    };
    const createRes = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "combo source" },
        tags: ["include-ext-combo"],
        edges: { about: [target.id] },
      },
    });
    const { item } = (await createRes.json()) as { item: { id: string } };
    await request(ctx.app, "PUT", `/items/${item.id}/extensions/app.data`, {
      key: ctx.spaceKey,
      body: { ok: true },
    });

    const res = await request(
      ctx.app,
      "GET",
      `/items?type=core.note&tags=include-ext-combo&include=edges,extensions`,
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        id: string;
        edges?: Record<string, { edges: unknown[] }>;
        extensions?: Record<string, unknown>;
      }[];
    };
    const row = body.data.find((r) => r.id === item.id);
    expect(row?.edges?.about?.edges.length).toBe(1);
    expect(row?.extensions).toHaveProperty("app.data");
  });
});

describe("permission-gate ordering (priority cluster)", () => {
  async function createScopedKey(
    permissions: Record<string, "read" | "write" | "none">,
  ): Promise<string> {
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(ctx.app, "POST", "/keys", {
      key: ctx.spaceKey,
      body: {
        label: `gate-member-${suffix}`,
        source: `gate-member-${suffix}`,
        default_tier: "feed",
        type_permissions: permissions,
        extension_permissions: {},
        edge_permissions: {},
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { key: string };
    return body.key;
  }

  it("DELETE /items/:id returns 403 when the credential lacks write on the type", async () => {
    // Admin creates an item.
    const create = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "core.note", properties: { body: "to-preserve" } },
    });
    const { item } = (await create.json()) as { item: { id: string } };

    // A credential holding read and not write on core.note.
    const restrictedKey = await createScopedKey({ "core.note": "read" });

    const del = await request(ctx.app, "DELETE", `/items/${item.id}`, {
      key: restrictedKey,
    });
    expect(del.status).toBe(403);

    // The item must still be readable with admin (i.e. not trashed).
    const after = await request(ctx.app, "GET", `/items/${item.id}`, {
      key: ctx.spaceKey,
    });
    expect(after.status).toBe(200);
  });

  it("POST /items/:id/restore returns 403 without touching state when credential lacks write", async () => {
    // Admin creates and trashes an item.
    const create = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "core.note", properties: { body: "soft-delete-me" } },
    });
    const { item } = (await create.json()) as { item: { id: string } };
    const del = await request(ctx.app, "DELETE", `/items/${item.id}`, {
      key: ctx.spaceKey,
    });
    expect(del.status).toBe(200);

    // Restore by a restricted credential must 403.
    const restrictedKey = await createScopedKey({ "core.note": "read" });
    const restore = await request(
      ctx.app,
      "POST",
      `/items/${item.id}/restore`,
      { key: restrictedKey },
    );
    expect(restore.status).toBe(403);

    // Item must remain trashed — gate must fire before the write.
    const getAfter = await request(ctx.app, "GET", `/items/${item.id}`, {
      key: ctx.spaceKey,
    });
    expect(getAfter.status).toBe(404);
  });

  it("POST /items/:id/tags rejects over-100 and does not write partial tags", async () => {
    const create = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: { type: "core.note", properties: { body: "tag-cap" } },
    });
    const { item } = (await create.json()) as { item: { id: string } };

    // Seed 95 tags — under the cap.
    const seed = Array.from({ length: 95 }, (_, i) => `t${String(i)}`);
    const seedRes = await request(ctx.app, "POST", `/items/${item.id}/tags`, {
      key: ctx.spaceKey,
      body: { tags: seed },
    });
    expect(seedRes.status).toBe(200);

    // Try to add 10 more (total would be 105) — must 400.
    const overflow = Array.from({ length: 10 }, (_, i) => `x${String(i)}`);
    const overflowRes = await request(
      ctx.app,
      "POST",
      `/items/${item.id}/tags`,
      { key: ctx.spaceKey, body: { tags: overflow } },
    );
    expect(overflowRes.status).toBe(400);

    // None of the 10 overflow tags should have persisted. Reading metadata
    // back, only the original 95 remain.
    const metaRes = await request(ctx.app, "GET", `/items/${item.id}`, {
      key: ctx.spaceKey,
    });
    const metaBody = (await metaRes.json()) as {
      metadata: { tags: string[] };
    };
    expect(metaBody.metadata.tags).toHaveLength(95);
    for (const x of overflow) {
      expect(metaBody.metadata.tags).not.toContain(x);
    }
  });
});

describe("POST /items — inline-edge hydration parity past the cap", () => {
  it("returns the same 50 edges and cursor a fresh read would, and the cursor reaches the rest", async () => {
    // The create response builds its edge hydration from the rows the
    // transaction created rather than reading them back, so this pins
    // the parity that makes the shortcut safe: same edges as a
    // follow-up GET, same has_more, and a cursor that fetches the
    // remainder with no duplicates and no unreachable edges.
    const targetIds: string[] = [];
    for (let i = 0; i < 51; i++) {
      const t = await request(ctx.app, "POST", "/items", {
        key: ctx.spaceKey,
        body: {
          type: "core.note",
          properties: { body: `target-${String(i)}` },
        },
      });
      targetIds.push(((await t.json()) as { item: { id: string } }).item.id);
    }

    const res = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: "many-edges" },
        edges: { references: targetIds },
      },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      item: {
        id: string;
        edges: Record<
          string,
          { edges: { id: string }[]; has_more: boolean; next_cursor?: string }
        >;
      };
    };
    const block = created.item.edges.references;
    if (!block) throw new Error("references block missing from response");
    expect(block.edges).toHaveLength(50);
    expect(block.has_more).toBe(true);
    expect(block.next_cursor).toBeDefined();

    // Byte-parity with the read path: a fresh single-item GET must
    // return the identical 50 edge ids in the identical order.
    const readBack = await request(
      ctx.app,
      "GET",
      `/items/${created.item.id}`,
      {
        key: ctx.spaceKey,
      },
    );
    const readItem = (await readBack.json()) as {
      item: {
        edges: Record<string, { edges: { id: string }[] }>;
      };
    };
    const readBlock = readItem.item.edges.references;
    if (!readBlock) throw new Error("references block missing from read");
    expect(block.edges.map((e) => e.id)).toEqual(
      readBlock.edges.map((e) => e.id),
    );

    // The cursor reaches exactly the one remaining edge — no duplicates
    // of the fifty already returned, nothing unreachable.
    const rest = await request(
      ctx.app,
      "GET",
      `/items/${created.item.id}/edges?edge_type=references&cursor=${encodeURIComponent(block.next_cursor ?? "")}`,
      { key: ctx.spaceKey },
    );
    const restBody = (await rest.json()) as { data: { id: string }[] };
    const firstPageIds = new Set(block.edges.map((e) => e.id));
    expect(restBody.data).toHaveLength(1);
    expect(firstPageIds.has(restBody.data[0]?.id ?? "")).toBe(false);
  });
});

/**
 * The `include` token that widens the row set rather than hydrating an extra.
 *
 * It had no test anywhere before this one — not on `/items`, not on `/search`,
 * and not in the conformance suite, which covers the default exclusion and the
 * explicit-type path and never the token. Two independently written client kits
 * lost data to it, both by listing everything they could see and pruning what
 * the listing did not carry.
 *
 * Every case that asserts an absence pairs it with an ordinary row that must be
 * present, because an assertion checking only that the system row is missing
 * passes against a listing that returned nothing at all. The type-filter case
 * asserts a presence only, and is right to: under `type=system.device` the
 * ordinary row is correctly absent.
 */
describe("GET /items?include=system", () => {
  async function seedPair(
    marker: string,
  ): Promise<{ noteId: string; deviceId: string }> {
    const note = await request(ctx.app, "POST", "/items", {
      key: ctx.spaceKey,
      body: {
        type: "core.note",
        properties: { body: `include-system-${marker}` },
        tags: [`include-system-${marker}`],
      },
    });
    expect(note.status).toBe(201);
    const { item: noteItem } = (await note.json()) as { item: { id: string } };
    // The system row goes in through the storage layer, because the reserved
    // namespace refuses a write to every credential. What this block is about
    // is who reads one back; the seed is not the claim.
    const device = await ctx.storage.items.create(
      {
        type: "system.device",
        properties: { name: `include-system-${marker}`, kind: "laptop" },
      },
      ctx.spaceId,
    );
    await ctx.storage.metadata.set(device.id, [`include-system-${marker}`]);
    return { noteId: noteItem.id, deviceId: device.id };
  }

  async function listedIdsAs(key: string, query: string): Promise<string[]> {
    const res = await request(ctx.app, "GET", query, { key });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[] };
    return body.data.map((r) => r.id);
  }

  async function listedIds(query: string): Promise<string[]> {
    return listedIdsAs(ctx.spaceKey, query);
  }

  it("omits system.* rows when the token is absent", async () => {
    const { noteId, deviceId } = await seedPair("absent");
    const ids = await listedIds("/items?tags=include-system-absent&limit=200");
    expect(ids).toContain(noteId);
    expect(ids).not.toContain(deviceId);
  });

  it("returns system.* rows when the token is present", async () => {
    const { noteId, deviceId } = await seedPair("present");
    const ids = await listedIds(
      "/items?tags=include-system-present&include=system&limit=200",
    );
    expect(ids).toContain(noteId);
    expect(ids).toContain(deviceId);
  });

  it("opts in on a specific system.* type filter without the token", async () => {
    const { deviceId } = await seedPair("bytype");
    const ids = await listedIds(
      "/items?type=system.device&tags=include-system-bytype&limit=200",
    );
    expect(ids).toContain(deviceId);
  });

  // Every other case in this file and its sibling runs as `ctx.spaceKey`,
  // which holds `"*": "write"` — so `allowed_types` admits everything and
  // says nothing in any of them. `exclude_system_types` and `allowed_types`
  // are independent arguments to the same storage call, and nothing asserted
  // how they compose, which matters now the published description advertises
  // the token to every client.
  //
  // The grant has to name the system type. A key holding only `core.note`
  // proves nothing: the device is absent whether the token was honored or
  // ignored, so the test would pass against a handler that dropped `system`
  // entirely. That was the first version of this test, and it is the guard
  // that cannot fail for the reason it exists.
  //
  // Reads to `system.*` pass the reserved-namespace fence, which gates
  // writes only, so the permission map is the one thing fencing them.
  async function scopedKey(
    label: string,
    perms: Record<string, "read" | "write">,
  ): Promise<string> {
    const res = await request(ctx.app, "POST", "/keys", {
      key: ctx.spaceKey,
      body: {
        label,
        source: `${label}-src`,
        type_permissions: perms,
      },
    });
    expect(res.status).toBe(201);
    const { key } = (await res.json()) as { key: string };
    return key;
  }

  it("composes with the caller's type permissions rather than bypassing them", async () => {
    const { noteId, deviceId } = await seedPair("granted");
    const key = await scopedKey("include-system-granted", {
      "core.note": "read",
      "system.device": "read",
    });

    const withToken = await listedIdsAs(
      key,
      "/items?tags=include-system-granted&include=system&limit=200",
    );
    const without = await listedIdsAs(
      key,
      "/items?tags=include-system-granted&limit=200",
    );

    // Granted the type, the token is what decides. Both directions, so the
    // case reddens if `system` stops being read.
    expect(withToken).toContain(noteId);
    expect(withToken).toContain(deviceId);
    expect(without).toContain(noteId);
    expect(without).not.toContain(deviceId);
  });

  it("does not let the token reach past a type the caller cannot read", async () => {
    const { noteId, deviceId } = await seedPair("withheld");
    const key = await scopedKey("include-system-withheld", {
      "core.note": "read",
    });

    const ids = await listedIdsAs(
      key,
      "/items?tags=include-system-withheld&include=system&limit=200",
    );
    // The fence outranks the token: the note is readable and the device is not,
    // even though the token asked for it.
    expect(ids).toContain(noteId);
    expect(ids).not.toContain(deviceId);
  });

  it("composes with a hydrating token without either losing its effect", async () => {
    const { noteId, deviceId } = await seedPair("compose");
    const res = await request(
      ctx.app,
      "GET",
      "/items?tags=include-system-compose&include=metadata,system&limit=200",
      { key: ctx.spaceKey },
    );
    expect(res.status).toBe(200);
    // `metadata` changes the envelope: each row becomes `{ item, metadata }`
    // rather than a bare item. That is itself a second way this parameter does
    // more than hydrate inline, and the first draft of this test read `r.id`
    // and got two `undefined`s back.
    const body = (await res.json()) as {
      data: { item: { id: string }; metadata: { tags: string[] } }[];
    };
    const ids = body.data.map((r) => r.item.id);
    expect(ids).toContain(noteId);
    expect(ids).toContain(deviceId);
    // Assert the tag rather than that `metadata` is defined. The handler falls
    // back to `{ item_id, tags: [], extensions: {} }` for a row it found no
    // metadata for, so `toBeDefined()` holds even if hydration dropped the
    // system row — and the envelope is already forced by the line above, which
    // throws if it is wrong. The tag is what proves the extra reached both.
    for (const row of body.data) {
      expect(row.metadata.tags).toContain("include-system-compose");
    }
  });
});
