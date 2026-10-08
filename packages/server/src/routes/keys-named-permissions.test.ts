/**
 * A key holds exactly what its mint body names.
 *
 * Naming `permissions` is naming a family, as naming a map or `sources` is, so
 * a body that names only permissions yields those permissions and no reach: no
 * map entry and no claimed source. Only a body naming none of the seven
 * families takes the creator's whole set.
 *
 * **Every refusal is paired with the same request answered for a key that
 * holds the reach**, so a door that refused everything cannot satisfy it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PERMISSIONS, type Permission } from "@withmarfa/shared";
import {
  createTestContext,
  mintWorkingKey,
  request,
  seedOauthBearer,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;
let fullKey: string;

beforeAll(async () => {
  ctx = await createTestContext();
  fullKey = await mintWorkingKey(ctx, { permissions: [...PERMISSIONS] });
});

afterAll(async () => {
  await ctx.cleanup();
});

interface MintedKey {
  id: string;
  key: string;
  permissions: Permission[];
  sources: string[];
  type_permissions: Record<string, string>;
  edge_permissions: Record<string, string>;
  metadata_permissions: Record<string, string>;
  extension_permissions: Record<string, string>;
  profile_permissions: Record<string, string>;
}

async function mint(
  minter: string | undefined,
  body: Record<string, unknown>,
): Promise<MintedKey> {
  const suffix = Math.random().toString(36).slice(2, 12);
  const res = await request(ctx.app, "POST", "/keys", {
    ...(minter
      ? { key: minter }
      : {
          headers: {
            cookie: ctx.owner.cookie,
            origin: new URL(ctx.config.authBaseUrl).origin,
          },
        }),
    body: { label: `named-${suffix}`, source: `named-${suffix}`, ...body },
  });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return (await res.json()) as MintedKey;
}

const MAPS = [
  "type_permissions",
  "edge_permissions",
  "metadata_permissions",
  "extension_permissions",
  "profile_permissions",
] as const;

const NOTE = {
  type: "core.note",
  properties: { title: "a note", body: "a note" },
};

const minters = [
  ["a full key", () => fullKey],
  ["the direct owner", () => undefined],
] as const;

describe("a mint naming only permissions", () => {
  // The witness: the full key reaches items and types, so the refusals below
  // are the lack of reach rather than a door that refuses everyone.
  it("is a key the reach questions below can tell from one that holds it", async () => {
    const item = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: NOTE,
    });
    expect(item.status).toBe(201);
    const type = await request(ctx.app, "POST", "/types", {
      key: ctx.workingKey,
      body: { id: "user.named_witness", version: 1, fields: {} },
    });
    expect([201, 409]).toContain(type.status);
  });

  for (const [who, minter] of minters) {
    for (const permission of PERMISSIONS) {
      it(`gives ${who} a key holding ${permission} and no reach`, async () => {
        const minted = await mint(minter(), { permissions: [permission] });

        expect(minted.permissions).toEqual([permission]);
        for (const map of MAPS) {
          expect(minted[map], `${map} was copied or seeded`).toEqual({});
        }
        expect(minted.sources).toEqual([]);

        const row = await ctx.storage.keys.get(minted.id);
        expect(row?.permissions).toEqual([permission]);
        for (const map of MAPS) expect(row?.[map] ?? {}).toEqual({});
        expect(row?.sources ?? []).toEqual([]);

        const seeded = await request(ctx.app, "POST", "/items", {
          key: ctx.workingKey,
          body: NOTE,
        });
        expect(seeded.status).toBe(201);
        const { item } = (await seeded.json()) as { item: { id: string } };
        const id = item.id;

        const write = await request(ctx.app, "POST", "/items", {
          key: minted.key,
          body: NOTE,
        });
        expect(write.status).toBe(403);
        const read = await request(ctx.app, "GET", `/items/${id}`, {
          key: minted.key,
        });
        expect(read.status).toBe(403);
        const register = await request(ctx.app, "POST", "/types", {
          key: minted.key,
          body: {
            id: `user.refused_${permission.replace(".", "_")}`,
            version: 1,
            fields: {},
          },
        });
        expect(register.status).toBe(403);
      });
    }
  }

  it("holds nothing when it names an empty list, since naming it is naming a family", async () => {
    for (const [, minter] of minters) {
      const minted = await mint(minter(), { permissions: [] });
      expect(minted.permissions).toEqual([]);
      for (const map of MAPS) expect(minted[map]).toEqual({});
    }
  });

  it("takes nothing from a creator that claims sources and holds maps", async () => {
    const creator = await mint(undefined, {
      permissions: ["audit.read", "keys.mint"],
      type_permissions: { "core.note": "write" },
      edge_permissions: { "*": "read" },
      sources: ["named-claim"],
    });
    const minted = await mint(creator.key, { permissions: ["audit.read"] });
    expect(minted.permissions).toEqual(["audit.read"]);
    expect(minted.sources).toEqual([]);
    for (const map of MAPS) expect(minted[map]).toEqual({});

    // The control: the creator's own reach is there to be copied.
    const copied = await mint(creator.key, {});
    expect(copied.sources).toEqual(["named-claim"]);
    expect(copied.type_permissions).toEqual({ "core.note": "write" });
  });

  it("is still refused a permission the creator does not hold", async () => {
    const creator = await mint(ctx.workingKey, {
      permissions: ["keys.mint"],
    });
    const res = await request(ctx.app, "POST", "/keys", {
      key: creator.key,
      body: {
        label: "beyond",
        source: "named-beyond",
        permissions: ["audit.read"],
      },
    });
    expect(res.status).toBe(403);
  });

  it("gives a signed-in app's key the permissions it names and none of the grant's reach", async () => {
    const { token } = await seedOauthBearer(
      ctx,
      ["openid", "keys.mint", "audit.read", "core.note:write"],
      {},
    );
    const minted = await mint(token, { permissions: ["audit.read"] });
    expect(minted.permissions).toEqual(["audit.read"]);
    for (const map of MAPS) expect(minted[map]).toEqual({});

    const whole = await mint(token, {});
    expect(whole.type_permissions).toEqual({ "core.note": "write" });
  });
});

describe("a mint naming no family", () => {
  it("takes the creator's whole set", async () => {
    const creator = await mint(undefined, {
      permissions: ["audit.read", "keys.mint"],
      type_permissions: { "core.note": "read" },
      metadata_permissions: { types: "write" },
      sources: ["named-whole"],
    });
    const minted = await mint(creator.key, {});
    expect(minted.permissions).toEqual(["audit.read", "keys.mint"]);
    expect(minted.type_permissions).toEqual({ "core.note": "read" });
    expect(minted.metadata_permissions).toEqual({ types: "write" });
    expect(minted.sources).toEqual(["named-whole"]);
  });

  it("takes every permission and every family from the direct owner", async () => {
    const minted = await mint(undefined, {});
    expect([...minted.permissions].sort()).toEqual([...PERMISSIONS].sort());
    for (const map of MAPS) expect(minted[map]).toEqual({ "*": "write" });
  });
});

describe("a mint naming permissions and one other family", () => {
  for (const [who, minter] of minters) {
    it(`gives ${who} a key holding exactly those`, async () => {
      const withMap = await mint(minter(), {
        permissions: ["audit.read"],
        type_permissions: { "core.note": "read" },
      });
      expect(withMap.permissions).toEqual(["audit.read"]);
      expect(withMap.type_permissions).toEqual({ "core.note": "read" });
      for (const map of MAPS.filter((m) => m !== "type_permissions")) {
        expect(withMap[map]).toEqual({});
      }
      expect(withMap.sources).toEqual([]);
    });
  }

  it("gives a key naming permissions and sources the claims and no map", async () => {
    const minted = await mint(undefined, {
      permissions: ["audit.read"],
      sources: ["named-both"],
    });
    expect(minted.permissions).toEqual(["audit.read"]);
    expect(minted.sources).toEqual(["named-both"]);
    for (const map of MAPS) expect(minted[map]).toEqual({});
  });
});
