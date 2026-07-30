/**
 * Tests for the space_admin role and helper.
 *
 * Two layers of coverage:
 *
 * 1. Unit-level — `checkSpaceAdmin(apiKey)` admits both `admin` and
 *    `space_admin`, rejects `member`, throws on missing key.
 *
 * 2. Integration — through-the-app behavior of the routes widened in this
 *    PR (POST /keys, /webhooks, /connections install/uninstall):
 *      - space_admin can mint own-space keys but cannot escalate to
 *        platform (is_platform silently coerced to false).
 *      - space_admin can CRUD own-space webhooks; cross-space
 *        attempts surface as 404.
 *      - member is still rejected on space-admin-gated routes.
 */

import { describe, it, expect, afterEach } from "vitest";
import type { ApiKey } from "@withmarfa/shared";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import { checkSpaceAdmin, hashApiKey } from "./auth.js";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
  type TestContext,
} from "../test-utils.js";

// ---------------------------------------------------------------------------
// Unit — pure helper behavior
// ---------------------------------------------------------------------------

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

describe("checkSpaceAdmin (unit)", () => {
  it("admits admin", () => {
    const key = fakeKey("admin");
    expect(checkSpaceAdmin(key)).toBe(key);
  });

  it("admits space_admin", () => {
    const key = fakeKey("space_admin");
    expect(checkSpaceAdmin(key)).toBe(key);
  });

  it("rejects member with FORBIDDEN", () => {
    const key = fakeKey("member");
    expect(() => checkSpaceAdmin(key)).toThrow(MarfaError);
    try {
      checkSpaceAdmin(key);
    } catch (e) {
      expect((e as MarfaError).code).toBe(ErrorCode.FORBIDDEN);
    }
  });

  it("rejects undefined with UNAUTHORIZED", () => {
    expect(() => checkSpaceAdmin(undefined)).toThrow(MarfaError);
    try {
      checkSpaceAdmin(undefined);
    } catch (e) {
      expect((e as MarfaError).code).toBe(ErrorCode.UNAUTHORIZED);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration — through-the-app behavior of widened routes
// ---------------------------------------------------------------------------

async function mintKey(
  ctx: TestContext,
  opts: {
    label: string;
    role: ApiKey["role"];
    spaceId?: string;
    is_platform?: boolean;
  },
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 14);
  const raw = `marfa_k1_space_admin_test_${suffix}`;
  const keyHash = hashApiKey(raw, TEST_API_KEY_SALT);
  await ctx.storage.keys.create(
    {
      label: opts.label,
      source: `${opts.label}-${suffix}`,
      role: opts.role,
      default_tier: "library",
      type_permissions: {},
      is_platform: opts.is_platform ?? false,
    },
    keyHash,
    opts.spaceId,
  );
  return raw;
}

describe("space_admin integration — widened routes", () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("space_admin can mint an own-space key", async () => {
    ctx = await createTestContext();
    const spaceA = {
      id: `space-a-${Math.random().toString(36).slice(2, 10)}`,
    };
    const wsAdmin = await mintKey(ctx, {
      label: "ws-admin-a",
      role: "space_admin",
      spaceId: spaceA.id,
    });

    const res = await request(ctx.app, "POST", "/keys", {
      key: wsAdmin,
      body: {
        label: "child-key",
        source: "child-key",
        role: "member",
        default_tier: "library",
      },
    });

    expect(res.status).toBe(201);
    const minted = (await res.json()) as {
      id: string;
      role: string;
      is_platform: boolean;
    };
    expect(minted.role).toBe("member");
    // space_admin is not platform; their minted key MUST not be platform
    expect(minted.is_platform).toBe(false);

    // Stored row carries the space_admin's space_id, stamped
    // automatically from the caller.
    const stored = await ctx.storage.keys.get(minted.id);
    expect(stored?.space_id).toBe(spaceA.id);
  });

  it("space_admin cannot escalate to is_platform: true", async () => {
    ctx = await createTestContext();
    const spaceA = {
      id: `space-a-${Math.random().toString(36).slice(2, 10)}`,
    };
    const wsAdmin = await mintKey(ctx, {
      label: "ws-admin-a-2",
      role: "space_admin",
      spaceId: spaceA.id,
    });

    // Role stays at the caller's own tier so this exercises the
    // `is_platform` axis in isolation; the role axis is refused outright
    // and is covered in `auth.privilege-escalation.test.ts`.
    const res = await request(ctx.app, "POST", "/keys", {
      key: wsAdmin,
      body: {
        label: "would-be-platform",
        source: "would-be-platform",
        role: "space_admin",
        default_tier: "library",
        is_platform: true, // silently coerced to false
      },
    });

    expect(res.status).toBe(201);
    const minted = (await res.json()) as { is_platform: boolean };
    expect(minted.is_platform).toBe(false);
  });

  it("member is rejected by space-admin-gated POST /keys (FORBIDDEN)", async () => {
    ctx = await createTestContext();
    const spaceA = {
      id: `space-a-${Math.random().toString(36).slice(2, 10)}`,
    };
    const member = await mintKey(ctx, {
      label: "member-a",
      role: "member",
      spaceId: spaceA.id,
    });

    const res = await request(ctx.app, "POST", "/keys", {
      key: member,
      body: {
        label: "child",
        source: "child",
        role: "member",
        default_tier: "library",
      },
    });

    expect(res.status).toBe(403);
  });

  it("space_admin can create + list + get own-space webhook; cross-space get is 404", async () => {
    ctx = await createTestContext();
    const spaceA = {
      id: `space-a-${Math.random().toString(36).slice(2, 10)}`,
    };
    const spaceB = {
      id: `space-b-${Math.random().toString(36).slice(2, 10)}`,
    };
    const wsAdminA = await mintKey(ctx, {
      label: "ws-admin-a-wh",
      role: "space_admin",
      spaceId: spaceA.id,
    });
    const wsAdminB = await mintKey(ctx, {
      label: "ws-admin-b-wh",
      role: "space_admin",
      spaceId: spaceB.id,
    });

    // A creates a webhook
    const create = await request(ctx.app, "POST", "/webhooks", {
      key: wsAdminA,
      body: {
        url: "https://example.com/hook",
        events: ["item.created"],
      },
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { id: string };

    // A can list it
    const list = await request(ctx.app, "GET", "/webhooks", {
      key: wsAdminA,
    });
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { webhooks: { id: string }[] };
    expect(listed.webhooks.map((w) => w.id)).toContain(created.id);

    // A can get it by id
    const getA = await request(ctx.app, "GET", `/webhooks/${created.id}`, {
      key: wsAdminA,
    });
    expect(getA.status).toBe(200);

    // B cannot see A's webhook in their list
    const listB = await request(ctx.app, "GET", "/webhooks", {
      key: wsAdminB,
    });
    expect(listB.status).toBe(200);
    const listedB = (await listB.json()) as {
      webhooks: { id: string }[];
    };
    expect(listedB.webhooks.map((w) => w.id)).not.toContain(created.id);

    // B cannot fetch A's webhook by id (cross-space probe → 404)
    const getB = await request(ctx.app, "GET", `/webhooks/${created.id}`, {
      key: wsAdminB,
    });
    expect(getB.status).toBe(404);
  });

  it("member is rejected by space-admin-gated webhook routes (FORBIDDEN)", async () => {
    ctx = await createTestContext();
    const spaceA = {
      id: `space-a-${Math.random().toString(36).slice(2, 10)}`,
    };
    const member = await mintKey(ctx, {
      label: "member-a-wh",
      role: "member",
      spaceId: spaceA.id,
    });

    const res = await request(ctx.app, "POST", "/webhooks", {
      key: member,
      body: { url: "https://example.com/hook", events: ["item.created"] },
    });
    expect(res.status).toBe(403);
  });
});
