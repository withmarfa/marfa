import { describe, expect, it } from "vitest";
import { hashApiKey } from "./middleware/auth.js";
import { getClaimStatus } from "./auth/instance-claim.js";
import {
  createTestContext,
  mintWorkingKey,
  seedOauthBearer,
  TEST_API_KEY_SALT,
  TEST_MANAGEMENT_PERMISSIONS,
} from "./test-utils.js";

// A normal fixture must produce the same claim and audit records as a real setup.
describe("production provisioning in server fixtures", () => {
  it("claims a permanent owner and signs in before minting ordinary keys", async () => {
    const ctx = await createTestContext();
    try {
      expect(await getClaimStatus(ctx.storage)).toMatchObject({
        claimed: true,
        ownerId: ctx.owner.id,
      });
      const owner = await ctx.ownerRequest("/owner");
      expect(owner.status).toBe(200);
      const management = await ctx.storage.keys.validate(
        hashApiKey(ctx.managementKey, TEST_API_KEY_SALT),
      );
      expect(management?.permissions).toEqual(TEST_MANAGEMENT_PERMISSIONS);
      expect(management?.type_permissions).toEqual({});
      const working = await ctx.storage.keys.validate(
        hashApiKey(ctx.workingKey, TEST_API_KEY_SALT),
      );
      expect(working?.type_permissions).toEqual({ "*": "write" });
      expect(working?.permissions).not.toContain("blobs.manage");
      const audit = await ctx.storage.audit.list({ action: "key.create" });
      expect(audit.data.length).toBeGreaterThanOrEqual(2);
    } finally {
      await ctx.cleanup();
    }
  });

  it("mints additional keys through the owner operation and records their creation", async () => {
    const ctx = await createTestContext();
    try {
      const raw = await mintWorkingKey(ctx, {
        label: "fixture witness",
        permissions: ["instance.read"],
        type_permissions: {},
      });
      const key = await ctx.storage.keys.validate(
        hashApiKey(raw, TEST_API_KEY_SALT),
      );
      expect(key?.permissions).toEqual(["instance.read"]);
      expect(key?.type_permissions).toEqual({});
      const entries = await ctx.storage.audit.list({
        action: "key.create",
        resource_id: key!.id,
      });
      expect(entries.data).toHaveLength(1);
    } finally {
      await ctx.cleanup();
    }
  });

  it("approves app fixtures through the real consent and token exchange", async () => {
    const ctx = await createTestContext();
    try {
      const app = await seedOauthBearer(ctx, ["instance.read"]);
      const grant = await ctx.storage.items.get(app.grantId);
      expect(grant?.properties).toMatchObject({
        user_id: ctx.owner.id,
        client_id: app.clientId,
        scopes: ["instance.read"],
      });
      const entries = await ctx.storage.audit.list({
        action: "auth.grant.created",
      });
      expect(
        entries.data.some((entry) => entry.resource_id === app.clientId),
      ).toBe(true);
    } finally {
      await ctx.cleanup();
    }
  });
});
