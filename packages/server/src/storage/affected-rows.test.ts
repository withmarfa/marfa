/**
 * The three lifecycle mutations the connection pipelines report on answer
 * with what they changed.
 *
 * Each of them used to return `void`, so the only thing a caller could
 * report was the read it took beforehand — a claim about the moment before
 * the write rather than about the write. `connectionLeasedTokens.revoke`
 * was the exception and, not coincidentally, the one honest counter in the
 * uninstall pipeline. These are the other three brought up to it.
 *
 * Runs against real storage in whichever dialect the suite is running, so
 * the Postgres `RETURNING` and the SQLite `rowsAffected` shapes are held to
 * the same contract rather than only one of them being covered.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, TEST_API_KEY_SALT } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

describe("keys.revoke", () => {
  it("answers true on the call that revokes and false on every call after", async () => {
    const suffix = uniqueSuffix();
    const key = await ctx.storage.keys.create(
      {
        label: `affected-rows ${suffix}`,
        source: `affected-rows-${suffix}`,
        role: "member",
        type_permissions: {},
      },
      hashApiKey(`marfa_k1_affected_rows_${suffix}`, TEST_API_KEY_SALT),
      undefined,
    );

    expect(await ctx.storage.keys.revoke(key.id)).toBe(true);
    // A second revoke changes nothing, and saying otherwise is what let an
    // uninstall list a credential it had not retired.
    expect(await ctx.storage.keys.revoke(key.id)).toBe(false);
  });

  it("answers false for a key that does not exist", async () => {
    expect(await ctx.storage.keys.revoke(randomUUID())).toBe(false);
  });
});

describe("connectionOauthTokens.delete", () => {
  it("answers true for the delete that removes the row and false when there was none", async () => {
    const connectionId = randomUUID();

    // Nothing stored yet: the honest answer is that nothing was deleted.
    expect(
      await ctx.storage.connectionOauthTokens.delete(connectionId, undefined),
    ).toBe(false);

    await ctx.storage.connectionOauthTokens.upsert({
      connection_id: connectionId,
      access_token_encrypted: "a|b|c",
      refresh_token_encrypted: null,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      scopes: ["read"],
    });

    expect(
      await ctx.storage.connectionOauthTokens.delete(connectionId, undefined),
    ).toBe(true);
    expect(
      await ctx.storage.connectionOauthTokens.delete(connectionId, undefined),
    ).toBe(false);
  });
});

describe("inboundWebhooks.setDisabled", () => {
  it("answers true only when the flag moves", async () => {
    const id = randomUUID();
    await ctx.storage.inboundWebhooks.create({
      id,
      connection_id: randomUUID(),
      secret_encrypted: "a|b|c",
      verification_method: "hmac-sha256",
      events: ["thing.happened"],
    });

    expect(await ctx.storage.inboundWebhooks.setDisabled(id, true)).toBe(true);
    // Already disabled. Counting this would report a subscription the
    // uninstall disabled when something else had already done it.
    expect(await ctx.storage.inboundWebhooks.setDisabled(id, false)).toBe(true);
    expect(await ctx.storage.inboundWebhooks.setDisabled(id, false)).toBe(
      false,
    );
  });

  it("answers false for a subscription that does not exist", async () => {
    expect(
      await ctx.storage.inboundWebhooks.setDisabled(randomUUID(), true),
    ).toBe(false);
  });
});
