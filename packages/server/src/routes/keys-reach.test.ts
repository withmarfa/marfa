import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  seedOauthBearer,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { CreateKeyInput } from "@withmarfa/shared";
import { hashApiKey } from "../middleware/auth.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

/** Store a key directly, so a fixture can hold what no door would mint. */
async function storeKey(
  input: Partial<CreateKeyInput> = {},
): Promise<{ id: string; raw: string }> {
  const suffix = Math.random().toString(36).slice(2, 12);
  const raw = `marfa_k1_reach_${suffix}`;
  const stored = await ctx.storage.keys.create(
    {
      label: `reach-${suffix}`,
      source: `reach-${suffix}`,
      type_permissions: {},
      default_tier: "library",

      ...input,
    },
    hashApiKey(raw, TEST_API_KEY_SALT),
  );
  return { id: stored.id, raw };
}

async function answer(res: Response, id: string) {
  const body = (await res.json()) as {
    error?: { code: string; message: string };
  };
  return {
    status: res.status,
    code: body.error?.code,
    message: body.error?.message.replace(id, "<id>"),
  };
}

const UNKNOWN_ID = "019537a0-7b80-7000-8000-000000000000";

describe("the keys a signed-in app reaches", () => {
  const scopes = ["openid", "keys.mint", "core.note:read"];

  it("revokes, changes and lists a key its grant covers", async () => {
    const { token } = await seedOauthBearer(ctx, scopes, {});
    const target = await storeKey({
      type_permissions: { "core.note": "read" },
    });

    const list = await request(ctx.app, "GET", "/keys", { key: token });
    expect(list.status).toBe(200);
    const ids = ((await list.json()) as { data: { id: string }[] }).data.map(
      (k) => k.id,
    );
    expect(ids).toContain(target.id);

    const renamed = await request(ctx.app, "PATCH", `/keys/${target.id}`, {
      key: token,
      body: { label: "renamed" },
    });
    expect(renamed.status).toBe(200);

    const revoked = await request(ctx.app, "DELETE", `/keys/${target.id}`, {
      key: token,
    });
    expect(revoked.status).toBe(200);
  });

  it("is answered as for no key on one its grant does not cover", async () => {
    const { token } = await seedOauthBearer(ctx, scopes, {});
    const wider = await storeKey({ type_permissions: { "*": "write" } });
    // The grant carries `keys.mint`, which the target holds as well, so the
    // only thing beyond the grant is the type map.
    const unknown = await answer(
      await request(ctx.app, "DELETE", `/keys/${UNKNOWN_ID}`, { key: token }),
      UNKNOWN_ID,
    );

    const revoke = await request(ctx.app, "DELETE", `/keys/${wider.id}`, {
      key: token,
    });
    expect(await answer(revoke, wider.id)).toEqual(unknown);
    expect(unknown.status).toBe(404);
    expect(unknown.code).toBe("api_key_not_found");

    const update = await request(ctx.app, "PATCH", `/keys/${wider.id}`, {
      key: token,
      body: { type_permissions: {} },
    });
    expect(update.status).toBe(404);

    const list = await request(ctx.app, "GET", "/keys", { key: token });
    const ids = ((await list.json()) as { data: { id: string }[] }).data.map(
      (k) => k.id,
    );
    expect(ids).not.toContain(wider.id);

    const stored = await ctx.storage.keys.get(wider.id);
    expect(stored?.type_permissions).toEqual({ "*": "write" });
  });

  it("does not reach a key holding any extension reach, which no grant names", async () => {
    const { token } = await seedOauthBearer(
      ctx,
      ["openid", "keys.mint", "*:write"],
      {},
    );
    const withExtension = await storeKey({
      type_permissions: { "core.note": "read" },
      extension_permissions: { acme: "read" },
    });
    const without = await storeKey({
      type_permissions: { "core.note": "read" },
    });

    const refused = await request(
      ctx.app,
      "DELETE",
      `/keys/${withExtension.id}`,
      { key: token },
    );
    expect(refused.status).toBe(404);

    // The control: the same grant reaches the same key without the namespace.
    const allowed = await request(ctx.app, "DELETE", `/keys/${without.id}`, {
      key: token,
    });
    expect(allowed.status).toBe(200);
  });

  it("does not reach a key holding a permission the grant lacks", async () => {
    const { token } = await seedOauthBearer(ctx, scopes, {});
    const auditor = await storeKey({
      type_permissions: { "core.note": "read" },
      permissions: ["audit.read"],
    });
    const res = await request(ctx.app, "DELETE", `/keys/${auditor.id}`, {
      key: token,
    });
    expect(res.status).toBe(404);
  });

  it("never reaches an operator key, though it holds nothing", async () => {
    const { token } = await seedOauthBearer(ctx, scopes, {});
    const operator = await request(ctx.app, "GET", "/keys/current", {
      headers: { cookie: ctx.owner.cookie, origin: new URL(ctx.config.authBaseUrl).origin },
    });
    const { id } = (await operator.json()) as { id: string };

    const res = await request(ctx.app, "DELETE", `/keys/${id}`, {
      key: token,
    });
    expect(res.status).toBe(404);
    const list = await request(ctx.app, "GET", "/keys", { key: token });
    const rows = ((await list.json()) as { data: { is_operator: boolean }[] })
      .data;
    expect(rows.some((k) => k.is_operator)).toBe(false);
  });
});

describe("the keys a working key reaches", () => {
  it("narrow minter: revokes, narrows and lists nothing wider than itself", async () => {
    const minter = await storeKey({
      permissions: ["keys.mint"],
      type_permissions: { "core.note": "read" },
    });
    const full = await storeKey({
      type_permissions: { "*": "write" },
      edge_permissions: { "*": "write" },
    });

    const revoke = await request(ctx.app, "DELETE", `/keys/${full.id}`, {
      key: minter.raw,
    });
    expect(revoke.status).toBe(404);
    const narrow = await request(ctx.app, "PATCH", `/keys/${full.id}`, {
      key: minter.raw,
      body: { type_permissions: { "core.note": "read" } },
    });
    expect(narrow.status).toBe(404);
    expect((await ctx.storage.keys.get(full.id))?.type_permissions).toEqual({
      "*": "write",
    });

    const list = await request(ctx.app, "GET", "/keys", { key: minter.raw });
    const rows = (
      (await list.json()) as {
        data: { id: string; is_operator: boolean }[];
      }
    ).data;
    const ids = rows.map((k) => k.id);
    expect(ids).toContain(minter.id);
    expect(ids).not.toContain(full.id);
    expect(rows.some((k) => k.is_operator)).toBe(false);
  });

  it("is measured against a denial it holds, not only against what it lists", async () => {
    // `{"*":"write","core.note":"none"}` denies notes, so a target reading
    // notes is beyond it even though the wildcard alone would cover it.
    const minter = await storeKey({
      permissions: ["keys.mint"],
      type_permissions: { "*": "write", "core.note": "none" },
    });
    const reader = await storeKey({
      type_permissions: { "core.note": "read" },
    });
    const res = await request(ctx.app, "DELETE", `/keys/${reader.id}`, {
      key: minter.raw,
    });
    expect(res.status).toBe(404);
  });

  it("revokes itself, and is then told the key is gone like any missing key", async () => {
    const minter = await storeKey({
      permissions: ["keys.mint"],
      type_permissions: { "core.note": "read" },
    });
    const self = await request(ctx.app, "DELETE", `/keys/${minter.id}`, {
      key: minter.raw,
    });
    expect(self.status).toBe(200);
    expect(
      (await request(ctx.app, "GET", "/keys/current", { key: minter.raw }))
        .status,
    ).toBe(401);
  });

  it("is not told whether a key it no longer reaches was revoked; the operator is", async () => {
    const minter = await storeKey({
      permissions: ["keys.mint"],
      type_permissions: { "core.note": "read" },
    });
    const target = await storeKey({
      type_permissions: { "core.note": "read" },
    });
    expect(
      (
        await request(ctx.app, "DELETE", `/keys/${target.id}`, {
          key: minter.raw,
        })
      ).status,
    ).toBe(200);

    // A revoked row's reach cannot be read back, so to a working key it
    // answers as an id nobody holds.
    const again = await request(ctx.app, "DELETE", `/keys/${target.id}`, {
      key: minter.raw,
    });
    const unknown = await request(ctx.app, "DELETE", `/keys/${UNKNOWN_ID}`, {
      key: minter.raw,
    });
    expect(await answer(again, target.id)).toEqual(
      await answer(unknown, UNKNOWN_ID),
    );

    const operator = await request(ctx.app, "DELETE", `/keys/${target.id}`, {
      headers: { cookie: ctx.owner.cookie, origin: new URL(ctx.config.authBaseUrl).origin },
    });
    expect(operator.status).toBe(404);
    const err = (await operator.json()) as { error: { message: string } };
    expect(err.error.message).toMatch(/already revoked/i);
  });
});

describe("the key an app mints naming no reach", () => {
  it.each([
    [["openid", "keys.mint", "content:read"]],
    [["openid", "keys.mint", "content:write"]],
    [["openid", "keys.mint", "content:read", "metadata:read", "profile:read"]],
    [["openid", "keys.mint", "content:write", "edge.about:read"]],
  ])(
    "is within the reach of the app that minted it, granted %j",
    async (scopes) => {
      const { token } = await seedOauthBearer(ctx, scopes, {});
      const minted = await request(ctx.app, "POST", "/keys", {
        key: token,
        body: {
          label: "like the app",
          source: `like-${Math.random().toString(36).slice(2, 12)}`,
        },
      });
      expect(minted.status).toBe(201);
      const { id, type_permissions } = (await minted.json()) as {
        id: string;
        type_permissions: Record<string, string>;
      };
      // The witness that the key carries the projection's denials, which no
      // grant literal names.
      expect(Object.values(type_permissions)).toContain("none");

      const list = await request(ctx.app, "GET", "/keys", { key: token });
      const ids = ((await list.json()) as { data: { id: string }[] }).data.map(
        (k) => k.id,
      );
      expect(ids).toContain(id);

      const revoked = await request(ctx.app, "DELETE", `/keys/${id}`, {
        key: token,
      });
      expect(revoked.status).toBe(200);
    },
  );
});

describe("a working key's extension reach", () => {
  it("does not reach a key holding a namespace it lacks, and reaches it holding one", async () => {
    const without = await storeKey({
      permissions: ["keys.mint"],
      type_permissions: { "core.note": "read" },
    });
    const holder = await storeKey({
      type_permissions: { "core.note": "read" },
      extension_permissions: { acme: "write" },
    });
    const refused = await request(ctx.app, "DELETE", `/keys/${holder.id}`, {
      key: without.raw,
    });
    expect(refused.status).toBe(404);

    const reading = await storeKey({
      permissions: ["keys.mint"],
      type_permissions: { "core.note": "read" },
      extension_permissions: { acme: "read" },
    });
    const stillRefused = await request(
      ctx.app,
      "DELETE",
      `/keys/${holder.id}`,
      {
        key: reading.raw,
      },
    );
    expect(stillRefused.status).toBe(404);

    const writing = await storeKey({
      permissions: ["keys.mint"],
      type_permissions: { "core.note": "read" },
      extension_permissions: { acme: "write" },
    });
    const reached = await request(ctx.app, "DELETE", `/keys/${holder.id}`, {
      key: writing.raw,
    });
    expect(reached.status).toBe(200);
  });
});

describe("the key store's update", () => {
  it("refuses a revoked key as a missing key, not as a generic miss", async () => {
    const key = await storeKey({ type_permissions: { "core.note": "read" } });
    expect(await ctx.storage.keys.revoke(key.id)).toBe("revoked");
    await expect(
      ctx.storage.keys.update(key.id, { label: "late" }),
    ).rejects.toMatchObject({ code: "api_key_not_found" });
  });
});
