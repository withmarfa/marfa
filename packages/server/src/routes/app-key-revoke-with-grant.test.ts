/**
 * Disconnecting an app offers to take the keys it made, and takes exactly
 * those.
 *
 * A key an app minted is standing access that outlives every token the grant
 * issued, so a person disconnecting an app and leaving one behind has not
 * finished disconnecting it. The offer is a choice rather than a consequence,
 * because the key is theirs — it appears in their own key list and a script
 * of theirs may be holding it — so the sweep runs only when the door was asked
 * for it.
 *
 * The two properties that matter are *only when asked* and *only those keys*.
 * A sweep that fires unasked destroys credentials nobody chose to destroy; a
 * sweep that keys on the client id alone reaches keys the app did not mint,
 * because one client id can stand behind more than one grant.
 */
import { itemWrites } from "../storage/item-writes.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";

const CLIENT = "client_under_test";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext({});
});

afterEach(async () => {
  await ctx.cleanup();
});

async function seedKey(
  label: string,
  clientId: string | undefined,
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const stored = await ctx.storage.keys.create(
    {
      label,
      source: `app-key-revoke-${label}-${suffix}`,
      permissions: [],
      type_permissions: { "core.note": "read" },
      extension_permissions: {},
      edge_permissions: {},
      metadata_permissions: {},
      default_tier: "library",

      oauth_client_id: clientId,
    },
    hashApiKey(`marfa_k1_${label}_${suffix}`, TEST_API_KEY_SALT),
  );
  return stored.id;
}

/** One active grant for `CLIENT`, plus a key that app made and a key the
 *  person made. */
async function seedGrant() {
  const grant = await itemWrites(ctx.storage).create({
    type: "system.connection",
    tier: "library",
    state: "active",
    properties: {
      kind: "app",
      client_id: CLIENT,
      user_id: "auth_user_under_test",
      scopes: ["core.note:read"],
      status: "active",
      granted_at: new Date().toISOString(),
    },
    source: "test/app-key-revoke",
  });
  const appKeyId = await seedKey("app-made", CLIENT);
  const ownKeyId = await seedKey("own", undefined);
  return { grant, appKeyId, ownKeyId };
}

/** Whether a key is still live. `list` excludes revoked and expired rows. */
async function isLive(id: string): Promise<boolean> {
  const keys = await ctx.storage.keys.list();
  return keys.some((k) => k.id === id);
}

describe("revoking an app's grant", () => {
  it("leaves the app's keys alone when nothing asked for them", async () => {
    const { grant, appKeyId, ownKeyId } = await seedGrant();

    const res = await request(ctx.app, "DELETE", `/auth/grants/${grant.id}`, {
      key: ctx.workingKey,
    });
    expect(res.status).toBe(204);

    expect(await isLive(appKeyId)).toBe(true);
    expect(await isLive(ownKeyId)).toBe(true);
  });

  it("takes them when the door is asked to", async () => {
    const { grant, appKeyId, ownKeyId } = await seedGrant();

    const res = await request(
      ctx.app,
      "DELETE",
      `/auth/grants/${grant.id}?revoke_keys=true`,
      { key: ctx.workingKey },
    );
    expect(res.status).toBe(204);

    expect(await isLive(appKeyId)).toBe(false);
    // The person's own key is not the app's to take, and this is the assertion
    // that separates "swept the app's keys" from "swept every key".
    expect(await isLive(ownKeyId)).toBe(true);
  });

  it("revokes the grant itself either way", async () => {
    const { grant } = await seedGrant();
    const res = await request(
      ctx.app,
      "DELETE",
      `/auth/grants/${grant.id}?revoke_keys=true`,
      { key: ctx.workingKey },
    );
    expect(res.status).toBe(204);
    const after = await ctx.storage.items.get(grant.id);
    expect(after?.properties.status).toBe("revoked");
  });
});
