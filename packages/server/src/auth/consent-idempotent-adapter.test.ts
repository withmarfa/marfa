/**
 * Coverage for the idempotent-consent adapter wrap + the
 * `auth_oauth_consent (client_id, user_id)` unique constraint.
 *
 * The OAuth Provider plugin writes consent via the Better Auth drizzle
 * adapter's `create` on the `oauthConsent` model. Without the wrap a
 * second consent for the same (client_id, user_id) pair would insert a
 * duplicate row; with the constraint alone that insert would throw. Both
 * land together: the wrap turns `create` into an upsert on the pair, and
 * the constraint backstops a concurrent double-insert.
 *
 * These tests drive the adapter directly (the same surface the plugin
 * calls) because the route-level consent tests use a bogus signature and
 * never reach the plugin's real consent write. Building the auth instance
 * the same way `app.ts` does exercises the wrapped adapter end to end.
 */
import { describe, it, expect, afterEach } from "vitest";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt } from "better-auth/plugins";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { buildOauthProviderPlugin } from "./oauth-provider.js";
import { withIdempotentConsent } from "./consent-idempotent-adapter.js";
import * as sqliteSchema from "../storage/sqlite/schema.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

/** Minimal adapter surface the tests reach through the auth instance. */
interface TestAdapter {
  create: (a: {
    model: string;
    data: Record<string, unknown>;
    forceAllowId?: boolean;
  }) => Promise<unknown>;
  findMany: (a: {
    model: string;
    where?: { field: string; value: unknown }[];
  }) => Promise<unknown[]>;
}

/**
 * Build a real Better Auth instance against the test storage with the
 * same wrapped drizzle adapter `instance.ts` uses, and return its
 * resolved adapter (the surface the oauth-provider plugin calls).
 */
async function buildAdapter(c: TestContext): Promise<TestAdapter> {
  if (!c.storage.betterAuthDb) {
    throw new Error("test storage missing better-auth handle");
  }
  const schema = {
    user: sqliteSchema.auth_user,
    session: sqliteSchema.auth_session,
    account: sqliteSchema.auth_account,
    verification: sqliteSchema.auth_verification,
    oauthClient: sqliteSchema.auth_oauth_client,
    oauthAccessToken: sqliteSchema.auth_oauth_access_token,
    oauthRefreshToken: sqliteSchema.auth_oauth_refresh_token,
    oauthConsent: sqliteSchema.auth_oauth_consent,
    jwks: sqliteSchema.auth_jwks,
  };

  const instance = betterAuth({
    baseURL: "http://localhost:0",
    basePath: "/auth",
    secret: "test-secret-consent-idempotent",
    database: withIdempotentConsent(
      drizzleAdapter(c.storage.betterAuthDb as never, {
        provider: "sqlite",
        schema,
      }),
    ),
    plugins: [
      jwt(),
      buildOauthProviderPlugin({
        storage: c.storage,
        apiKeySalt: "test-salt",
        baseURL: "http://localhost:0",
      }),
    ],
  });

  const resolved = await (
    instance as unknown as { $context: Promise<{ adapter: TestAdapter }> }
  ).$context;
  return resolved.adapter;
}

/** Seed an auth_user row (FK target for consent.user_id). */
async function seedUser(adapter: TestAdapter, id: string): Promise<void> {
  const now = new Date();
  await adapter.create({
    model: "user",
    forceAllowId: true,
    data: {
      id,
      name: "Consent Test User",
      email: `${id}@test.local`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    },
  });
}

function consentData(
  clientId: string,
  userId: string,
  scopes: string[],
): Record<string, unknown> {
  const now = new Date();
  return {
    clientId,
    userId,
    scopes,
    createdAt: now,
    updatedAt: now,
  };
}

async function countConsents(
  adapter: TestAdapter,
  clientId: string,
  userId: string,
): Promise<unknown[]> {
  return adapter.findMany({
    model: "oauthConsent",
    where: [
      { field: "clientId", value: clientId },
      { field: "userId", value: userId },
    ],
  });
}

describe("idempotent oauth consent adapter", () => {
  it("re-consent does NOT create a duplicate row — exactly one row, scopes updated", async () => {
    ctx = await createTestContext({});
    const adapter = await buildAdapter(ctx);
    await seedUser(adapter, "u_dedup");

    // First consent: narrow scopes.
    await adapter.create({
      model: "oauthConsent",
      data: consentData("client_dedup", "u_dedup", ["openid"]),
    });
    // Re-consent: wider scopes, same (clientId, userId).
    await adapter.create({
      model: "oauthConsent",
      data: consentData("client_dedup", "u_dedup", [
        "openid",
        "core.note:read",
      ]),
    });

    const rows = (await countConsents(adapter, "client_dedup", "u_dedup")) as {
      scopes: unknown;
    }[];
    expect(rows.length).toBe(1);

    // Scopes were refreshed to the re-consent set. The adapter returns
    // scopes as an array (JSON-deserialized by the Better Auth adapter).
    const scopes = rows[0]?.scopes as string[];
    expect(scopes).toContain("core.note:read");
    expect(scopes).toContain("openid");
  });

  it("constraint + idempotent write hold together — many re-consents stay at one row", async () => {
    ctx = await createTestContext({});
    const adapter = await buildAdapter(ctx);
    await seedUser(adapter, "u_multi");

    for (let i = 0; i < 5; i++) {
      await adapter.create({
        model: "oauthConsent",
        data: consentData("client_multi", "u_multi", [
          "openid",
          `core.note:read`,
        ]),
      });
    }

    const rows = await countConsents(adapter, "client_multi", "u_multi");
    expect(rows.length).toBe(1);
  });

  it("distinct (clientId, userId) pairs each get their own row", async () => {
    ctx = await createTestContext({});
    const adapter = await buildAdapter(ctx);
    await seedUser(adapter, "u_a");
    await seedUser(adapter, "u_b");

    await adapter.create({
      model: "oauthConsent",
      data: consentData("client_x", "u_a", ["openid"]),
    });
    await adapter.create({
      model: "oauthConsent",
      data: consentData("client_x", "u_b", ["openid"]),
    });
    await adapter.create({
      model: "oauthConsent",
      data: consentData("client_y", "u_a", ["openid"]),
    });

    const all = await adapter.findMany({ model: "oauthConsent" });
    expect(all.length).toBe(3);
    expect((await countConsents(adapter, "client_x", "u_a")).length).toBe(1);
    expect((await countConsents(adapter, "client_x", "u_b")).length).toBe(1);
    expect((await countConsents(adapter, "client_y", "u_a")).length).toBe(1);
  });
});
