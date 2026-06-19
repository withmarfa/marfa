/**
 * Regression guard for the OAuth refresh-token before-hook
 * (`guardRefreshTokenGrant` in `oauth-provider.ts`).
 *
 * A refresh token with no matching row (e.g. orphaned by a data reset)
 * used to reach the @better-auth/oauth-provider plugin's token handler,
 * which 500s on it. A 500 is non-terminal to OAuth clients, so a stale
 * client retries hard and the storm saturated the auth rate limit,
 * blocking sign-in for everyone. The guard now returns a clean RFC 6749
 * `invalid_grant` (400) for an unknown token, which is terminal.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

describe("POST /auth/oauth2/token — unknown refresh token", () => {
  it("returns 400 invalid_grant, never 500", async () => {
    ctx = await createTestContext();

    const res = await ctx.app.request("/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: "marfa_rt_does_not_exist",
        client_id: "marfa-tickets",
      }).toString(),
    });

    // The key property: a clean terminal 400, not a 500 that would make a
    // stale client retry-storm.
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("invalid_grant");
  });
});
