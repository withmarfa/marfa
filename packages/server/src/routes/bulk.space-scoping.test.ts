/**
 * Bulk item operations — space scoping.
 *
 * `POST /items/bulk` is space-admin capable (widened from platform-admin):
 * a space_admin can bulk-upsert within their own space but never reaches
 * another space's rows. This proves the isolation end to end:
 *
 *   - space_admin A bulk-creates inside space A;
 *   - a cross-space id collision does NOT update space B's row — it
 *     creates a fresh row in space A (the id lookup is space-fenced, so
 *     the upsert-by-id branch never matches across spaces);
 *   - a cross-space (source, source_id) collision likewise creates rather
 *     than updates;
 *   - platform-admin remains unaffected (cross-space authority).
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

async function mintSpaceAdmin(label: string, spaceId: string): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 14);
  const raw = `marfa_k1_bulk_scope_${suffix}`;
  await ctx.storage.keys.create(
    {
      label,
      source: `${label}-${suffix}`,
      role: "space_admin",
      default_tier: "library",
      type_permissions: { "*": "write" },
      edge_permissions: { "*": "write" },
      is_platform: false,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    spaceId,
  );
  return raw;
}

interface BulkResponse {
  counts: {
    created: number;
    updated: number;
    skipped: number;
    errored: number;
  };
  results: { outcome: string; id: string }[];
}

beforeAll(async () => {
  ctx = await createTestContext();
  adminA = await mintSpaceAdmin("bulk-admin-a", spaceA);
  adminB = await mintSpaceAdmin("bulk-admin-b", spaceB);
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("POST /items/bulk — space_admin within own space", () => {
  it("space_admin bulk-creates items in their own space", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: adminA,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "A1" },
            source_id: `a-${suffix}-1`,
          },
          {
            type: "core.note",
            properties: { body: "A2" },
            source_id: `a-${suffix}-2`,
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BulkResponse;
    expect(body.counts.created).toBe(2);

    // Both rows are visible to A and invisible to B.
    for (const r of body.results) {
      const getA = await request(ctx.app, "GET", `/items/${r.id}`, {
        key: adminA,
      });
      expect(getA.status).toBe(200);
      const getB = await request(ctx.app, "GET", `/items/${r.id}`, {
        key: adminB,
      });
      expect(getB.status).toBe(404);
    }
  });

  it("space_admin upsert updates only its own row, never another space's", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const sourceId = `shared-srcid-${suffix}`;

    // A and B both bulk-create a row carrying the SAME source_id. Because
    // `source` is stamped per-credential and the lookup is space-fenced,
    // these are two distinct rows in two spaces.
    const createA = await request(ctx.app, "POST", "/items/bulk", {
      key: adminA,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "A-orig" },
            source_id: sourceId,
          },
        ],
      },
    });
    const createB = await request(ctx.app, "POST", "/items/bulk", {
      key: adminB,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "B-orig" },
            source_id: sourceId,
          },
        ],
      },
    });
    const idA = ((await createA.json()) as BulkResponse).results[0]!.id;
    const idB = ((await createB.json()) as BulkResponse).results[0]!.id;
    expect(idA).not.toBe(idB);

    // A upserts the shared source_id again. It must update A's row only.
    const upsertA = await request(ctx.app, "POST", "/items/bulk", {
      key: adminA,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "A-updated" },
            source_id: sourceId,
          },
        ],
      },
    });
    const upsertBody = (await upsertA.json()) as BulkResponse;
    expect(upsertBody.counts.updated).toBe(1);
    expect(upsertBody.counts.created).toBe(0);
    expect(upsertBody.results[0]!.id).toBe(idA);

    // B's row is untouched.
    const getB = await request(ctx.app, "GET", `/items/${idB}`, {
      key: adminB,
    });
    const itemB = (await getB.json()) as {
      item: { properties: { body: string } };
    };
    expect(itemB.item.properties.body).toBe("B-orig");
  });

  it("cross-space id collision is a clean conflict, never a cross-space update", async () => {
    // B creates a row, then A bulk-upserts referencing B's id explicitly.
    // The id lookup is space-fenced, so A's call cannot match B's row and
    // takes the create path. The items PK is `id` alone, so inserting B's id
    // collides — surfaced as a clean per-item `conflict` (409 mapped to an
    // errored outcome), NOT a cross-space update and NOT an opaque 500.
    const suffix = Math.random().toString(36).slice(2, 8);
    const createB = await request(ctx.app, "POST", "/items/bulk", {
      key: adminB,
      body: {
        items: [{ type: "core.note", properties: { body: "B-private" } }],
      },
    });
    const idB = ((await createB.json()) as BulkResponse).results[0]!.id;

    const upsertA = await request(ctx.app, "POST", "/items/bulk", {
      key: adminA,
      body: {
        items: [
          {
            id: idB,
            type: "core.note",
            properties: { body: `A-attempt-${suffix}` },
          },
        ],
        atomic: false,
      },
    });
    expect(upsertA.status).toBe(200);
    const upsertBody = (await upsertA.json()) as BulkResponse & {
      results: { outcome: string; error?: { code: string } }[];
    };
    expect(upsertBody.counts.created).toBe(0);
    expect(upsertBody.counts.updated).toBe(0);
    expect(upsertBody.counts.errored).toBe(1);
    expect(upsertBody.results[0]!.error?.code).toBe("conflict");

    // B's original row is unchanged — A never touched it.
    const getB = await request(ctx.app, "GET", `/items/${idB}`, {
      key: adminB,
    });
    const itemB = (await getB.json()) as {
      item: { properties: { body: string } };
    };
    expect(itemB.item.properties.body).toBe("B-private");
  });
});

describe("POST /items/bulk — platform-admin unaffected", () => {
  it("platform-admin bulk-creates cross-space (no space scope)", async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.adminKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "platform" },
            source_id: `plat-${suffix}`,
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as BulkResponse;
    expect(body.counts.created).toBe(1);
  });
});
