/**
 * `keys.revoke` answers with which of its outcomes happened rather
 * than with a boolean, because two of them are misses and a caller refusing
 * on one of them owes the person a reason.
 *
 * It used to return `void`, so the only thing a caller could report was the
 * read it took beforehand — a claim about the moment before the write rather
 * than about the write.
 *
 * Runs against real storage, so the outcome is held to the contract rather
 * than assumed.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashApiKey } from "../middleware/auth.js";
import type { TestContext } from "../test-utils.js";
import {
  createTestContext,
  mintWorkingKey,
  TEST_API_KEY_SALT,
} from "../test-utils.js";

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
  it("answers `revoked` on the call that revokes and `already_revoked` after", async () => {
    const suffix = uniqueSuffix();
    const raw = await mintWorkingKey(ctx, {
      label: `affected-rows ${suffix}`,
      source: `affected-rows-${suffix}`,
      permissions: [],
      type_permissions: {},
      extension_permissions: {},
      edge_permissions: {},
      metadata_permissions: {},
      profile_permissions: {},
    });
    const key = await ctx.storage.keys.validate(
      hashApiKey(raw, TEST_API_KEY_SALT),
    );
    if (!key) throw new Error("Owner-minted key was not stored");

    expect(await ctx.storage.keys.revoke(key.id)).toBe("revoked");
    // A second revoke changes nothing, and saying otherwise is what let an
    // uninstall list a credential it had not retired.
    expect(await ctx.storage.keys.revoke(key.id)).toBe("already_revoked");
  });

  // **The two misses are told apart here and nowhere above.** `keys.get`
  // drops revoked rows, so a route asking after the fact cannot separate a
  // key already retired from an id nobody ever held, and the caller was told
  // success for both.
  it("names a key that does not exist rather than lumping it in", async () => {
    expect(await ctx.storage.keys.revoke(randomUUID())).toBe("not_found");
  });
});
