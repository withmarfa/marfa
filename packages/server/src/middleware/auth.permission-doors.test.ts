/**
 * The administrative doors, and what a credential needs to open one.
 *
 * Two layers, and both were previously written about a rank:
 *
 * 1. Unit — the permission maps are the whole of a credential's reach now, so
 *    what used to be "does the rank bypass this map" is "does the map say
 *    yes". What survives from that era is the pair of properties the rank
 *    never decided: the reserved-namespace write gate, which reads
 *    the reserved namespace fence, and the list-read narrowing, which reads the map.
 *
 * 2. Integration — each door consults the permission its own surface
 *    names. The census at `routes/permission-door-census.test.ts` proves
 *    every door asks; these prove the answer is obeyed, which a scanner
 *    cannot see.
 */

import { itemWrites } from "../storage/item-writes.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ApiKey, Permission } from "@withmarfa/shared";
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
 * Standing up a context is not free: it opens a database and a blob root
 * and seeds both. Per-test contexts put that cost
 * inside the test body, which is budgeted by `testTimeout`; a shared
 * context puts it in a hook, budgeted by the much larger `hookTimeout`
 * (see this package's `vitest.config.ts`). Under a loaded runner the
 * per-test shape is what pushes this file over its budget.
 *
 * Sharing is safe because none of these tests rely on database isolation:
 * every one mints its own randomized credential and tags the rows it makes,
 * so a row left behind by a sibling test is outside what its assertions
 * look at.
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
    label: "test",
    source: "test",

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
    permissions?: Permission[];
    typePermissions?: Record<string, "read" | "write" | "none">;
  },
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 14);
  const raw = `marfa_k1_permission_doors_${suffix}`;
  const keyHash = hashApiKey(raw, TEST_API_KEY_SALT);
  await ctx.storage.keys.create(
    {
      label: opts.label,
      source: `${opts.label}-${suffix}`,
      permissions: opts.permissions ?? [],
      default_tier: "library",
      type_permissions: opts.typePermissions ?? {},
    },
    keyHash,
  );
  return raw;
}

// ---------------------------------------------------------------------------
// Unit — what the maps decide, and the one thing they do not
// ---------------------------------------------------------------------------

describe("checkTypeAccess", () => {
  it("refuses direct system.* writes, whatever the map says", () => {
    // The reserved-namespace fence is the one axis a type grant cannot buy:
    // `*: write` reaches every ordinary type and still stops at `system.*`.
    const key = fakeKey({
      type_permissions: { "*": "write" },
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
// Integration — a door per permission, each with the pass and the refusal
//
// The pair is the point. A refusal on its own passes identically against a
// gate that refuses everybody, and a pass on its own against one that admits
// everybody, so a permission covered in one direction is covered by nothing.
// `grants.manage` is the exception here and is paired in
// `auth-grants-authority.test.ts` instead, where its two refusals already sit.
// ---------------------------------------------------------------------------

describe("/keys — keys.mint", () => {
  it("mints for a credential that holds keys.mint", async () => {
    // The pass direction, which the case below cannot stand in for: that one
    // is refused by schema validation whatever the
    // permission gate decided.
    const caller = await mintKey(ctx, {
      label: "mint-holder-pass",
      permissions: ["keys.mint"],
    });

    const res = await request(ctx.app, "POST", "/keys", {
      key: caller,
      body: {
        label: "child-key-minted",
        source: `child-minted-${Math.random().toString(36).slice(2, 10)}`,
        default_tier: "library",
      },
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { key: string; id: string };
    expect(body.key).toBeTruthy();
  });

  it("rejects the removed machine-authority field", async () => {
    const caller = await mintKey(ctx, {
      label: "mint-holder",
      permissions: ["keys.mint"],
    });

    const res = await request(ctx.app, "POST", "/keys", {
      key: caller,
      body: {
        label: "child-key",
        source: `child-key-${Math.random().toString(36).slice(2, 10)}`,
        default_tier: "library",
        // Running the instance sits outside the permission model, so nothing
        // a working credential holds reaches it.
        is_operator: true,
      },
    });

    expect(res.status).toBe(400);
  });

  it("refuses a mint from a credential that does not hold keys.mint", async () => {
    const caller = await mintKey(ctx, {
      label: "mint-none",
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

describe("POST /items/:id/purge — items.purge", () => {
  it("purges an item the caller can write", async () => {
    const caller = await mintKey(ctx, {
      label: "purge-holder",
      permissions: ["items.purge"],
      typePermissions: { "*": "write" },
    });

    // Create + trash an item via storage so the test doesn't have to
    // model the full lifecycle through HTTP.
    const item = await itemWrites(ctx.storage).create({
      type: "core.note",
      properties: { body: "doomed" },
    });
    await itemWrites(ctx.storage).transition(item.id, "trashed");

    const res = await request(ctx.app, "POST", `/items/${item.id}/purge`, {
      key: caller,
    });
    expect(res.status).toBe(200);

    const after = await ctx.storage.items.get(item.id);
    expect(after).toBeNull();
  });

  it("refuses a credential that does not hold items.purge", async () => {
    const caller = await mintKey(ctx, {
      label: "purge-none",
      typePermissions: { "*": "write" },
    });
    const item = await itemWrites(ctx.storage).create({
      type: "core.note",
      properties: { body: "spared" },
    });
    await itemWrites(ctx.storage).transition(item.id, "trashed");

    const res = await request(ctx.app, "POST", `/items/${item.id}/purge`, {
      key: caller,
    });
    expect(res.status).toBe(403);
  });
});

describe("/webhooks — webhooks.manage", () => {
  it("lists the subscriptions for a credential that holds webhooks.manage", async () => {
    // The read, not the register: reading a webhook configuration takes the
    // same permission as registering one, and the register door has a second
    // gate of its own on content reach, so a pass there would not isolate
    // this permission.
    const caller = await mintKey(ctx, {
      label: "wh-holder",
      permissions: ["webhooks.manage"],
    });

    const res = await request(ctx.app, "GET", "/webhooks", { key: caller });
    expect(res.status).toBe(200);
  });

  it("refuses a credential that does not hold webhooks.manage", async () => {
    const caller = await mintKey(ctx, {
      label: "wh-none",
      typePermissions: { "*": "write" },
    });

    const res = await request(ctx.app, "POST", "/webhooks", {
      key: caller,
      body: { url: "https://example.com/hook", events: ["item.created"] },
    });
    expect(res.status).toBe(403);
  });

  it("refuses the same read to a credential that does not hold it", async () => {
    // The control for the pass above. Without it that case passes against a
    // door standing open to any authenticated caller, which is exactly the
    // shape a dropped gate takes.
    const caller = await mintKey(ctx, { label: "wh-read-none" });

    const res = await request(ctx.app, "GET", "/webhooks", { key: caller });
    expect(res.status).toBe(403);
  });
});

describe("/audit — audit.read", () => {
  it("reads the trail for a credential that holds audit.read", async () => {
    const caller = await mintKey(ctx, {
      label: "audit-holder",
      permissions: ["audit.read"],
    });

    const res = await request(ctx.app, "GET", "/audit", { key: caller });
    expect(res.status).toBe(200);
  });

  it("refuses a credential that does not hold audit.read", async () => {
    const caller = await mintKey(ctx, {
      label: "audit-none",
      typePermissions: { "*": "write" },
    });

    const res = await request(ctx.app, "GET", "/audit", { key: caller });
    expect(res.status).toBe(403);
  });
});

describe("/config — config.manage", () => {
  it("reads the instance config for a credential that holds config.manage", async () => {
    // The read door, deliberately: `config.manage` is not `config.write`, so
    // a caller refused it cannot read the configuration either, and a pass
    // asserted only on the write door would leave that half unstated.
    const caller = await mintKey(ctx, {
      label: "config-holder",
      permissions: ["config.manage"],
    });

    const res = await request(ctx.app, "GET", "/config", {
      key: caller,
    });
    expect(res.status).toBe(200);
  });

  it("refuses a credential that does not hold config.manage", async () => {
    const caller = await mintKey(ctx, {
      label: "config-none",
      typePermissions: { "*": "write" },
    });

    const res = await request(ctx.app, "GET", "/config", {
      key: caller,
    });
    expect(res.status).toBe(403);
  });
});

describe("DELETE /types/:id — schema.write", () => {
  async function seedType(id: string): Promise<void> {
    await ctx.storage.types.create(
      {
        id,
        version: 1,
        fields: { name: { type: "string", required: true } },
      },
      { origin: "user" },
    );
  }

  it("removes a registration for a credential that holds schema.write and write on the type", async () => {
    const id = `jonah.gone_${Math.random().toString(36).slice(2, 10)}`;
    await seedType(id);
    const caller = await mintKey(ctx, {
      label: "schema-holder",
      permissions: ["schema.write"],
      typePermissions: { "jonah.*": "write" },
    });

    const res = await request(ctx.app, "DELETE", `/types/${id}`, {
      key: caller,
    });
    expect(res.status).toBe(200);
    expect(await ctx.storage.types.get(id)).toBeUndefined();
  });

  it("refuses a credential that does not hold schema.write", async () => {
    const id = `jonah.kept_${Math.random().toString(36).slice(2, 10)}`;
    await seedType(id);
    const caller = await mintKey(ctx, {
      label: "schema-none",
      typePermissions: { "*": "write" },
    });

    const res = await request(ctx.app, "DELETE", `/types/${id}`, {
      key: caller,
    });
    expect(res.status).toBe(403);
    // The refusal left the registration where it was.
    expect(await ctx.storage.types.get(id)).toBeDefined();
  });
});
