/**
 * The bearer grants API takes `grants.manage`, and holding content
 * permissions is not it.
 *
 * `GET /auth/grants` enumerates every OAuth app the owner has authorized —
 * client ids, granted scopes, last-used times — and `DELETE /auth/grants/:id`
 * kills one outright. Both are operations on other principals' access, so
 * they sit behind a permission of their own rather than behind whatever
 * content the caller happens to reach.
 *
 * A fence on the credential being bound at all says nothing about what was
 * granted: under one, a key minted with a single read scope could list
 * every connected app and revoke any of them. So the boundary is tested
 * with keys minted for it: the operator key satisfies every gate and so
 * cannot show where the boundary is.
 *
 * The session-gated twin (`POST /auth/grants/:id/revoke`) is a different
 * surface with a different principal — the signed-in human acting on their
 * own grants — and is unaffected.
 */

import { itemWrites } from "../storage/item-writes.js";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createTestContext, mintWorkingKey, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { Permission } from "@withmarfa/shared";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext({});
});

afterEach(async () => {
  await ctx.cleanup();
});

/** One active app grant, plus keys holding different permissions. */
async function seedGrant() {
  const grant = await itemWrites(ctx.storage).create({
    type: "system.connection",
    tier: "library",
    state: "active",
    properties: {
      kind: "app",
      client_id: "client_under_test",
      user_id: "auth_user_under_test",
      scopes: ["core.note:read"],
      status: "active",
      granted_at: new Date().toISOString(),
    },
    source: "test/grants-authority",
  });

  const mint = (name: string, permissions: Permission[]): Promise<string> => {
    const suffix = Math.random().toString(36).slice(2, 10);
    return mintWorkingKey(ctx, {
      label: `grants-authority-${name}-${suffix}`,
      source: `grants-authority-${name}-${suffix}`,
      permissions,
      default_tier: "library",
      // Deliberately narrow: the point is that a credential scoped to
      // one read on one type still reached an account-management
      // surface.
      type_permissions: { "core.note": "read" },
      extension_permissions: {},
      edge_permissions: {},
      metadata_permissions: {},
    });
  };

  return { grant, mint };
}

describe("the bearer grants API refuses a key without `grants.manage`", () => {
  it("refuses a key holding no permissions listing the grants", async () => {
    const { mint } = await seedGrant();
    const memberKey = await mint("narrow", []);

    const res = await request(ctx.app, "GET", "/auth/grants", {
      key: memberKey,
    });
    expect(res.status).toBe(403);
  });

  it("refuses a key holding no permissions revoking another app's grant", async () => {
    const { grant, mint } = await seedGrant();
    const memberKey = await mint("narrow", []);

    const res = await request(ctx.app, "DELETE", `/auth/grants/${grant.id}`, {
      key: memberKey,
    });
    expect(res.status).toBe(403);

    // The grant is untouched: a refused revoke must not half-apply.
    const after = await ctx.storage.items.get(grant.id);
    expect(after?.properties.status).toBe("active");
  });

  it("still admits the holder of `grants.manage`, whose job this is", async () => {
    const { grant, mint } = await seedGrant();
    const adminKey = await mint("granted", ["grants.manage"]);

    const list = await request(ctx.app, "GET", "/auth/grants", {
      key: adminKey,
    });
    expect(list.status).toBe(200);
    const body = ((await list.json()) as { data: { id: string }[] }).data;
    expect(body.some((g) => g.id === grant.id)).toBe(true);

    const revoke = await request(
      ctx.app,
      "DELETE",
      `/auth/grants/${grant.id}`,
      { key: adminKey },
    );
    expect(revoke.status).toBe(204);
  });

  it("still admits the operator key", async () => {
    await seedGrant();

    const res = await request(ctx.app, "GET", "/auth/grants", {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(200);
  });
});
