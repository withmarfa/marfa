import { describe, it, expect, afterEach } from "vitest";
import { createTestContext } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { DeviceCodeCleaner } from "./retention.js";

/**
 * Expired device-code rows are swept, whatever their status, and only once
 * they are an hour past expiry; a live row is never touched.
 */

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

async function seedCode(
  c: TestContext,
  userCode: string,
  expiresAt: Date,
): Promise<string> {
  const row = await c.storage.oauth.createDeviceCode({
    deviceCodeHash: `hash_${userCode}`,
    userCode,
    clientId: "client_sweep",
    scope: "core.note:read",
    expiresAt: expiresAt.toISOString(),
    intervalSeconds: 5,
  });
  return row.id;
}

/** A projection for an approval to bind to: the column carries a foreign
 *  key, so a placeholder id is refused on both dialects. */
async function seedConnection(
  c: TestContext,
  clientId: string,
): Promise<string> {
  const item = await c.storage.items.create({
    type: "system.connection",
    tier: "library",
    state: "active",
    properties: {
      kind: "app",
      client_id: clientId,
      user_id: "some-user",
      scopes: ["core.note:read"],
      status: "active",
      granted_at: new Date().toISOString(),
    },
    source: "test/device-code-cleaner",
  });
  return item.id;
}

describe("DeviceCodeCleaner.runOnce", () => {
  it("deletes rows an hour past expiry in every status and leaves live and freshly expired rows", async () => {
    ctx = await createTestContext();
    const now = new Date("2026-09-05T12:00:00.000Z");
    const hours = (n: number) => new Date(now.getTime() + n * 3_600_000);
    const oauth = ctx.storage.oauth;

    // One stale row per status: pending, denied, approved and redeemed.
    await seedCode(ctx, "AAAA-0001", hours(-2));
    const staleDenied = await seedCode(ctx, "AAAA-0002", hours(-2));
    await oauth.denyDeviceCode(staleDenied);
    const staleApproved = await seedCode(ctx, "AAAA-0005", hours(-2));
    await oauth.approveDeviceCode(
      staleApproved,
      await seedConnection(ctx, "client_sweep"),
      ["core.note:read"],
    );
    const staleRedeemed = await seedCode(ctx, "AAAA-0006", hours(-2));
    await oauth.approveDeviceCode(
      staleRedeemed,
      await seedConnection(ctx, "client_sweep"),
      ["core.note:read"],
    );
    expect(await oauth.redeemDeviceCode(staleRedeemed)).toBe(true);
    // Inside the hour's grace, and live in two statuses.
    const freshlyExpired = await seedCode(ctx, "AAAA-0003", hours(-0.5));
    const live = await seedCode(ctx, "AAAA-0004", hours(1));
    const liveApproved = await seedCode(ctx, "AAAA-0007", hours(1));
    await oauth.approveDeviceCode(
      liveApproved,
      await seedConnection(ctx, "client_sweep"),
      ["core.note:read"],
    );

    const cleaner = new DeviceCodeCleaner(ctx.storage, 86_400_000, () => now);
    expect(await cleaner.runOnce()).toBe(4);

    const remaining = await Promise.all(
      [
        "AAAA-0001",
        "AAAA-0002",
        "AAAA-0005",
        "AAAA-0006",
        "AAAA-0003",
        "AAAA-0004",
        "AAAA-0007",
      ].map((code) => oauth.findDeviceCodeByUserCode(code)),
    );
    expect(remaining.map((r) => r?.id ?? null)).toEqual([
      null,
      null,
      null,
      null,
      freshlyExpired,
      live,
      liveApproved,
    ]);

    // A second run finds nothing to do.
    expect(await cleaner.runOnce()).toBe(0);
  });
});
