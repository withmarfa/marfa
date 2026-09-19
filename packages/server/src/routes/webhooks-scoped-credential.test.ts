/**
 * A webhook subscription may only be registered by a credential that can
 * read everything stored.
 *
 * A subscription is instance-wide and carries no credential of its own: the
 * row is a url, a secret and an event list, and a delivery is built once and
 * sent to every matching endpoint. There is no principal
 * to narrow a payload against, so the only thing that can bound what a
 * webhook delivers is the reach of whoever registered it.
 *
 * Holding `webhooks.manage` alone does not give that, and the two are separate
 * axes: a credential can hold the permission to set up webhooks and hold read
 * on one type. Such a credential could otherwise leave behind a standing
 * subscription delivering more than it could ever fetch itself, with nothing
 * on the row to record it.
 *
 * The door asks the credential's own content reach rather than how it was
 * minted, so a key and a sign-in are answered the same way.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  request,
  createTestContext,
  seedOauthBearer,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import type { TestContext } from "../test-utils.js";
import { PERMISSIONS } from "@withmarfa/shared";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext({});
});

afterEach(async () => {
  await ctx.cleanup();
});

interface ErrorBody {
  error: { code: string };
}

describe("POST /webhooks and a credential that cannot read everything", () => {
  it("refuses a session holding a subset of what is stored", async () => {
    const { token } = await seedOauthBearer(
      ctx.storage,
      ["keys.mint", "webhooks.manage"],
      {},
    );

    // The permission gate admits it — that is the point. The refusal
    // has to come from the credential's narrow content reach, not from a
    // missing scope. Both permissions are granted so that the request
    // reaches the check this file is about: `keys` for the probe below,
    // `webhooks` for the door itself. Neither buys any data-plane reach, so
    // what the webhook door sees is unchanged.
    const keysRes = await request(ctx.app, "GET", "/keys", { key: token });
    expect(keysRes.status).toBe(200);

    const res = await request(ctx.app, "POST", "/webhooks", {
      key: token,
      body: {
        url: "https://example.test/hook",
        events: ["item.created"],
      },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorBody).error.code).toBe(
      "scoped_credential_not_permitted",
    );
  });

  it("refuses one on the update door too", async () => {
    // The update door re-points `url` and rewrites `events`, so admitting
    // a scoped credential there would let it take over a subscription it
    // could not have created.

    // Registered by a credential that can read everything, as intended.
    const suffix = Math.random().toString(36).slice(2, 8);
    const adminKey = await ctx.storage.keys.create(
      {
        label: `wh-admin-${suffix}`,
        source: `wh-admin-${suffix}`,
        permissions: [...PERMISSIONS],
        type_permissions: { "*": "write" },
        default_tier: "library",
        is_operator: false,
      },
      hashApiKey(`marfa_k1_whadmin_${suffix}`, TEST_API_KEY_SALT),
    );
    expect(adminKey.id).toBeTruthy();

    const created = await request(ctx.app, "POST", "/webhooks", {
      key: `marfa_k1_whadmin_${suffix}`,
      body: { url: "https://example.test/first", events: ["item.created"] },
    });
    expect(created.status).toBe(201);
    const webhookId = ((await created.json()) as { id: string }).id;

    const { token } = await seedOauthBearer(
      ctx.storage,
      ["keys.mint", "webhooks.manage"],
      {},
    );
    // The permission gate admits it, so the refusal below comes from the
    // credential's content reach. The create test asserts the same.
    expect(
      (await request(ctx.app, "GET", "/keys", { key: token })).status,
    ).toBe(200);
    const res = await request(ctx.app, "PATCH", `/webhooks/${webhookId}`, {
      key: token,
      body: { url: "https://attacker.test/hook" },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorBody).error.code).toBe(
      "scoped_credential_not_permitted",
    );
  });

  it("refuses one on the delete door too", async () => {
    // Destroying a subscription it could not have created is the same
    // rationale: the row belongs to the instance, and an app that can read
    // only part of what is stored must not be able to silence deliveries
    // something else depends on.
    const suffix = Math.random().toString(36).slice(2, 8);
    const raw = `marfa_k1_whdel_${suffix}`;
    await ctx.storage.keys.create(
      {
        label: `wh-del-${suffix}`,
        source: `wh-del-${suffix}`,
        permissions: [...PERMISSIONS],
        type_permissions: { "*": "write" },
        default_tier: "library",
        is_operator: false,
      },
      hashApiKey(raw, TEST_API_KEY_SALT),
    );
    const created = await request(ctx.app, "POST", "/webhooks", {
      key: raw,
      body: { url: "https://example.test/doomed", events: ["item.created"] },
    });
    expect(created.status).toBe(201);
    const webhookId = ((await created.json()) as { id: string }).id;

    const { token } = await seedOauthBearer(
      ctx.storage,
      ["keys.mint", "webhooks.manage"],
      {},
    );
    expect(
      (await request(ctx.app, "GET", "/keys", { key: token })).status,
    ).toBe(200);
    const res = await request(ctx.app, "DELETE", `/webhooks/${webhookId}`, {
      key: token,
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorBody).error.code).toBe(
      "scoped_credential_not_permitted",
    );
    // And it is still there: a refusal that deleted first would answer
    // 403 just the same.
    const listed = await request(ctx.app, "GET", "/webhooks", { key: raw });
    expect(
      ((await listed.json()) as { webhooks: { id: string }[] }).webhooks.map(
        (w) => w.id,
      ),
    ).toContain(webhookId);
  });

  it("admits a credential that can read everything", async () => {
    // The control. Without it the refusal above is satisfied by a door
    // that refuses everyone.
    const suffix = Math.random().toString(36).slice(2, 8);
    const raw = `marfa_k1_whok_${suffix}`;
    await ctx.storage.keys.create(
      {
        label: `wh-ok-${suffix}`,
        source: `wh-ok-${suffix}`,
        permissions: [...PERMISSIONS],
        type_permissions: { "*": "write" },
        default_tier: "library",
        is_operator: false,
      },
      hashApiKey(raw, TEST_API_KEY_SALT),
    );

    const res = await request(ctx.app, "POST", "/webhooks", {
      key: raw,
      body: { url: "https://example.test/ok", events: ["item.created"] },
    });
    expect(res.status).toBe(201);
  });
});
