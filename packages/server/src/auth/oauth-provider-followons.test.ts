/**
 * Storage-primitive coverage for OAuth grant lookup.
 *
 * These lookups do not exercise refresh rotation or replay, which require
 * live token requests.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  createTestContext,
  seedOauthBearer,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

describe("OauthProviderStore.findGrantItemId", () => {
  it("returns the projected system.connection item id for a (clientId, authUserId) pair", async () => {
    ctx = await createTestContext();
    const seeded = await seedOauthBearer(ctx.storage, ["core.note:read"]);
    const grant = await ctx.storage.items.get(seeded.grantId);
    expect(grant).not.toBeNull();
    const authUserId = grant!.properties.user_id;
    expect(typeof authUserId).toBe("string");

    const got = await ctx.storage.oauthProvider?.findGrantItemId({
      clientId: seeded.clientId,
      authUserId: authUserId as string,
    });
    expect(got).toBe(seeded.grantId);
  });

  it("returns null when no projection exists for the pair", async () => {
    ctx = await createTestContext();
    const got = await ctx.storage.oauthProvider?.findGrantItemId({
      clientId: "client_nonexistent",
      authUserId: "auth_user_nonexistent",
    });
    expect(got).toBeNull();
  });
});

describe("OauthProviderStore.findRefreshTokenGrantKey", () => {
  it("returns null for a hash that does not identify a refresh token", async () => {
    ctx = await createTestContext();
    await seedOauthBearer(ctx.storage, ["core.note:read"]);
    const hash = createHmac("sha256", TEST_API_KEY_SALT)
      .update("marfa_rt_nonexistent")
      .digest("hex");
    const got = await ctx.storage.oauthProvider?.findRefreshTokenGrantKey(hash);
    expect(got).toBeNull();
  });
});
