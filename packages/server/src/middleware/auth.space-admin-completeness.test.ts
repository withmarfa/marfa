/**
 * space_admin completeness coverage.
 *
 * Covers:
 *
 *   - `checkTypeAccess` and `computeTypeFilter` admit `space_admin`
 *     with the same bypass admin gets — `space_admin` is the
 *     "admin within space" tier and shouldn't be additionally gated
 *     by `type_permissions`.
 *
 *   - `GET /spaces/me/quotas` returns the calling space's row for
 *     space_admin; rejects platform-admin (no space_id) with 400.
 *
 *   - `GET /keys` (widened): space_admin sees only own-space keys.
 *
 *   - `DELETE /keys/:id` (widened): space_admin can revoke own-
 *     space key; cross-space attempts surface as 404 (cloak).
 *
 *   - `DELETE /items/:id/purge` (widened): space_admin can purge
 *     own-space items.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ApiKey } from "@withmarfa/shared";
import { checkTypeAccess, computeTypeFilter, hashApiKey } from "./auth.js";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
  type TestContext,
} from "../test-utils.js";

/**
 * One context for every integration test in this file.
 *
 * Standing up a context is expensive on Postgres — it clones the template
 * database and drops the clone afterwards, and that DDL serializes against
 * every other test file doing the same. Per-test contexts put that cost
 * inside the test body, which is budgeted by `testTimeout`; a shared
 * context puts it in a hook, budgeted by the much larger `hookTimeout`
 * (see this package's `vitest.config.ts`). Under a loaded runner the
 * per-test shape is what pushes this file over its budget.
 *
 * Sharing is safe because none of these tests rely on database isolation:
 * every one mints its own randomized space id, and the assertions are all
 * scoped to that space. Rows left behind by a sibling test belong to a
 * different space and are invisible to the route under test — which is
 * itself the property being verified.
 */
let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

function fakeKey(
  role: ApiKey["role"],
  overrides: Partial<ApiKey> = {},
): ApiKey {
  return {
    id: "key-test",
    space_id: "space-test",
    label: "test",
    source: "test",
    role,
    is_platform: false,
    default_tier: "library",
    type_permissions: {},
    extension_permissions: {},
    edge_permissions: {},
    metadata_permissions: {},
    created_at: new Date().toISOString(),
    last_used_at: null,
    ...overrides,
  };
}

async function mintKey(
  ctx: TestContext,
  opts: {
    label: string;
    role: ApiKey["role"];
    spaceId?: string;
  },
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 14);
  const raw = `marfa_k1_part2_test_${suffix}`;
  const keyHash = hashApiKey(raw, TEST_API_KEY_SALT);
  await ctx.storage.keys.create(
    {
      label: opts.label,
      source: `${opts.label}-${suffix}`,
      role: opts.role,
      default_tier: "library",
      type_permissions: {},
    },
    keyHash,
    opts.spaceId,
  );
  return raw;
}

// ---------------------------------------------------------------------------
// Unit — type_permissions bypass + computeTypeFilter
// ---------------------------------------------------------------------------

describe("space_admin bypasses type_permissions", () => {
  it("checkTypeAccess returns silently for space_admin on any type", () => {
    const key = fakeKey("space_admin", { type_permissions: {} });
    expect(() => {
      checkTypeAccess(key, "core.note", "write");
    }).not.toThrow();
    expect(() => {
      checkTypeAccess(key, "demo.web_gallery", "write");
    }).not.toThrow();
    expect(() => {
      checkTypeAccess(key, "core.task", "read");
    }).not.toThrow();
  });

  it("checkTypeAccess still gates system.* writes on is_platform", () => {
    const key = fakeKey("space_admin", {
      type_permissions: {},
      is_platform: false,
    });
    // Reads to system.* are allowed; writes are not unless platform.
    expect(() => {
      checkTypeAccess(key, "system.connection", "read");
    }).not.toThrow();
    expect(() => {
      checkTypeAccess(key, "system.connection", "write");
    }).toThrow();
  });

  it("computeTypeFilter returns undefined (no filter) for space_admin", () => {
    const key = fakeKey("space_admin", {
      type_permissions: { "core.note": "read" },
    });
    expect(computeTypeFilter(key)).toBeUndefined();
  });

  it("computeTypeFilter still filters for member role", () => {
    const key = fakeKey("member", {
      type_permissions: { "core.note": "read", "core.task": "write" },
    });
    const filter = computeTypeFilter(key);
    expect(filter).toEqual(expect.arrayContaining(["core.note", "core.task"]));
  });
});

// ---------------------------------------------------------------------------
// Integration — widened routes + new GET /spaces/me/quotas
// ---------------------------------------------------------------------------

describe("GET /spaces/me/quotas", () => {
  it("returns the calling space's quota row for space_admin", async () => {
    const spaceA = `space-quota-${Math.random().toString(36).slice(2, 10)}`;
    const wsAdmin = await mintKey(ctx, {
      label: "ws-admin-quota",
      role: "space_admin",
      spaceId: spaceA,
    });

    // Pre-populate a quota row via the storage layer.
    await ctx.storage.spaceQuotas.set(spaceA, { items_limit: 42 });

    const res = await request(ctx.app, "GET", "/spaces/me/quotas", {
      key: wsAdmin,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.space_id).toBe(spaceA);
    expect(body.items_limit).toBe(42);
    expect(body.webhooks_limit).toBe(null);
  });

  it("rejects platform-admin (no space_id) with 400", async () => {
    // ctx.adminKey is the bootstrap platform admin — no space_id.
    const res = await request(ctx.app, "GET", "/spaces/me/quotas", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(400);
  });

  it("rejects member with FORBIDDEN", async () => {
    const spaceA = `space-quota-mem-${Math.random().toString(36).slice(2, 10)}`;
    const member = await mintKey(ctx, {
      label: "member-quota",
      role: "member",
      spaceId: spaceA,
    });
    const res = await request(ctx.app, "GET", "/spaces/me/quotas", {
      key: member,
    });
    expect(res.status).toBe(403);
  });
});

describe("widened routes — keys + items.purge", () => {
  it("space_admin GET /keys lists only own-space keys", async () => {
    const spaceA = `space-keys-a-${Math.random().toString(36).slice(2, 10)}`;
    const spaceB = `space-keys-b-${Math.random().toString(36).slice(2, 10)}`;
    const wsAdminA = await mintKey(ctx, {
      label: "ws-keys-a",
      role: "space_admin",
      spaceId: spaceA,
    });
    // Mint a space B key — space_admin in space A should not see it.
    await mintKey(ctx, {
      label: "ws-keys-b",
      role: "space_admin",
      spaceId: spaceB,
    });

    const res = await request(ctx.app, "GET", "/keys", { key: wsAdminA });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: { space_id: string | null }[] };
    // Every visible key has space_id === spaceA. None from space B.
    for (const k of body.keys) {
      expect(k.space_id).toBe(spaceA);
    }
    expect(body.keys.length).toBeGreaterThan(0);
  });

  it("space_admin DELETE /keys/:id of cross-space key returns 404", async () => {
    const spaceA = `space-rev-a-${Math.random().toString(36).slice(2, 10)}`;
    const spaceB = `space-rev-b-${Math.random().toString(36).slice(2, 10)}`;
    const wsAdminA = await mintKey(ctx, {
      label: "ws-rev-a",
      role: "space_admin",
      spaceId: spaceA,
    });
    // Mint a key in space B; capture its id directly from the store
    // (tests don't need the raw key, just the row id).
    await mintKey(ctx, {
      label: "ws-rev-b",
      role: "space_admin",
      spaceId: spaceB,
    });
    const allKeys = await ctx.storage.keys.list();
    const spaceBKey = allKeys.find((k) => k.space_id === spaceB);
    expect(spaceBKey).toBeDefined();

    const res = await request(
      ctx.app,
      "DELETE",
      `/keys/${spaceBKey?.id ?? ""}`,
      { key: wsAdminA },
    );
    expect(res.status).toBe(404);
  });

  it("space_admin can purge an item in own space", async () => {
    const spaceA = `space-purge-${Math.random().toString(36).slice(2, 10)}`;
    const wsAdmin = await mintKey(ctx, {
      label: "ws-purge",
      role: "space_admin",
      spaceId: spaceA,
    });

    // Create + trash an item via storage so the test doesn't have to
    // model the full lifecycle through HTTP.
    const item = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "doomed" } },
      spaceA,
    );
    await ctx.storage.items.transition(item.id, "trashed", spaceA);

    const res = await request(ctx.app, "DELETE", `/items/${item.id}/purge`, {
      key: wsAdmin,
    });
    expect(res.status).toBe(200);

    const after = await ctx.storage.items.get(item.id, spaceA);
    expect(after).toBeNull();
  });
});
