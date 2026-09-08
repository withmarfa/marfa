/**
 * A webhook subscription may only be registered by a credential whose
 * reach is the whole space.
 *
 * A subscription is space-level and carries no credential of its own: the
 * row is a url, a secret, an event list and a space, and a delivery is
 * built once and sent to every matching endpoint. There is no principal
 * to narrow a payload against, so the only thing that can bound what a
 * webhook delivers is the reach of whoever registered it.
 *
 * `requireSpaceAdmin` alone does not give that. An OAuth-derived token
 * projects the user's role — `space_admin` included — while holding a
 * grant that is a subset of the space, which is exactly why
 * `roleBypassesPermissionMaps` excludes it. Such a credential could
 * otherwise leave behind a standing subscription delivering more than the
 * app was ever granted, with nothing on the row to record it.
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

interface ErrorBody {
  error: { code: string };
}

describe("POST /webhooks and a scope-enforced credential", () => {
  it("refuses one that projects space_admin", async () => {
    const space = await spaces().create("scoped-webhook-space");
    const { token } = await seedOauthBearer(ctx.storage, ["capability.keys"], {
      spaceId: space.id,
      userRole: "space_admin",
    });

    // The role gate admits it — that is the point. The refusal has to
    // come from the scope flag, not from the role. `capability.keys` is
    // granted only so the probe reaches that role check; it buys no
    // data-plane reach, so what the webhook door sees is unchanged.
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
    const space = await spaces().create("scoped-webhook-update-space");

    // Registered by an unscoped space admin, the way it is meant to be.
    const suffix = Math.random().toString(36).slice(2, 8);
    const adminKey = await ctx.storage.keys.create(
      {
        label: `wh-admin-${suffix}`,
        source: `wh-admin-${suffix}`,
        role: "space_admin",
        type_permissions: { "*": "write" },
        default_tier: "library",
        is_platform: false,
      },
      hashApiKey(`marfa_k1_whadmin_${suffix}`, TEST_API_KEY_SALT),
      space.id,
    );
    expect(adminKey.id).toBeTruthy();

    const created = await request(ctx.app, "POST", "/webhooks", {
      key: `marfa_k1_whadmin_${suffix}`,
      body: { url: "https://example.test/first", events: ["item.created"] },
    });
    expect(created.status).toBe(201);
    const webhookId = ((await created.json()) as { id: string }).id;

    const { token } = await seedOauthBearer(ctx.storage, ["capability.keys"], {
      spaceId: space.id,
      userRole: "space_admin",
    });
    // The role gate admits it, so the refusal below comes from the scope
    // flag rather than from the role. The create test asserts the same.
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
    // rationale: the row belongs to the space, and an app holding a
    // subset of it must not be able to silence deliveries the space
    // depends on.
    const space = await spaces().create("scoped-webhook-delete-space");
    const suffix = Math.random().toString(36).slice(2, 8);
    const raw = `marfa_k1_whdel_${suffix}`;
    await ctx.storage.keys.create(
      {
        label: `wh-del-${suffix}`,
        source: `wh-del-${suffix}`,
        role: "space_admin",
        type_permissions: { "*": "write" },
        default_tier: "library",
        is_platform: false,
      },
      hashApiKey(raw, TEST_API_KEY_SALT),
      space.id,
    );
    const created = await request(ctx.app, "POST", "/webhooks", {
      key: raw,
      body: { url: "https://example.test/doomed", events: ["item.created"] },
    });
    expect(created.status).toBe(201);
    const webhookId = ((await created.json()) as { id: string }).id;

    const { token } = await seedOauthBearer(ctx.storage, ["capability.keys"], {
      spaceId: space.id,
      userRole: "space_admin",
    });
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

  it("admits an unscoped space admin, as before", async () => {
    // The control. Without it the refusal above is satisfied by a door
    // that refuses everyone.
    const space = await spaces().create("unscoped-webhook-space");
    const suffix = Math.random().toString(36).slice(2, 8);
    const raw = `marfa_k1_whok_${suffix}`;
    await ctx.storage.keys.create(
      {
        label: `wh-ok-${suffix}`,
        source: `wh-ok-${suffix}`,
        role: "space_admin",
        type_permissions: { "*": "write" },
        default_tier: "library",
        is_platform: false,
      },
      hashApiKey(raw, TEST_API_KEY_SALT),
      space.id,
    );

    const res = await request(ctx.app, "POST", "/webhooks", {
      key: raw,
      body: { url: "https://example.test/ok", events: ["item.created"] },
    });
    expect(res.status).toBe(201);
  });
});
