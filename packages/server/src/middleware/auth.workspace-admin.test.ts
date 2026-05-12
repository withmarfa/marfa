/**
 * Tests for the T-051 workspace_admin role + helper.
 *
 * Two layers of coverage:
 *
 * 1. Unit-level — `checkWorkspaceAdmin(apiKey)` admits both `admin` and
 *    `workspace_admin`, rejects `member`, throws on missing key.
 *
 * 2. Integration — through-the-app behavior of the routes widened in this
 *    PR (POST /keys, /webhooks, /connections install/uninstall):
 *      - workspace_admin can mint own-tenant keys but cannot escalate to
 *        platform (is_platform silently coerced to false).
 *      - workspace_admin can CRUD own-tenant webhooks; cross-tenant
 *        attempts surface as 404.
 *      - member is still rejected on workspace-admin-gated routes.
 */

import { describe, it, expect, afterEach } from "vitest";
import type { ApiKey } from "@mymehq/shared";
import { MymeError, ErrorCode } from "@mymehq/shared";
import { checkWorkspaceAdmin, hashApiKey } from "./auth.js";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
  type TestContext,
} from "../test-utils.js";

// ---------------------------------------------------------------------------
// Unit — pure helper behaviour
// ---------------------------------------------------------------------------

function fakeKey(
  role: ApiKey["role"],
  overrides: Partial<ApiKey> = {},
): ApiKey {
  return {
    id: "key-test",
    tenant_id: "tenant-test",
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

describe("checkWorkspaceAdmin (unit)", () => {
  it("admits admin", () => {
    const key = fakeKey("admin");
    expect(checkWorkspaceAdmin(key)).toBe(key);
  });

  it("admits workspace_admin", () => {
    const key = fakeKey("workspace_admin");
    expect(checkWorkspaceAdmin(key)).toBe(key);
  });

  it("rejects member with FORBIDDEN", () => {
    const key = fakeKey("member");
    expect(() => checkWorkspaceAdmin(key)).toThrow(MymeError);
    try {
      checkWorkspaceAdmin(key);
    } catch (e) {
      expect((e as MymeError).code).toBe(ErrorCode.FORBIDDEN);
    }
  });

  it("rejects undefined with UNAUTHORIZED", () => {
    expect(() => checkWorkspaceAdmin(undefined)).toThrow(MymeError);
    try {
      checkWorkspaceAdmin(undefined);
    } catch (e) {
      expect((e as MymeError).code).toBe(ErrorCode.UNAUTHORIZED);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration — through-the-app behaviour of widened routes
// ---------------------------------------------------------------------------

async function mintKey(
  ctx: TestContext,
  opts: {
    label: string;
    role: ApiKey["role"];
    tenantId?: string;
    is_platform?: boolean;
  },
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 14);
  const raw = `myme_k1_workspace_admin_test_${suffix}`;
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
    opts.tenantId,
  );
  return raw;
}

describe("workspace_admin integration — widened routes", () => {
  let ctx: TestContext;

  afterEach(() => {
    ctx.cleanup();
  });

  it("workspace_admin can mint an own-tenant key", async () => {
    ctx = await createTestContext();
    const tenantA = {
      id: `tenant-a-${Math.random().toString(36).slice(2, 10)}`,
    };
    const wsAdmin = await mintKey(ctx, {
      label: "ws-admin-a",
      role: "workspace_admin",
      tenantId: tenantA.id,
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
    // workspace_admin is not platform; their minted key MUST not be platform
    expect(minted.is_platform).toBe(false);

    // Stored row carries the workspace_admin's tenant_id (T-051: stamped
    // automatically from caller).
    const stored = await ctx.storage.keys.get(minted.id);
    expect(stored?.tenant_id).toBe(tenantA.id);
  });

  it("workspace_admin cannot escalate to is_platform: true", async () => {
    ctx = await createTestContext();
    const tenantA = {
      id: `tenant-a-${Math.random().toString(36).slice(2, 10)}`,
    };
    const wsAdmin = await mintKey(ctx, {
      label: "ws-admin-a-2",
      role: "workspace_admin",
      tenantId: tenantA.id,
    });

    const res = await request(ctx.app, "POST", "/keys", {
      key: wsAdmin,
      body: {
        label: "would-be-platform",
        source: "would-be-platform",
        role: "admin",
        default_tier: "library",
        is_platform: true, // SHOULD be silently coerced to false
      },
    });

    expect(res.status).toBe(201);
    const minted = (await res.json()) as { is_platform: boolean };
    expect(minted.is_platform).toBe(false);
  });

  it("member is rejected by workspace-admin-gated POST /keys (FORBIDDEN)", async () => {
    ctx = await createTestContext();
    const tenantA = {
      id: `tenant-a-${Math.random().toString(36).slice(2, 10)}`,
    };
    const member = await mintKey(ctx, {
      label: "member-a",
      role: "member",
      tenantId: tenantA.id,
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

  it("workspace_admin can create + list + get own-tenant webhook; cross-tenant get is 404", async () => {
    ctx = await createTestContext();
    const tenantA = {
      id: `tenant-a-${Math.random().toString(36).slice(2, 10)}`,
    };
    const tenantB = {
      id: `tenant-b-${Math.random().toString(36).slice(2, 10)}`,
    };
    const wsAdminA = await mintKey(ctx, {
      label: "ws-admin-a-wh",
      role: "workspace_admin",
      tenantId: tenantA.id,
    });
    const wsAdminB = await mintKey(ctx, {
      label: "ws-admin-b-wh",
      role: "workspace_admin",
      tenantId: tenantB.id,
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

    // B cannot fetch A's webhook by id (cross-tenant probe → 404)
    const getB = await request(ctx.app, "GET", `/webhooks/${created.id}`, {
      key: wsAdminB,
    });
    expect(getB.status).toBe(404);
  });

  it("member is rejected by workspace-admin-gated webhook routes (FORBIDDEN)", async () => {
    ctx = await createTestContext();
    const tenantA = {
      id: `tenant-a-${Math.random().toString(36).slice(2, 10)}`,
    };
    const member = await mintKey(ctx, {
      label: "member-a-wh",
      role: "member",
      tenantId: tenantA.id,
    });

    const res = await request(ctx.app, "POST", "/webhooks", {
      key: member,
      body: { url: "https://example.com/hook", events: ["item.created"] },
    });
    expect(res.status).toBe(403);
  });
});
