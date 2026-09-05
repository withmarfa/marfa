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

describe("DeviceCodeCleaner.runOnce", () => {
  it("deletes rows an hour past expiry in every status and leaves live and freshly expired rows", async () => {
    ctx = await createTestContext();
    const now = new Date("2026-09-05T12:00:00.000Z");
    const hours = (n: number) => new Date(now.getTime() + n * 3_600_000);

    const stalePending = await seedCode(ctx, "AAAA-0001", hours(-2));
    const staleDenied = await seedCode(ctx, "AAAA-0002", hours(-2));
    await ctx.storage.oauth.denyDeviceCode(staleDenied);
    const freshlyExpired = await seedCode(ctx, "AAAA-0003", hours(-0.5));
    const live = await seedCode(ctx, "AAAA-0004", hours(1));

    const cleaner = new DeviceCodeCleaner(ctx.storage, 86_400_000, () => now);
    expect(await cleaner.runOnce()).toBe(2);

    const remaining = await Promise.all(
      ["AAAA-0001", "AAAA-0002", "AAAA-0003", "AAAA-0004"].map((code) =>
        ctx!.storage.oauth.findDeviceCodeByUserCode(code),
      ),
    );
    expect(remaining.map((r) => r?.id ?? null)).toEqual([
      null,
      null,
      freshlyExpired,
      live,
    ]);
    void stalePending;

    // A second run finds nothing to do.
    expect(await cleaner.runOnce()).toBe(0);
  });
});
