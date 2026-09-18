/**
 * Regression suite for the two fences that stop a credential reaching past
 * the authority it was given.
 *
 * 1. **A mint never exceeds its caller.** `POST /keys` takes the new key's
 *    space permissions from the request body, so a credential asking for one
 *    it does not hold itself would widen by minting. The clamp refuses by
 *    name; a peer mint of what the caller already holds is permitted, because
 *    privilege travels sideways or down.
 *
 * 2. **The operator tier is the absence of a space binding.**
 *    `checkOperatorKey` reads `is_operator` *and* the space together, so a
 *    credential bound to a space reaches none of `/admin/*` however it came
 *    to exist. Operator authority is authority not confined to a space.
 *
 * Each layer is tested on its own, because either fence holding says nothing
 * about the other.
 */

import { describe, it, expect, afterEach } from "vitest";
import type { ApiKey, SpacePermission } from "@withmarfa/shared";
import { MarfaError, ErrorCode } from "@withmarfa/shared";
import { checkOperatorKey, hashApiKey } from "./auth.js";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
  type TestContext,
} from "../test-utils.js";
import type { Storage } from "../storage/interface.js";

// ---------------------------------------------------------------------------
// Unit — checkOperatorKey reads the flag and the space binding together
// ---------------------------------------------------------------------------

function fakeKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: "key-test",
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

describe("checkOperatorKey (unit)", () => {
  it("admits an unbound operator key", () => {
    const key = fakeKey({ is_operator: true });
    expect(checkOperatorKey(key)).toBe(key);
  });

  it("rejects a space-bound operator key with FORBIDDEN", () => {
    // The row constraint holds the pair together, so no store hands this
    // shape back today. The gate still asks both questions, because reading
    // `is_operator` alone would readmit anything that ever gained the flag
    // while bound to a space — which is what the constraint protects and not
    // something this function should depend on.
    const key = fakeKey({ is_operator: true, space_id: "space-a" });
    expect(() => checkOperatorKey(key)).toThrow(MarfaError);
    try {
      checkOperatorKey(key);
    } catch (e) {
      expect((e as MarfaError).code).toBe(ErrorCode.FORBIDDEN);
    }
  });

  it("rejects a credential without the operator flag", () => {
    expect(() => checkOperatorKey(fakeKey({ space_id: "space-a" }))).toThrow(
      MarfaError,
    );
    expect(() => checkOperatorKey(fakeKey())).toThrow(MarfaError);
  });

  it("rejects undefined with UNAUTHORIZED", () => {
    try {
      checkOperatorKey(undefined);
      expect.unreachable(
        "checkOperatorKey must throw for a missing credential",
      );
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
    spaceId?: string;
    spacePermissions?: SpacePermission[];
    is_operator?: boolean;
  },
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 14);
  const raw = `marfa_k1_escalation_test_${suffix}`;
  await ctx.storage.keys.create(
    {
      label: opts.label,
      source: `${opts.label}-${suffix}`,
      space_permissions: opts.spacePermissions ?? [],
      default_tier: "library",
      type_permissions: {},
      is_operator: opts.is_operator ?? false,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
    opts.spaceId,
  );
  return raw;
}

describe("the mint never exceeds the caller", () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx.cleanup();
  });

  it("refuses a space permission the caller does not hold, by name", async () => {
    ctx = await createTestContext();
    const spaceA = `space-a-${Math.random().toString(36).slice(2, 10)}`;
    const caller = await mintKey(ctx, {
      label: "clamp-caller",
      spaceId: spaceA,
      spacePermissions: ["space.keys", "space.webhooks"],
    });

    const res = await request(ctx.app, "POST", "/keys", {
      key: caller,
      body: {
        label: "escalated",
        source: `escalated-${Math.random().toString(36).slice(2, 10)}`,
        default_tier: "library",
        space_permissions: ["space.settings"],
      },
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { code: string; details?: { required_scope?: string } };
    };
    expect(body.error.code).toBe("forbidden");
    // The refusal names the literal, so a client can narrow toward something
    // it could actually be granted.
    expect(body.error.details?.required_scope).toBe("space.settings");
  });

  it("permits a peer mint of what the caller already holds", async () => {
    ctx = await createTestContext();
    const spaceA = `space-a-${Math.random().toString(36).slice(2, 10)}`;
    const caller = await mintKey(ctx, {
      label: "peer-caller",
      spaceId: spaceA,
      spacePermissions: ["space.keys", "space.webhooks"],
    });

    const res = await request(ctx.app, "POST", "/keys", {
      key: caller,
      body: {
        label: "peer",
        source: `peer-${Math.random().toString(36).slice(2, 10)}`,
        default_tier: "library",
        space_permissions: ["space.webhooks"],
      },
    });

    expect(res.status).toBe(201);
    const minted = (await res.json()) as { id: string };

    // Read back from the store rather than from the response: the stored row
    // is what the credential actually holds, and it is what a later gate asks.
    const stored = await ctx.storage.keys.get(minted.id);
    expect(stored?.space_permissions).toEqual(["space.webhooks"]);
    // The new key inherits the caller's space, so its reach stops where the
    // caller's does on the other axis too.
    expect(stored?.space_id).toBe(spaceA);
  });
});

describe("the operator tier — a space-bound credential has no cross-space authority", () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx.cleanup();
  });

  async function seedBoundCaller(): Promise<{
    boundCaller: string;
    victim: string;
  }> {
    const victim = (await spaceStore(ctx).create("Victim Space")).id;
    const attacker = (await spaceStore(ctx).create("Attacker Space")).id;
    // Broad in-space authority and still no operator flag: the point is that
    // no amount of it adds up to the instance tier.
    const boundCaller = await mintKey(ctx, {
      label: "bound-caller",
      spaceId: attacker,
      spacePermissions: ["space.keys", "space.settings", "space.usage"],
    });
    return { boundCaller, victim };
  }

  it("cannot enumerate spaces", async () => {
    ctx = await createTestContext();
    const { boundCaller } = await seedBoundCaller();

    const res = await request(ctx.app, "GET", "/admin/spaces", {
      key: boundCaller,
    });
    expect(res.status).toBe(403);
  });

  it("cannot read another space's row", async () => {
    ctx = await createTestContext();
    const { boundCaller, victim } = await seedBoundCaller();

    const res = await request(ctx.app, "GET", `/admin/spaces/${victim}`, {
      key: boundCaller,
    });
    expect(res.status).toBe(403);
  });

  it("cannot suspend another space", async () => {
    ctx = await createTestContext();
    const { boundCaller, victim } = await seedBoundCaller();

    const res = await request(
      ctx.app,
      "POST",
      `/admin/spaces/${victim}/suspend`,
      { key: boundCaller, body: {} },
    );
    expect(res.status).toBe(403);

    const after = await spaceStore(ctx).get(victim);
    expect(after?.status).toBe("active");
  });

  it("cannot mint a credential inside another space", async () => {
    ctx = await createTestContext();
    const { boundCaller, victim } = await seedBoundCaller();

    const res = await request(ctx.app, "POST", `/admin/spaces/${victim}/keys`, {
      key: boundCaller,
      body: { label: "foothold", source: "foothold" },
    });
    expect(res.status).toBe(403);
  });

  it("cannot rewrite another space's quotas", async () => {
    ctx = await createTestContext();
    const { boundCaller, victim } = await seedBoundCaller();

    const res = await request(ctx.app, "PUT", `/spaces/${victim}/quotas`, {
      key: boundCaller,
      body: { items_limit: 1 },
    });
    expect(res.status).toBe(403);
  });

  it("an unbound operator key still reaches all of it", async () => {
    ctx = await createTestContext();
    const victim = (await spaceStore(ctx).create("Victim Space")).id;
    const operator = await mintKey(ctx, {
      label: "operator-key",
      is_operator: true,
    });

    expect(
      (await request(ctx.app, "GET", "/admin/spaces", { key: operator }))
        .status,
    ).toBe(200);
    expect(
      (
        await request(ctx.app, "POST", `/admin/spaces/${victim}/suspend`, {
          key: operator,
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

  it("a holder of space.settings reads and writes its own space config", async () => {
    ctx = await createTestContext();
    const space = (await spaceStore(ctx).create("Own Space")).id;
    const caller = await mintKey(ctx, {
      label: "config-holder",
      spaceId: space,
      spacePermissions: ["space.settings"],
    });

    const put = await request(ctx.app, "PUT", "/spaces/me/config", {
      key: caller,
      body: { trash_retention_days: 7 },
    });
    expect(put.status).toBe(200);

    const get = await request(ctx.app, "GET", "/spaces/me/config", {
      key: caller,
    });
    expect(get.status).toBe(200);
    expect((await get.json()) as Record<string, unknown>).toMatchObject({
      trash_retention_days: 7,
    });

    // The write landed on the caller's own space, not somewhere else.
    const stored = await spaceStore(ctx).getConfig(space);
    expect(stored?.trash_retention_days).toBe(7);
  });

  it("refuses a credential that does not hold space.settings", async () => {
    ctx = await createTestContext();
    const space = (await spaceStore(ctx).create("Own Space")).id;
    const caller = await mintKey(ctx, {
      label: "config-none",
      spaceId: space,
    });

    const res = await request(ctx.app, "GET", "/spaces/me/config", {
      key: caller,
    });
    expect(res.status).toBe(403);
  });
});
