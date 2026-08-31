/**
 * Regression suite for the role axis of credential minting and for the
 * platform-admin gate.
 *
 * Two independent defects, one escalation chain:
 *
 * 1. `POST /keys` took `role` straight from the request body. A
 *    `space_admin` could mint itself an `admin` credential — and every
 *    hosted sign-up is provisioned `space_admin`, so any account could
 *    reach platform authority. The fix is a role lattice: a caller may
 *    never grant a role that outranks its own.
 *
 * 2. `checkAdmin` tested the role alone. A credential carrying
 *    `role: "instance_admin"` but bound to a space passed every `requireAdmin`
 *    gate, including the cross-space `/admin/spaces` surface. Platform
 *    authority is authority that is NOT confined to a space, so the gate
 *    now requires an unbound credential.
 *
 * Each layer is tested on its own: the lattice holds even if a
 * space-bound admin key is minted by a platform operator through
 * `POST /admin/spaces/{id}/keys`, and the platform gate holds even if a
 * space-bound admin credential exists for any other reason.
 */

import { describe, it, expect, afterEach } from "vitest";
import type { ApiKey } from "@withmarfa/shared";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import { checkAdmin, hashApiKey } from "./auth.js";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
  type TestContext,
} from "../test-utils.js";
import type { Storage } from "../storage/interface.js";

// ---------------------------------------------------------------------------
// Unit — checkAdmin considers space binding, not role alone
// ---------------------------------------------------------------------------

function fakeKey(
  role: ApiKey["role"],
  overrides: Partial<ApiKey> = {},
): ApiKey {
  return {
    id: "key-test",
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

describe("checkAdmin (unit)", () => {
  it("admits an unbound admin — the platform operator credential", () => {
    const key = fakeKey("instance_admin");
    expect(checkAdmin(key)).toBe(key);
  });

  it("rejects a space-bound admin with FORBIDDEN", () => {
    const key = fakeKey("instance_admin", { space_id: "space-a" });
    expect(() => checkAdmin(key)).toThrow(MarfaError);
    try {
      checkAdmin(key);
    } catch (e) {
      expect((e as MarfaError).code).toBe(ErrorCode.FORBIDDEN);
    }
  });

  it("rejects space_admin", () => {
    expect(() => checkAdmin(fakeKey("space_admin"))).toThrow(MarfaError);
  });

  it("rejects member", () => {
    expect(() => checkAdmin(fakeKey("member"))).toThrow(MarfaError);
  });

  it("rejects undefined with UNAUTHORIZED", () => {
    try {
      checkAdmin(undefined);
      expect.unreachable("checkAdmin must throw for a missing credential");
    } catch (e) {
      expect((e as MarfaError).code).toBe(ErrorCode.UNAUTHORIZED);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------

/** The space store is optional on the interface but always present in a
 *  test context built with the default (hosted-capable) storage. */
function spaceStore(ctx: TestContext): NonNullable<Storage["spaces"]> {
  const spaces = ctx.storage.spaces;
  if (!spaces) throw new Error("test context has no space store");
  return spaces;
}

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
  const raw = `marfa_k1_escalation_test_${suffix}`;
  await ctx.storage.keys.create(
    {
      label: opts.label,
      source: `${opts.label}-${suffix}`,
      role: opts.role,
      default_tier: "library",
      type_permissions: {},
      is_platform: opts.is_platform ?? false,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    opts.spaceId,
  );
  return raw;
}

describe("role lattice — a caller cannot grant above its own authority", () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("space_admin cannot mint an admin credential", async () => {
    ctx = await createTestContext();
    const spaceA = `space-a-${Math.random().toString(36).slice(2, 10)}`;
    const wsAdmin = await mintKey(ctx, {
      label: "ws-admin-lattice",
      role: "space_admin",
      spaceId: spaceA,
    });

    const res = await request(ctx.app, "POST", "/keys", {
      key: wsAdmin,
      body: {
        label: "escalated",
        source: "escalated",
        role: "instance_admin",
        default_tier: "library",
      },
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("space_admin may still mint its own tier and below", async () => {
    ctx = await createTestContext();
    const spaceA = `space-a-${Math.random().toString(36).slice(2, 10)}`;
    const wsAdmin = await mintKey(ctx, {
      label: "ws-admin-peer",
      role: "space_admin",
      spaceId: spaceA,
    });

    for (const role of ["space_admin", "member"] as const) {
      const res = await request(ctx.app, "POST", "/keys", {
        key: wsAdmin,
        body: {
          label: `peer-${role}`,
          source: `peer-${role}`,
          role,
          default_tier: "library",
        },
      });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { role: string }).role).toBe(role);
    }
  });

  it("the lattice never refuses a platform admin", async () => {
    ctx = await createTestContext();
    const platform = await mintKey(ctx, {
      label: "platform-admin",
      role: "instance_admin",
      is_platform: true,
    });

    for (const role of ["instance_admin", "member"] as const) {
      const res = await request(ctx.app, "POST", "/keys", {
        key: platform,
        body: {
          label: `minted-${role}`,
          source: `minted-${role}`,
          role,
          default_tier: "library",
        },
      });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { role: string }).role).toBe(role);
    }

    // `space_admin` is the one role a space-less caller cannot mint here,
    // and the refusal comes from the space axis, not this one: the new key
    // would inherit no space, so its authority would not stop where its
    // name says. A 400 rather than the lattice's 403 is what distinguishes
    // the two guards.
    const res = await request(ctx.app, "POST", "/keys", {
      key: platform,
      body: {
        label: "minted-space-admin",
        source: "minted-space-admin",
        role: "space_admin",
        default_tier: "library",
      },
    });
    expect(res.status).toBe(400);
  });

  it("a space-bound admin cannot mint above space scope either", async () => {
    // A platform operator can legitimately issue a space-bound `admin`
    // through POST /admin/spaces/{id}/keys. Its authority is confined to
    // that space, so its mint ceiling must be too.
    ctx = await createTestContext();
    const spaceA = `space-a-${Math.random().toString(36).slice(2, 10)}`;
    const boundAdmin = await mintKey(ctx, {
      label: "bound-admin",
      role: "instance_admin",
      spaceId: spaceA,
    });

    const res = await request(ctx.app, "POST", "/keys", {
      key: boundAdmin,
      body: {
        label: "child-admin",
        source: "child-admin",
        role: "instance_admin",
        default_tier: "library",
      },
    });

    // Same tier, so the lattice permits it; the minted key inherits the
    // caller's space binding and is therefore no more powerful.
    expect(res.status).toBe(201);
    const minted = (await res.json()) as { id: string };
    const stored = await ctx.storage.keys.get(minted.id);
    expect(stored?.space_id).toBe(spaceA);
  });
});

describe("platform gate — a space-bound admin has no cross-space authority", () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function seedBoundAdmin(): Promise<{
    boundAdmin: string;
    victim: string;
  }> {
    const victim = (await spaceStore(ctx).create("Victim Space")).id;
    const attacker = (await spaceStore(ctx).create("Attacker Space")).id;
    const boundAdmin = await mintKey(ctx, {
      label: "bound-admin",
      role: "instance_admin",
      spaceId: attacker,
    });
    return { boundAdmin, victim };
  }

  it("cannot enumerate spaces", async () => {
    ctx = await createTestContext();
    const { boundAdmin } = await seedBoundAdmin();

    const res = await request(ctx.app, "GET", "/admin/spaces", {
      key: boundAdmin,
    });
    expect(res.status).toBe(403);
  });

  it("cannot read another space's row", async () => {
    ctx = await createTestContext();
    const { boundAdmin, victim } = await seedBoundAdmin();

    const res = await request(ctx.app, "GET", `/admin/spaces/${victim}`, {
      key: boundAdmin,
    });
    expect(res.status).toBe(403);
  });

  it("cannot suspend another space", async () => {
    ctx = await createTestContext();
    const { boundAdmin, victim } = await seedBoundAdmin();

    const res = await request(
      ctx.app,
      "POST",
      `/admin/spaces/${victim}/suspend`,
      { key: boundAdmin, body: {} },
    );
    expect(res.status).toBe(403);

    const after = await spaceStore(ctx).get(victim);
    expect(after?.status).toBe("active");
  });

  it("cannot mint a credential inside another space", async () => {
    ctx = await createTestContext();
    const { boundAdmin, victim } = await seedBoundAdmin();

    const res = await request(ctx.app, "POST", `/admin/spaces/${victim}/keys`, {
      key: boundAdmin,
      body: { label: "foothold", source: "foothold", role: "space_admin" },
    });
    expect(res.status).toBe(403);
  });

  it("cannot rewrite another space's quotas", async () => {
    ctx = await createTestContext();
    const { boundAdmin, victim } = await seedBoundAdmin();

    const res = await request(ctx.app, "PUT", `/spaces/${victim}/quotas`, {
      key: boundAdmin,
      body: { items_limit: 1 },
    });
    expect(res.status).toBe(403);
  });

  it("an unbound platform admin still reaches all of it", async () => {
    ctx = await createTestContext();
    const victim = (await spaceStore(ctx).create("Victim Space")).id;
    const platform = await mintKey(ctx, {
      label: "platform-admin",
      role: "instance_admin",
      is_platform: true,
    });

    expect(
      (await request(ctx.app, "GET", "/admin/spaces", { key: platform }))
        .status,
    ).toBe(200);
    expect(
      (
        await request(ctx.app, "POST", `/admin/spaces/${victim}/suspend`, {
          key: platform,
          body: {},
        })
      ).status,
    ).toBe(200);
  });
});

describe("space config is space-scoped self-service", () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("space_admin reads and writes its own space config", async () => {
    ctx = await createTestContext();
    const space = (await spaceStore(ctx).create("Own Space")).id;
    const wsAdmin = await mintKey(ctx, {
      label: "ws-admin-config",
      role: "space_admin",
      spaceId: space,
    });

    const put = await request(ctx.app, "PUT", "/spaces/me/config", {
      key: wsAdmin,
      body: { trash_retention_days: 7 },
    });
    expect(put.status).toBe(200);

    const get = await request(ctx.app, "GET", "/spaces/me/config", {
      key: wsAdmin,
    });
    expect(get.status).toBe(200);
    expect((await get.json()) as Record<string, unknown>).toMatchObject({
      trash_retention_days: 7,
    });

    // The write landed on the caller's own space, not somewhere else.
    const stored = await spaceStore(ctx).getConfig(space);
    expect(stored?.trash_retention_days).toBe(7);
  });

  it("member is still rejected", async () => {
    ctx = await createTestContext();
    const space = (await spaceStore(ctx).create("Own Space")).id;
    const member = await mintKey(ctx, {
      label: "member-config",
      role: "member",
      spaceId: space,
    });

    const res = await request(ctx.app, "GET", "/spaces/me/config", {
      key: member,
    });
    expect(res.status).toBe(403);
  });
});
