import { describe, it, expect, afterEach } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { sameScopeSet } from "./consent-scopes.js";

/**
 * `OauthProviderStore.setConsentScopes` — the checked write behind the
 * silent re-authorization path's restoration of a standing grant.
 *
 * The caller reads the standing scopes, hands the request to the OAuth
 * Provider plugin (which rewrites the row to whatever the client asked
 * for), then writes the read-back set again. That value is stale by
 * construction, so the write carries the value it expects to find. If the
 * grant moved on in the meantime — narrowed on the consent screen,
 * revoked from `/auth/security`, or rewritten by another server process
 * — the restoration is declined rather than applied over the top.
 *
 * `scopes` is a JSON text column, and the guard has to hold on it.
 */

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

interface InsertDb {
  insert: (table: unknown) => {
    values: (v: Record<string, unknown>) => {
      run?: () => Promise<unknown>;
      execute?: () => Promise<unknown>;
    };
  };
}

function betterAuthSchema() {
  return import("./sqlite/schema.js");
}

/** `auth_oauth_consent.user_id` is a FK, so the user has to exist first. */
async function seedUser(c: TestContext, userId: string): Promise<void> {
  if (!c.storage.betterAuthDb) throw new Error("no betterAuthDb");
  const schemaModule = await betterAuthSchema();
  const db = c.storage.betterAuthDb as unknown as InsertDb;
  const now = new Date();
  const op = db.insert(schemaModule.auth_user).values({
    id: userId,
    name: userId,
    email: `${userId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  await (op.execute?.() ?? op.run?.() ?? Promise.resolve());
}

async function seedConsent(
  c: TestContext,
  clientId: string,
  userId: string,
  scopes: string[],
): Promise<void> {
  if (!c.storage.betterAuthDb) throw new Error("no betterAuthDb");
  await seedUser(c, userId);
  const schemaModule = await betterAuthSchema();
  const db = c.storage.betterAuthDb as unknown as InsertDb;
  const now = new Date();
  const op = db.insert(schemaModule.auth_oauth_consent).values({
    id: `consent_${Math.random().toString(36).slice(2)}`,
    clientId,
    userId,
    scopes: JSON.stringify(scopes),
    createdAt: now,
    updatedAt: now,
  });
  await (op.execute?.() ?? op.run?.() ?? Promise.resolve());
}

describe("sameScopeSet", () => {
  it("compares membership, not order or repetition", () => {
    expect(sameScopeSet(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameScopeSet(["a", "a", "b"], ["a", "b"])).toBe(true);
    expect(sameScopeSet(["a", "b"], ["a"])).toBe(false);
    expect(sameScopeSet([], [])).toBe(true);
  });
});

describe("OauthProviderStore.setConsentScopes", () => {
  it("writes when the row still holds the expected scopes", async () => {
    ctx = await createTestContext();
    const store = ctx.storage.oauthProvider!;
    await seedConsent(ctx, "client_a", "user_a", ["openid"]);

    const wrote = await store.setConsentScopes(
      "client_a",
      "user_a",
      ["openid", "core.note:read"],
      ["openid"],
    );

    expect(wrote).toBe(true);
    expect([...(await store.getPriorConsent("client_a", "user_a"))!].sort()) //
      .toEqual(["core.note:read", "openid"]);
  });

  it("declines when the grant was narrowed after the caller read it", async () => {
    ctx = await createTestContext();
    const store = ctx.storage.oauthProvider!;
    // What the row holds now: the user has already dropped core.task:read.
    await seedConsent(ctx, "client_b", "user_b", ["openid", "core.note:read"]);

    // A restoration computed against the pre-narrowing set, expecting the
    // value the plugin would have left behind.
    const wrote = await store.setConsentScopes(
      "client_b",
      "user_b",
      ["openid", "core.note:read", "core.task:read"],
      ["openid"],
    );

    expect(wrote).toBe(false);
    expect(await store.getPriorConsent("client_b", "user_b")).not.toContain(
      "core.task:read",
    );
  });

  it("declines when the grant was revoked (no row) after the caller read it", async () => {
    ctx = await createTestContext();
    const store = ctx.storage.oauthProvider!;

    const wrote = await store.setConsentScopes(
      "client_c",
      "user_c",
      ["openid", "core.note:read"],
      ["openid"],
    );

    expect(wrote).toBe(false);
    expect(await store.getPriorConsent("client_c", "user_c")).toBeUndefined();
  });

  it("scopes the guard to the (client, user) pair", async () => {
    ctx = await createTestContext();
    const store = ctx.storage.oauthProvider!;
    await seedConsent(ctx, "client_d", "user_d", ["openid"]);
    await seedConsent(ctx, "client_d", "user_e", ["core.note:read"]);

    expect(
      await store.setConsentScopes(
        "client_d",
        "user_e",
        ["core.note:read", "core.task:read"],
        ["openid"],
      ),
    ).toBe(false);
    expect(await store.getPriorConsent("client_d", "user_e")).toEqual([
      "core.note:read",
    ]);
  });
});
