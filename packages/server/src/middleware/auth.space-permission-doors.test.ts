/**
 * The space-scoped administrative doors, and what a credential needs to open
 * one.
 *
 * Two layers, and both were previously written about a rank:
 *
 * 1. Unit — the permission maps are the whole of a credential's reach now, so
 *    what used to be "does the rank bypass this map" is "does the map say
 *    yes". What survives from that era is the pair of properties the rank
 *    never decided: the reserved-namespace write gate, which reads
 *    `is_operator`, and the list-read narrowing, which reads the map.
 *
 * 2. Integration — each door consults the space permission its own surface
 *    names, and a space-bound credential is fenced to its own space once it
 *    is through. The census at `routes/space-permission-door-census.test.ts`
 *    proves every door asks; these prove the answer is obeyed and that the
 *    fence behind it holds, which a scanner cannot see.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ApiKey, SpacePermission } from "@withmarfa/shared";
import { checkTypeAccess, computeTypeFilter, hashApiKey } from "./auth.js";
import {
  createTestContext,
  request,
  seedOauthBearer,
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

function fakeKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: "key-test",
    space_id: "space-test",
    label: "test",
    source: "test",
    is_operator: false,
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
    spaceId: string;
    spacePermissions?: SpacePermission[];
    typePermissions?: Record<string, "read" | "write" | "none">;
  },
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 14);
  const raw = `marfa_k1_space_doors_${suffix}`;
  const keyHash = hashApiKey(raw, TEST_API_KEY_SALT);
  await ctx.storage.keys.create(
    {
      label: opts.label,
      source: `${opts.label}-${suffix}`,
      space_permissions: opts.spacePermissions ?? [],
      default_tier: "library",
      type_permissions: opts.typePermissions ?? {},
    },
    keyHash,
    opts.spaceId,
  );
  return raw;
}

// ---------------------------------------------------------------------------
// Unit — what the maps decide, and the one thing they do not
// ---------------------------------------------------------------------------

describe("checkTypeAccess", () => {
  it("gates a system.* write on is_operator, whatever the map says", () => {
    // The reserved-namespace fence is the one axis a type grant cannot buy:
    // `*: write` reaches every ordinary type and still stops at `system.*`.
    const key = fakeKey({
      type_permissions: { "*": "write" },
      is_operator: false,
    });
    expect(() => {
      checkTypeAccess(key, "system.connection", "read");
    }).not.toThrow();
    expect(() => {
      checkTypeAccess(key, "system.connection", "write");
    }).toThrow();
  });

  it("admits an ordinary type the map grants", () => {
    const key = fakeKey({ type_permissions: { "*": "write" } });
    expect(() => {
      checkTypeAccess(key, "core.note", "write");
    }).not.toThrow();
  });
});

describe("computeTypeFilter", () => {
  it("narrows a list read to what the map grants", () => {
    const key = fakeKey({
      type_permissions: { "core.note": "read", "core.task": "write" },
    });
    const filter = computeTypeFilter(key);
    expect(filter.allowed).toEqual(
      expect.arrayContaining(["core.note", "core.task"]),
    );
    expect(filter.excluded).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Integration — one door per space permission
// ---------------------------------------------------------------------------

describe("GET /spaces/me/quotas — space.usage", () => {
  it("returns the calling space's quota row", async () => {
    const spaceA = `space-quota-${Math.random().toString(36).slice(2, 10)}`;
    const caller = await mintKey(ctx, {
      label: "usage-holder",
      spaceId: spaceA,
      spacePermissions: ["space.usage"],
    });

    // Pre-populate a quota row via the storage layer.
    await ctx.storage.spaceQuotas.set(spaceA, { items_limit: 42 });

    const res = await request(ctx.app, "GET", "/spaces/me/quotas", {
      key: caller,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.space_id).toBe(spaceA);
    expect(body.items_limit).toBe(42);
    expect(body.webhooks_limit).toBe(null);
  });

  it("has no space-less caller left to reject", async () => {
    // This door used to answer 400 for a keys-mode bearer, which bound its
    // tokens to no space by design and so held the permission with no "me"
    // for the route to answer about. Issuance binds now and the middleware
    // refuses a token that arrives unbound anyway, so such a bearer never
    // reaches the handler: it is turned away as a credential rather than
    // told its request makes no sense. The other space-less shape is the
    // operator key, which holds none of the eleven and is refused by the
    // permission gate.
    const { token } = await seedOauthBearer(ctx.storage, ["space.usage"], {
      spaceId: null,
    });
    const unbound = await request(ctx.app, "GET", "/spaces/me/quotas", {
      key: token,
    });
    expect(unbound.status).toBe(401);

    const asOperator = await request(ctx.app, "GET", "/spaces/me/quotas", {
      key: ctx.operatorKey,
    });
    expect(asOperator.status).toBe(403);
  });

  it("rejects a credential that does not hold space.usage", async () => {
    const spaceA = `space-quota-none-${Math.random().toString(36).slice(2, 10)}`;
    const caller = await mintKey(ctx, {
      label: "usage-none",
      spaceId: spaceA,
    });
    const res = await request(ctx.app, "GET", "/spaces/me/quotas", {
      key: caller,
    });
    expect(res.status).toBe(403);
  });
});

describe("/keys — space.keys", () => {
  it("lists only the caller's own space's keys", async () => {
    const spaceA = `space-keys-a-${Math.random().toString(36).slice(2, 10)}`;
    const spaceB = `space-keys-b-${Math.random().toString(36).slice(2, 10)}`;
    const callerA = await mintKey(ctx, {
      label: "keys-a",
      spaceId: spaceA,
      spacePermissions: ["space.keys"],
    });
    // A key in space B — the caller in space A must not see it.
    await mintKey(ctx, {
      label: "keys-b",
      spaceId: spaceB,
      spacePermissions: ["space.keys"],
    });

    const res = await request(ctx.app, "GET", "/keys", { key: callerA });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: { space_id: string | null }[] };
    for (const k of body.keys) {
      expect(k.space_id).toBe(spaceA);
    }
    expect(body.keys.length).toBeGreaterThan(0);
  });

  it("404s a revoke aimed at another space's key", async () => {
    const spaceA = `space-rev-a-${Math.random().toString(36).slice(2, 10)}`;
    const spaceB = `space-rev-b-${Math.random().toString(36).slice(2, 10)}`;
    const callerA = await mintKey(ctx, {
      label: "rev-a",
      spaceId: spaceA,
      spacePermissions: ["space.keys"],
    });
    await mintKey(ctx, {
      label: "rev-b",
      spaceId: spaceB,
      spacePermissions: ["space.keys"],
    });
    const allKeys = await ctx.storage.keys.list();
    const spaceBKey = allKeys.find((k) => k.space_id === spaceB);
    expect(spaceBKey).toBeDefined();

    const res = await request(
      ctx.app,
      "DELETE",
      `/keys/${spaceBKey?.id ?? ""}`,
      { key: callerA },
    );
    expect(res.status).toBe(404);
  });

  it("mints into the caller's own space and cannot claim the operator flag", async () => {
    const spaceA = `space-mint-${Math.random().toString(36).slice(2, 10)}`;
    const caller = await mintKey(ctx, {
      label: "mint-holder",
      spaceId: spaceA,
      spacePermissions: ["space.keys"],
    });

    const res = await request(ctx.app, "POST", "/keys", {
      key: caller,
      body: {
        label: "child-key",
        source: `child-key-${Math.random().toString(36).slice(2, 10)}`,
        default_tier: "library",
        // Running the instance sits outside the permission model, so nothing
        // a space credential holds reaches it.
        is_operator: true,
      },
    });

    expect(res.status).toBe(403);
  });

  it("refuses a mint from a credential that does not hold space.keys", async () => {
    const spaceA = `space-mint-none-${Math.random().toString(36).slice(2, 10)}`;
    const caller = await mintKey(ctx, {
      label: "mint-none",
      spaceId: spaceA,
    });

    const res = await request(ctx.app, "POST", "/keys", {
      key: caller,
      body: {
        label: "child",
        source: `child-${Math.random().toString(36).slice(2, 10)}`,
        default_tier: "library",
      },
    });

    expect(res.status).toBe(403);
  });
});

describe("DELETE /items/:id/purge — space.item_purge", () => {
  it("purges an item in the caller's own space", async () => {
    const spaceA = `space-purge-${Math.random().toString(36).slice(2, 10)}`;
    const caller = await mintKey(ctx, {
      label: "purge-holder",
      spaceId: spaceA,
      spacePermissions: ["space.item_purge"],
      typePermissions: { "*": "write" },
    });

    // Create + trash an item via storage so the test doesn't have to
    // model the full lifecycle through HTTP.
    const item = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "doomed" } },
      spaceA,
    );
    await ctx.storage.items.transition(item.id, "trashed", spaceA);

    const res = await request(ctx.app, "DELETE", `/items/${item.id}/purge`, {
      key: caller,
    });
    expect(res.status).toBe(200);

    const after = await ctx.storage.items.get(item.id, spaceA);
    expect(after).toBeNull();
  });

  it("refuses a credential that does not hold space.item_purge", async () => {
    const spaceA = `space-purge-none-${Math.random().toString(36).slice(2, 10)}`;
    const caller = await mintKey(ctx, {
      label: "purge-none",
      spaceId: spaceA,
      typePermissions: { "*": "write" },
    });
    const item = await ctx.storage.items.create(
      { type: "core.note", properties: { body: "spared" } },
      spaceA,
    );
    await ctx.storage.items.transition(item.id, "trashed", spaceA);

    const res = await request(ctx.app, "DELETE", `/items/${item.id}/purge`, {
      key: caller,
    });
    expect(res.status).toBe(403);
  });
});

describe("/webhooks — space.webhooks", () => {
  it("fences a subscription to the space that registered it", async () => {
    const spaceA = `space-wh-a-${Math.random().toString(36).slice(2, 10)}`;
    const spaceB = `space-wh-b-${Math.random().toString(36).slice(2, 10)}`;
    const callerA = await mintKey(ctx, {
      label: "wh-a",
      spaceId: spaceA,
      spacePermissions: ["space.webhooks"],
      typePermissions: { "*": "write" },
    });
    const callerB = await mintKey(ctx, {
      label: "wh-b",
      spaceId: spaceB,
      spacePermissions: ["space.webhooks"],
      typePermissions: { "*": "write" },
    });

    const create = await request(ctx.app, "POST", "/webhooks", {
      key: callerA,
      body: { url: "https://example.com/hook", events: ["item.created"] },
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { id: string };

    const list = await request(ctx.app, "GET", "/webhooks", { key: callerA });
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { webhooks: { id: string }[] };
    expect(listed.webhooks.map((w) => w.id)).toContain(created.id);

    const getA = await request(ctx.app, "GET", `/webhooks/${created.id}`, {
      key: callerA,
    });
    expect(getA.status).toBe(200);

    // B holds the same permission in a different space, which reaches none
    // of A's rows.
    const listB = await request(ctx.app, "GET", "/webhooks", { key: callerB });
    expect(listB.status).toBe(200);
    const listedB = (await listB.json()) as { webhooks: { id: string }[] };
    expect(listedB.webhooks.map((w) => w.id)).not.toContain(created.id);

    // A cross-space probe must not confirm the id exists.
    const getB = await request(ctx.app, "GET", `/webhooks/${created.id}`, {
      key: callerB,
    });
    expect(getB.status).toBe(404);
  });

  it("refuses a credential that does not hold space.webhooks", async () => {
    const spaceA = `space-wh-none-${Math.random().toString(36).slice(2, 10)}`;
    const caller = await mintKey(ctx, {
      label: "wh-none",
      spaceId: spaceA,
      typePermissions: { "*": "write" },
    });

    const res = await request(ctx.app, "POST", "/webhooks", {
      key: caller,
      body: { url: "https://example.com/hook", events: ["item.created"] },
    });
    expect(res.status).toBe(403);
  });
});
