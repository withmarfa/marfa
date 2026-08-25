/**
 * Bearer middleware role projection for OAuth principals.
 *
 * The middleware reads the underlying `users.role` for the auth_user the
 * token was issued to, so admin-gated READ/manage routes (e.g. GET /keys)
 * work for OAuth-authenticated admins. Minting a credential is the one
 * exception: POST /keys is blocked for OAuth callers so an app cannot launder
 * a scoped grant into an unconstrained API key. The `is_platform` flag stays
 * hardcoded false on OAuth principals regardless — platform-admin is an
 * operator-tier flag exclusive to API keys with explicit `is_platform: true`.
 *
 * Tests run hosted-mode (`storage.users` present) so the role-projection
 * lookup has a `users` row to consult.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { request, createTestContext, seedOauthBearer } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { MarfaRole } from "@withmarfa/shared";

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

describe("bearer middleware role projection (OAuth)", () => {
  it("projects users.role 'admin' onto the OAuth principal — /keys CRUD succeeds", async () => {
    const space = await spaces().create("admin-space");
    const { token } = await seedOauthBearer(
      ctx.storage,
      // No data-plane scopes needed — /keys is gated on role, not scopes.
      [],
      { spaceId: space.id, userRole: "admin" },
    );

    const res = await request(ctx.app, "GET", "/keys", { key: token });
    expect(res.status).toBe(200);
  });

  it("projects users.role 'space_admin' onto the OAuth principal — /keys CRUD succeeds (space-scoped)", async () => {
    const space = await spaces().create("space-admin-space");
    const { token } = await seedOauthBearer(ctx.storage, [], {
      spaceId: space.id,
      userRole: "space_admin",
    });

    const res = await request(ctx.app, "GET", "/keys", { key: token });
    expect(res.status).toBe(200);
  });

  it("projects users.role 'member' onto the OAuth principal — /keys CRUD forbidden", async () => {
    const space = await spaces().create("member-space");
    const { token } = await seedOauthBearer(ctx.storage, [], {
      spaceId: space.id,
      userRole: "member",
    });

    const res = await request(ctx.app, "GET", "/keys", { key: token });
    // Authenticated but insufficient role → 403, not 401. The gate is
    // gradient: admin/space_admin pass, member fails.
    expect(res.status).toBe(403);
  });

  it("falls back to 'member' when no users row exists for the auth_user — /keys CRUD forbidden", async () => {
    // Space-bound token whose users row is gone (deleted after issuance):
    // the role-projection lookup misses and falls back to `member`. The
    // space binding is what keeps the token resolvable at all — a token
    // with no space is refused outright in hosted mode before projection
    // runs (see auth.spaceless-oauth.test.ts).
    const space = await spaces().create("orphaned-user-space");
    const { token } = await seedOauthBearer(ctx.storage, [], {
      spaceId: space.id,
    });

    const res = await request(ctx.app, "GET", "/keys", { key: token });
    expect(res.status).toBe(403);
  });

  it("refuses a stored role this build does not recognize, /keys CRUD forbidden", async () => {
    // The case every other test here misses: not a role below the bar, but a
    // string outside the union entirely. A rename left every account holder
    // holding `tenant_admin`, which matched no branch in any gate, so the
    // refusal below was already the behavior, what was missing was anything
    // asserting it, and the same value read as "not below space_admin" where
    // a gate compared ranks instead of literals.
    //
    // The cast is the point. Nothing reachable from TypeScript can write this
    // value, which is exactly why it sat in two production databases
    // unnoticed, so constructing the state needs the type system stepped
    // around deliberately.
    const space = await spaces().create("stale-role-space");
    const { token } = await seedOauthBearer(ctx.storage, [], {
      spaceId: space.id,
      userRole: "tenant_admin" as MarfaRole,
    });

    const res = await request(ctx.app, "GET", "/keys", { key: token });
    expect(res.status).toBe(403);
  });

  it("blocks an admin OAuth principal from minting an API key (no grant laundering)", async () => {
    const space = await spaces().create("platform-ceiling-space");
    const { token } = await seedOauthBearer(ctx.storage, [], {
      spaceId: space.id,
      userRole: "admin",
    });

    // The role projection lets an admin OAuth token READ keys (above), but
    // MINTING is blocked for OAuth callers: an API key bypasses the
    // permission maps the OAuth grant is held to, so allowing it would let an
    // app escalate a narrow grant into a durable, unconstrained credential.
    // The `is_platform: true` in the body never matters — the request is
    // rejected before the mint. (See routes/keys.ts — the authType === "oauth"
    // block in the non-bootstrap branch.)
    const res = await request(ctx.app, "POST", "/keys", {
      key: token,
      body: {
        label: "should-be-blocked",
        source: "test-role-projection",
        role: "member",
        is_platform: true,
      },
    });
    expect(res.status).toBe(403);
  });
});
