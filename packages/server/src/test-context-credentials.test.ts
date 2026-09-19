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
    type_permissions: key.type_permissions,
    edge_permissions: key.edge_permissions,
    metadata_permissions: key.metadata_permissions,
    extension_permissions: key.extension_permissions,
    profile_permissions: key.profile_permissions,
    permissions: [...(key.permissions ?? [])].sort(),
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
 * only way an operator key comes into being, and then through the mint the
 * operator makes with it, which is how the working key does.
 */
async function mintedByTheProduct(): Promise<{
  operator: ApiKey;
  space: ApiKey;
  /** The operator key itself, for driving the doors that mint from it. */
  operatorRaw: string;
  app: Awaited<ReturnType<typeof createUnbootstrappedTestApp>>;
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
    const body = (await res.json()) as { key: string };
    // A body naming nothing takes everything from the operator key, which is
    // a seed rather than a ceiling.
    const working = await request(fresh.app, "POST", "/keys", {
      key: body.key,
      body: { label: "working", source: "working", default_tier: "library" },
    });
    expect(working.status).toBe(201);
    const workingBody = (await working.json()) as { key: string };
    return {
      operator: await rowFor(fresh.storage, body.key),
      space: await rowFor(fresh.storage, workingBody.key),
      operatorRaw: body.key,
      app: fresh,
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

  it("cannot be widened into that shape afterwards either", async () => {
    // The first mint is only half the claim. A fixture the product cannot
    // seed is worth nothing if a door two steps later writes the same row,
    // and two of them could: the creator ceiling exempts the operator key,
    // which is right for the working key it seeds and wrong for a second
    // operator key, and `PATCH /keys/{id}` addresses the operator row too.
    const minted = await mintedByTheProduct();
    try {
      const wide = {
        type_permissions: { "*": "write" },
        edge_permissions: { "*": "write" },
        metadata_permissions: { "*": "write" },
        extension_permissions: { "*": "write" },
        profile_permissions: { "*": "write" },
      };

      // Minting a second operator key that would hold something.
      const minting = await request(minted.app.app, "POST", "/keys", {
        key: minted.operatorRaw,
        body: {
          label: "second",
          source: "second",
          default_tier: "library",
          is_operator: true,
          ...wide,
        },
      });
      expect(minting.status).toBe(403);

      // And widening the operator key in place, which is the shorter path.
      const patching = await request(
        minted.app.app,
        "PATCH",
        `/keys/${minted.operator.id}`,
        { key: minted.operatorRaw, body: wide },
      );
      expect(patching.status).toBe(403);

      const patchingPermissions = await request(
        minted.app.app,
        "PATCH",
        `/keys/${minted.operator.id}`,
        {
          key: minted.operatorRaw,
          body: { permissions: ["keys.mint"] },
        },
      );
      expect(patchingPermissions.status).toBe(403);

      // Nothing moved on the row either way.
      expect(
        authorityOf(await rowFor(minted.app.storage, minted.operatorRaw)),
      ).toEqual(authorityOf(minted.operator));

      // A spare operator key is still mintable: it names no reach, so it is
      // refused by none of this.
      const spare = await request(minted.app.app, "POST", "/keys", {
        key: minted.operatorRaw,
        body: {
          label: "spare",
          source: "spare",
          default_tier: "library",
          is_operator: true,
        },
      });
      expect(spare.status).toBe(201);
      const spareKey = ((await spare.json()) as { key: string }).key;
      expect(authorityOf(await rowFor(minted.app.storage, spareKey))).toEqual(
        authorityOf(minted.operator),
      );
    } finally {
      await minted.cleanup();
    }
  });

  it("leave no operator credential that holds anything", async () => {
    // The row constraint says an operator key holds nothing, and a seeded
    // operator row that carries reach is the one thing no route will write.
    const ctx = await createTestContext();
    try {
      for (const key of await ctx.storage.keys.list()) {
        if (!key.is_operator) continue;
        expect(key.type_permissions).toEqual({});
        expect(key.edge_permissions).toEqual({});
        expect(key.metadata_permissions).toEqual({});
        expect(key.extension_permissions).toEqual({});
        expect(key.profile_permissions).toEqual({});
        expect(key.permissions).toEqual([]);
      }
    } finally {
      await ctx.cleanup();
    }
  });
});
