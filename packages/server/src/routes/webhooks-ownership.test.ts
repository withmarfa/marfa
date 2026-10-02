/**
 * A webhook subscription belongs to the credential that registered it.
 *
 * Any credential holding `webhooks.manage` may register one, however narrow
 * its read, because each delivery is narrowed to that credential when it is
 * sent (`webhooks/delivery.test.ts`). What follows from that is here: the
 * doors answer a subscription only to its own credential, and they take only
 * a URL a delivery could be sent to and a secret that signs something.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestContext,
  mintWorkingKey,
  request,
  seedOauthBearer,
  TEST_API_KEY_SALT,
  type TestContext,
} from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

interface ErrorBody {
  error: { code: string; message: string };
}

async function register(
  key: string,
  body: Record<string, unknown> = {},
): Promise<Response> {
  return request(ctx.app, "POST", "/webhooks", {
    key,
    body: {
      url: "https://receiver.example/hook",
      events: ["item.created"],
      ...body,
    },
  });
}

describe("who may register a subscription", () => {
  it("takes a credential that may read only part of what is stored", async () => {
    const narrow = await mintWorkingKey(ctx, {
      permissions: ["webhooks.manage"],
      type_permissions: { "core.note": "read" },
      edge_permissions: {},
      extension_permissions: {},
    });
    const res = await register(narrow);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("credential_id");
    expect(typeof body.secret).toBe("string");
  });

  it("refuses a credential without webhooks.manage", async () => {
    const without = await mintWorkingKey(ctx, { permissions: [] });
    const res = await register(without);
    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorBody).error.code).toBe("forbidden");
  });
});

describe("a subscription another credential registered", () => {
  it("answers as an unknown id on every door, and is left out of the listing", async () => {
    const mine = await mintWorkingKey(ctx, {
      permissions: ["webhooks.manage"],
    });
    const theirs = await mintWorkingKey(ctx, {
      permissions: ["webhooks.manage"],
    });
    const created = (await (await register(mine)).json()) as { id: string };

    // The witness: the owner reaches it on every door.
    for (const [method, path, body] of [
      ["GET", `/webhooks/${created.id}`, undefined],
      ["GET", `/webhooks/${created.id}/deliveries`, undefined],
      ["PATCH", `/webhooks/${created.id}`, { events: ["item.updated"] }],
    ] as const) {
      const res = await request(ctx.app, method, path, { key: mine, body });
      expect(res.status, `${method} ${path}`).toBe(200);
    }
    const ownList = (await (
      await request(ctx.app, "GET", "/webhooks", { key: mine })
    ).json()) as { data: { id: string }[] };
    expect(ownList.data.map((w) => w.id)).toContain(created.id);

    for (const [method, path, body] of [
      ["GET", `/webhooks/${created.id}`, undefined],
      ["GET", `/webhooks/${created.id}/deliveries`, undefined],
      [
        "PATCH",
        `/webhooks/${created.id}`,
        { url: "https://attacker.example/hook" },
      ],
      ["DELETE", `/webhooks/${created.id}`, undefined],
    ] as const) {
      const res = await request(ctx.app, method, path, { key: theirs, body });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(((await res.json()) as ErrorBody).error.code).toBe(
        "webhook_not_found",
      );
    }
    const theirList = (await (
      await request(ctx.app, "GET", "/webhooks", { key: theirs })
    ).json()) as { data: { id: string }[] };
    expect(theirList.data.map((w) => w.id)).not.toContain(created.id);

    const after = (await (
      await request(ctx.app, "GET", `/webhooks/${created.id}`, { key: mine })
    ).json()) as { url: string };
    expect(after.url).toBe("https://receiver.example/hook");
  });

  it("is the same credential to every token of the sign-in that registered it, and to no other sign-in", async () => {
    const seeded = await seedOauthBearer(ctx.storage, [
      "content:read",
      "webhooks.manage",
    ]);
    const created = (await (await register(seeded.token)).json()) as {
      id: string;
    };
    const first = await ctx.storage.oauthProvider?.validateAccessToken(
      hashApiKey(seeded.token.slice("marfa_at_".length), TEST_API_KEY_SALT),
    );
    if (!first?.userId || !ctx.storage.oauthProvider) {
      throw new Error("the seeded token did not resolve");
    }

    // A refresh: a new token under the same grant.
    const refreshed = `marfa_at_refreshed_${String(Date.now())}`;
    await ctx.storage.oauthProvider.mintTokenPair({
      accessTokenHash: hashApiKey(
        refreshed.slice("marfa_at_".length),
        TEST_API_KEY_SALT,
      ),
      refreshTokenHash: hashApiKey(
        `refresh_${String(Date.now())}`,
        TEST_API_KEY_SALT,
      ),
      clientId: seeded.clientId,
      authUserId: first.userId,
      scopes: ["content:read", "webhooks.manage"],
      accessTtlMs: 3600_000,
    });
    const viaRefresh = await request(
      ctx.app,
      "GET",
      `/webhooks/${created.id}`,
      { key: refreshed },
    );
    expect(viaRefresh.status).toBe(200);

    const other = await seedOauthBearer(ctx.storage, [
      "content:read",
      "webhooks.manage",
    ]);
    const viaOther = await request(ctx.app, "GET", `/webhooks/${created.id}`, {
      key: other.token,
    });
    expect(viaOther.status).toBe(404);
  });
});

describe("what a registration takes", () => {
  it("refuses a secret shorter than 32 characters, the empty one included, and takes one of 32", async () => {
    for (const secret of ["", "short", "x".repeat(31)]) {
      const res = await register(ctx.workingKey, { secret });
      expect(res.status, JSON.stringify(secret)).toBe(400);
      expect(((await res.json()) as ErrorBody).error.code).toBe(
        "validation_error",
      );
    }
    const res = await register(ctx.workingKey, { secret: "x".repeat(32) });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { secret: string }).secret).toBe(
      "x".repeat(32),
    );
  });

  it("refuses a URL that is not http or https, carries credentials, or names a non-public address, on create and update", async () => {
    const created = (await (await register(ctx.workingKey)).json()) as {
      id: string;
    };
    for (const url of [
      "ftp://receiver.example/hook",
      "file:///etc/passwd",
      "https://user:pass@receiver.example/hook",
      "http://127.0.0.1:8600/hook",
      "http://10.0.0.5/hook",
      "http://169.254.169.254/latest/meta-data",
      "http://100.64.0.1/hook",
      "http://[::1]/hook",
      "http://[fd00::1]/hook",
      "http://[fe80::1]/hook",
      "http://[::ffff:127.0.0.1]/hook",
      "http://0.0.0.0/hook",
    ]) {
      const create = await register(ctx.workingKey, { url });
      expect(create.status, url).toBe(400);
      const update = await request(
        ctx.app,
        "PATCH",
        `/webhooks/${created.id}`,
        { key: ctx.workingKey, body: { url } },
      );
      expect(update.status, url).toBe(400);
    }
    for (const url of [
      "https://receiver.example/hook",
      "http://93.184.215.14/hook",
      "https://[2606:4700::1]/hook",
    ]) {
      expect((await register(ctx.workingKey, { url })).status, url).toBe(201);
    }
  });

  it("takes a private address where the operator allows one", async () => {
    const local = await createTestContext({
      webhookAllowPrivateAddresses: true,
    });
    try {
      const res = await request(local.app, "POST", "/webhooks", {
        key: local.workingKey,
        body: { url: "http://127.0.0.1:9/hook", events: ["item.created"] },
      });
      expect(res.status).toBe(201);
    } finally {
      await local.cleanup();
    }
  });
});
