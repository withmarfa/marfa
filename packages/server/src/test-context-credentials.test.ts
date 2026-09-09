import { describe, expect, it } from "vitest";
import { hashApiKey } from "./middleware/auth.js";
import { ensureBootstrapSecret } from "./auth/bootstrap-secret.js";
import {
  createTestContext,
  createUnbootstrappedTestApp,
  request,
  TEST_API_KEY_SALT,
} from "./test-utils.js";
import type { ApiKey } from "@withmarfa/shared";

/**
 * The suite is only evidence about the product if the credentials it
 * authenticates as are credentials the product can issue.
 *
 * A fixture is free to be convenient; it is not free to be a shape no door
 * can mint. One that is proves nothing about the credential it claims to
 * stand for, and it would pass just as happily against a build whose gates
 * were wrong in exactly the direction the fixture is wide in. So the two
 * credentials `createTestContext` hands out are compared, on every axis a
 * permission set has, against the same two credentials driven out of the
 * product's own first-mint doors.
 */

/** Every axis a credential's authority is expressed on. */
function authorityOf(key: ApiKey) {
  return {
    is_operator: key.is_operator,
    space_bound: key.space_id !== undefined,
    type_permissions: key.type_permissions,
    edge_permissions: key.edge_permissions,
    metadata_permissions: key.metadata_permissions,
    extension_permissions: key.extension_permissions,
    profile_permissions: key.profile_permissions,
    space_permissions: [...(key.space_permissions ?? [])].sort(),
  };
}

async function rowFor(
  storage: { keys: { validate: (hash: string) => Promise<ApiKey | null> } },
  rawKey: string,
): Promise<ApiKey> {
  const row = await storage.keys.validate(
    hashApiKey(rawKey, TEST_API_KEY_SALT),
  );
  if (!row) throw new Error("no api_keys row for that credential");
  return row;
}

/**
 * Drive a fresh instance through the one unauthenticated mint, which is the
 * only way an operator key comes into being and — in keys mode — the way the
 * one space and its working key do too.
 */
async function mintedByTheProduct(): Promise<{
  operator: ApiKey;
  space: ApiKey;
  cleanup: () => Promise<void>;
}> {
  const fresh = await createUnbootstrappedTestApp();
  try {
    const secret = await ensureBootstrapSecret(fresh.storage);
    const res = await request(fresh.app, "POST", "/keys", {
      key: secret,
      body: {
        label: "first",
        source: "first",
        default_tier: "library",
        // Asked for deliberately: bootstrap is a seed with no creator above
        // it, and what it does with a request that asks for everything is
        // exactly the shape a fixture has to match.
        type_permissions: { "*": "write" },
        edge_permissions: { "*": "write" },
        metadata_permissions: { "*": "write" },
        extension_permissions: { "*": "write" },
        profile_permissions: { "*": "write" },
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      key: string;
      space_key?: { key: string };
    };
    if (!body.space_key) {
      throw new Error("keys-mode bootstrap returned no space key");
    }
    return {
      operator: await rowFor(fresh.storage, body.key),
      space: await rowFor(fresh.storage, body.space_key.key),
      cleanup: fresh.cleanup,
    };
  } catch (error) {
    await fresh.cleanup();
    throw error;
  }
}

describe("the credentials createTestContext authenticates as", () => {
  it("carry the authority the product's own first mint hands out", async () => {
    const minted = await mintedByTheProduct();
    const ctx = await createTestContext();
    try {
      expect(authorityOf(await rowFor(ctx.storage, ctx.operatorKey))).toEqual(
        authorityOf(minted.operator),
      );
      expect(authorityOf(await rowFor(ctx.storage, ctx.spaceKey))).toEqual(
        authorityOf(minted.space),
      );
    } finally {
      await ctx.cleanup();
      await minted.cleanup();
    }
  });

  it("leave no credential that is space-less and not the operator tier", async () => {
    // The row constraint says space-less and operator are the same set, and a
    // principal assembled from a space-less row has no space predicate applied
    // to it at all. A seeded row that is space-less and carries reach is
    // therefore reach over every space at once, which is the one thing no
    // route will write.
    const ctx = await createTestContext();
    try {
      for (const key of await ctx.storage.keys.list()) {
        if (key.space_id) continue;
        expect(key.is_operator).toBe(true);
        expect(key.type_permissions).toEqual({});
        expect(key.edge_permissions).toEqual({});
        expect(key.metadata_permissions).toEqual({});
        expect(key.extension_permissions).toEqual({});
        expect(key.profile_permissions).toEqual({});
        expect(key.space_permissions).toEqual([]);
      }
    } finally {
      await ctx.cleanup();
    }
  });
});
