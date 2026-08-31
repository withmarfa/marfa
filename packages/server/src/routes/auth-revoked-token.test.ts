/**
 * A revoked OAuth access token has to stop authenticating.
 *
 * `revoked` is stamped on the token row by the provider plugin when the
 * session it was issued under ends, so signing out is what usually sets it.
 * Nothing here read the column: `validateAccessToken` consulted the clock
 * and nothing else, so an app kept serving data on its stored bearer after
 * the person using it had signed out, and the only signal that anything had
 * happened was the app clearing its own local storage on the way out.
 *
 * The scope of this file is the half that was wrong — the store refusing a
 * revoked row, at the API boundary where it matters, in both dialects. That
 * the plugin stamps the column on end-session is its own behavior and is
 * verified against a running deployment rather than re-implemented here.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { request, createTestContext, seedOauthBearer } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

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

/** Stamp `revoked` on every access token for a client, which is what the
 *  provider plugin's session-delete hook does to the tokens issued under a
 *  session that has just ended. */
async function revokeAccessTokens(clientId: string): Promise<void> {
  const schemaModule =
    ctx.storage.betterAuthDialect === "pg"
      ? await import("../storage/pg/schema.js")
      : await import("../storage/sqlite/schema.js");
  const db = ctx.storage.betterAuthDb as {
    update: (table: unknown) => {
      set: (v: Record<string, unknown>) => {
        where: (w: unknown) => {
          run?: () => Promise<unknown>;
          execute?: () => Promise<unknown>;
        };
      };
    };
  };
  const op = db
    .update(schemaModule.auth_oauth_access_token)
    .set({ revoked: new Date() })
    .where(eq(schemaModule.auth_oauth_access_token.clientId, clientId));
  await (op.execute?.() ?? op.run?.() ?? Promise.resolve());
}

describe("a revoked OAuth access token", () => {
  it("stops authenticating, though its expiry has not passed", async () => {
    const space = await spaces().create("revoked-token-space");
    const { token, clientId } = await seedOauthBearer(ctx.storage, [], {
      spaceId: space.id,
      userRole: "instance_admin",
    });

    // The token is live: an hour of expiry left, and it authenticates.
    const before = await request(ctx.app, "GET", "/keys", { key: token });
    expect(before.status).toBe(200);

    await revokeAccessTokens(clientId);

    // Same token, same unexpired lifetime, and now refused. Before this,
    // the row's `revoked` stamp was invisible to the bearer path and the
    // request above kept succeeding.
    const after = await request(ctx.app, "GET", "/keys", { key: token });
    expect(after.status).toBe(401);
  });

  it("is refused by the store itself, not only at the route", async () => {
    const space = await spaces().create("revoked-store-space");
    const { token, clientId } = await seedOauthBearer(ctx.storage, [], {
      spaceId: space.id,
      userRole: "instance_admin",
    });

    const { hashApiKey } = await import("../middleware/auth.js");
    const { TEST_API_KEY_SALT } = await import("../test-utils.js");
    const hash = hashApiKey(token.slice("marfa_at_".length), TEST_API_KEY_SALT);

    const store = ctx.storage.oauthProvider;
    if (!store) throw new Error("no oauthProvider store");

    expect(await store.validateAccessToken(hash)).not.toBeNull();
    await revokeAccessTokens(clientId);
    expect(await store.validateAccessToken(hash)).toBeNull();
  });
});
