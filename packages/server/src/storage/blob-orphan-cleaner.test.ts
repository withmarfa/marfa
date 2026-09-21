import { describe, it, expect, afterEach } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { BlobOrphanCleaner } from "./retention.js";

/**
 * An upload whose item write never landed is reclaimed, and an upload
 * whose item write has not landed *yet* is not.
 *
 * Those two are the same state, and only the registration stamp tells
 * them apart, so the grace window is the whole subject here: a sweep that
 * ignored it would delete bytes a caller is still on its way to using.
 */

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

const GRACE_MS = 3_600_000;

/** Register through the real upload door, so the row carries whatever
 *  stamp the store actually writes rather than one the test chose. */
async function upload(c: TestContext, content: string): Promise<string> {
  const res = await c.app.request("/blobs", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.workingKey}`,
      "Content-Type": "application/octet-stream",
    },
    body: new TextEncoder().encode(content),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { hash: string }).hash;
}

describe("BlobOrphanCleaner.runOnce", () => {
  it("holds an unreferenced blob for its grace window, then reclaims it", async () => {
    ctx = await createTestContext();
    const orphan = await upload(ctx, "no item will ever point at this");
    const referenced = await upload(ctx, "an item points at this");
    const itemRes = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: {
        type: "core.note",
        properties: { body: "see attached", attachment: referenced },
      },
    });
    expect(itemRes.status).toBe(201);

    const now = new Date();
    const insideWindow = new BlobOrphanCleaner(
      ctx.storage,
      ctx.blobs,
      GRACE_MS,
      () => now,
    );
    expect(await insideWindow.runOnce()).toBe(0);
    expect(await ctx.storage.blobs.get(orphan)).not.toBeNull();

    const pastWindow = new BlobOrphanCleaner(
      ctx.storage,
      ctx.blobs,
      GRACE_MS,
      () => new Date(now.getTime() + GRACE_MS * 2),
    );
    expect(await pastWindow.runOnce()).toBe(1);

    // The bytes and the charge both go.
    expect(await ctx.storage.blobs.get(orphan)).toBeNull();
    expect(await ctx.blobs.disk.has(orphan)).toBeNull();
    // Age is not what condemns a blob; being unreferenced is.
    expect(await ctx.storage.blobs.get(referenced)).not.toBeNull();
    expect(await ctx.blobs.disk.has(referenced)).not.toBeNull();
    // And the sweep is idempotent.
    expect(await pastWindow.runOnce()).toBe(0);
  });

  it("is disabled by a grace window of zero", async () => {
    ctx = await createTestContext();
    const orphan = await upload(ctx, "zero grace is an off switch");

    const cleaner = new BlobOrphanCleaner(
      ctx.storage,
      ctx.blobs,
      0,
      () => new Date(Date.now() + GRACE_MS * 24),
    );
    expect(await cleaner.runOnce()).toBe(0);
    expect(await ctx.storage.blobs.get(orphan)).not.toBeNull();
  });
});
