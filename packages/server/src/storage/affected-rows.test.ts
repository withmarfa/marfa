/**
 * The three lifecycle mutations the connection pipelines report on answer
 * with what they changed. `keys.revoke` answers with which of its three
 * outcomes happened rather than with a boolean, because two of them are
 * misses and a caller refusing on one of them owes the person a reason.
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
        type_permissions: {},
        // Space-less and operator go together: the row constraint holds the
        // pair, so a key with no space cannot be anything else.
        is_operator: true,
      },
      hashApiKey(`marfa_k1_affected_rows_${suffix}`, TEST_API_KEY_SALT),
      undefined,
    );

    expect(await ctx.storage.keys.revoke(key.id)).toBe("revoked");
    // A second revoke changes nothing, and saying otherwise is what let an
    // uninstall list a credential it had not retired.
    expect(await ctx.storage.keys.revoke(key.id)).toBe("already_revoked");
  });

  // **The two misses are told apart here and nowhere above.** `keys.get`
  // drops revoked rows, so a route asking after the fact cannot separate a
  // key already retired from an id nobody ever held, and the one caller that
  // skips the space fence was told success for both.
  it("names a key that does not exist rather than lumping it in", async () => {
    expect(await ctx.storage.keys.revoke(randomUUID())).toBe("not_found");
  });
});
