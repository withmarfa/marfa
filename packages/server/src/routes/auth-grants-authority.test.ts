/**
 * The bearer grants API takes `space.app_grants`, and holding content
 * permissions is not it.
 *
 * `GET /auth/grants` enumerates every OAuth app a space has authorized —
 * client ids, granted scopes, last-used times — and `DELETE /auth/grants/:id`
 * kills one outright. Both are operations on other principals' access, so
 * they sit behind a space permission of their own rather than behind whatever
 * content the caller happens to reach.
 *
 * Both routes originally fenced only the space: a credential with no
 * `space_id` was refused, because an unbound one would have addressed every
 * space's grants. That check says nothing about what was granted, so a key
 * minted with a single read scope could list the space's integrations and
 * revoke any of them. Nothing caught it because the one test covering these
 * routes used the operator key, which satisfies every gate in the codebase and
 * so tells you nothing about where the boundary actually is.
 *
 * The session-gated twin (`POST /auth/grants/:id/revoke`) is a different
 * surface with a different principal — the signed-in human acting on their
 * own space — and is unaffected.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { SpacePermission } from "@withmarfa/shared";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext({ authMode: "hosted" });
});

afterEach(async () => {
  await ctx.cleanup();
});

function spaces() {
  if (!ctx.storage.spaces) {
    throw new Error("hosted-mode storage missing space store");
  }
  return ctx.storage.spaces;
}

/** A space holding one active app grant, plus keys at each rank in it. */
async function seedSpaceWithGrant() {
  const space = await spaces().create("grants-authority-space");
  const grant = await ctx.storage.items.create(
    {
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
    },
    space.id,
  );

  // Mint through the real route so the credential is exactly what an
  // operator's own key would be, permission maps and all.
  const mint = async (
    name: string,
    spacePermissions: SpacePermission[],
  ): Promise<string> => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const res = await request(
      ctx.app,
      "POST",
      `/admin/spaces/${space.id}/keys`,
      {
        key: ctx.adminKey,
        body: {
          label: `grants-authority-${name}-${suffix}`,
          source: `grants-authority-${name}-${suffix}`,
          space_permissions: spacePermissions,
          default_tier: "library",
          // Deliberately narrow: the point is that a credential scoped to
          // one read on one type still reached an account-management
          // surface.
          type_permissions: { "core.note": "read" },
          extension_permissions: {},
          edge_permissions: {},
        },
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { key: string };
    return body.key;
  };

  return { space, grant, mint };
}

describe("the bearer grants API refuses a key without `space.app_grants`", () => {
  it("refuses a key holding no space permissions listing the space's grants", async () => {
    const { mint } = await seedSpaceWithGrant();
    const memberKey = await mint("narrow", []);

    const res = await request(ctx.app, "GET", "/auth/grants", {
      key: memberKey,
    });
    expect(res.status).toBe(403);
  });

  it("refuses a key holding no space permissions revoking another app's grant", async () => {
    const { grant, mint } = await seedSpaceWithGrant();
    const memberKey = await mint("narrow", []);

    const res = await request(ctx.app, "DELETE", `/auth/grants/${grant.id}`, {
      key: memberKey,
    });
    expect(res.status).toBe(403);

    // The grant is untouched: a refused revoke must not half-apply.
    const after = await ctx.storage.items.get(grant.id, undefined);
    expect(after?.properties.status).toBe("active");
  });

  it("still admits the holder of `space.app_grants`, whose job this is", async () => {
    const { grant, mint } = await seedSpaceWithGrant();
    const adminKey = await mint("granted", ["space.app_grants"]);

    const list = await request(ctx.app, "GET", "/auth/grants", {
      key: adminKey,
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { id: string }[];
    expect(body.some((g) => g.id === grant.id)).toBe(true);

    const revoke = await request(
      ctx.app,
      "DELETE",
      `/auth/grants/${grant.id}`,
      { key: adminKey },
    );
    expect(revoke.status).toBe(204);
  });

  it("still admits the operator key, which the space fence already allowed", async () => {
    await seedSpaceWithGrant();

    const res = await request(ctx.app, "GET", "/auth/grants", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
  });
});
