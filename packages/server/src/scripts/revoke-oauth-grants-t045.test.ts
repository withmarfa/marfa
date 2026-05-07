/**
 * T-045 — re-consent migration script tests.
 *
 * Verifies the revocation pipeline: status flip on the grant item,
 * cascade through `oauth.revokeGrantTokens`, audit row stamped with
 * the documented shape. Plus idempotency — re-running the script over
 * already-revoked grants is a no-op.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createTestContext, TEST_API_KEY_SALT } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { hashApiKey } from "../middleware/auth.js";
import { revokeOauthGrantsT045 } from "./revoke-oauth-grants-t045.js";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(() => {
  ctx.cleanup();
});

async function seedActiveGrant(scopes: string[]): Promise<{
  grantId: string;
  tokenHash: string;
}> {
  const client = await ctx.storage.oauth.createClient({
    name: "Pre-T045 Test App",
    redirect_uris: ["http://localhost/cb"],
  });
  const grant = await ctx.storage.items.create({
    type: "system.connection",
    state: "active",
    tier: "library",
    properties: {
      kind: "app",
      client_id: client.id,
      scopes,
      status: "active",
      granted_at: new Date().toISOString(),
    },
    source: "test/oauth",
    origin: "user",
  });
  const rawToken = `myme_at_${Math.random().toString(36).slice(2)}_pre`;
  const tokenHash = hashApiKey(rawToken, TEST_API_KEY_SALT);
  await ctx.storage.oauth.createToken(
    grant.id,
    tokenHash,
    "access",
    new Date(Date.now() + 3600_000).toISOString(),
  );
  return { grantId: grant.id, tokenHash };
}

describe("revokeOauthGrantsT045 — re-consent migration", () => {
  it("revokes every active app and cascades through tokens", async () => {
    const { grantId, tokenHash } = await seedActiveGrant([
      "core.note:read",
      "edge.parent-of:write",
    ]);

    const report = await revokeOauthGrantsT045(ctx.storage);
    expect(report.total).toBe(1);
    expect(report.revoked).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.skipped_already_revoked).toBe(0);

    // Status flipped on the grant item.
    const item = await ctx.storage.items.get(grantId);
    expect(item).not.toBeNull();
    expect(item?.properties.status).toBe("revoked");
    expect(item?.properties.revoke_reason).toBe("scope_grammar_enforcement");
    expect(typeof item?.properties.revoked_at).toBe("string");

    // Token revoked at the storage layer — `validateToken` returns null
    // for expired / revoked / missing tokens.
    const validated = await ctx.storage.oauth.validateToken(tokenHash);
    expect(validated).toBeNull();

    // Audit row written with the documented shape.
    const audit = await ctx.storage.audit.list({
      action: "key.revoke",
      resource_id: grantId,
      limit: 5,
    });
    expect(audit.data.length).toBeGreaterThan(0);
    const row = audit.data[0];
    expect(row?.details).toMatchObject({
      reason: "scope_grammar_enforcement",
      ticket: "T-045",
    });
  });

  it("is idempotent — re-running over already-revoked grants is a no-op", async () => {
    await seedActiveGrant(["core.note:read"]);
    const first = await revokeOauthGrantsT045(ctx.storage);
    expect(first.revoked).toBe(1);

    const second = await revokeOauthGrantsT045(ctx.storage);
    // Same total count seen; nothing new revoked; the previously-
    // revoked grant counted under skipped_already_revoked.
    expect(second.total).toBe(1);
    expect(second.revoked).toBe(0);
    expect(second.skipped_already_revoked).toBe(1);
  });

  it("skips system.connection items of other kinds (integration)", async () => {
    // Real-world DBs have a mix of kinds; the script must only touch
    // apps. Not a tenant, not an integration.
    const client = await ctx.storage.oauth.createClient({
      name: "Test App",
      redirect_uris: ["http://localhost/cb"],
    });
    await ctx.storage.items.create({
      type: "system.connection",
      state: "active",
      tier: "library",
      properties: {
        kind: "integration",
        client_id: client.id,
        configuration: { upstream_base_url: "https://example.com" },
        status: "active",
        granted_at: new Date().toISOString(),
      },
      source: "test/connector",
      origin: "user",
    });
    // Plus one real grant to confirm it's revoked alongside.
    const { grantId } = await seedActiveGrant(["core.note:read"]);

    const report = await revokeOauthGrantsT045(ctx.storage);
    expect(report.total).toBe(1); // only the app counts
    expect(report.skipped_wrong_kind).toBeGreaterThanOrEqual(1);
    expect(report.revoked).toBe(1);

    const grantItem = await ctx.storage.items.get(grantId);
    expect(grantItem?.properties.status).toBe("revoked");
  });
});
