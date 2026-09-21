/**
 * The copy rules are written over the location log, and a detached
 * store's copy is not a copy: nothing can reach it to check it.
 */
import { Readable } from "node:stream";
import { describe, it, expect, afterEach } from "vitest";
import { createTestContext, withSecondStore } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import {
  CopiesBelowMinimum,
  LocationNotFound,
  dropBlobCopy,
  purgeBlob,
} from "./blob-delete.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

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

describe("dropBlobCopy", () => {
  it("counts only attached stores' copies toward the minimum", async () => {
    ctx = await createTestContext();
    const { stores, second } = await withSecondStore(ctx);
    const content = "held twice, one store detached";
    const hash = await upload(ctx, content);
    await second.put(hash, {
      stream: Readable.from([Buffer.from(content)]),
      size_bytes: content.length,
    });
    await ctx.storage.blobs.recordLocation(hash, second.id);
    // With both attached, the disk copy can go.
    await dropBlobCopy(ctx.storage, stores, hash, ctx.blobs.disk.id, 1);
    expect(await ctx.blobs.disk.has(hash)).toBeNull();
    // Put it back, then detach the second store: its copy stops counting,
    // so the disk copy is the last live one and stays.
    await ctx.blobs.disk.put(hash, {
      stream: Readable.from([Buffer.from(content)]),
      size_bytes: content.length,
    });
    await ctx.storage.blobs.recordLocation(hash, ctx.blobs.disk.id);
    await ctx.storage.blobs.detachStoresExcept([ctx.blobs.disk.id]);
    await expect(
      dropBlobCopy(ctx.storage, stores, hash, ctx.blobs.disk.id, 1),
    ).rejects.toBeInstanceOf(CopiesBelowMinimum);
    expect(await ctx.blobs.disk.has(hash)).not.toBeNull();
    // And the detached store's copy is not one the door can drop.
    await expect(
      dropBlobCopy(ctx.storage, stores, hash, second.id, 1),
    ).rejects.toBeInstanceOf(LocationNotFound);
    expect(await second.has(hash)).not.toBeNull();
  });
});

describe("purgeBlob", () => {
  it("removes the bytes from every attached store, the rows and the registry", async () => {
    ctx = await createTestContext();
    const { stores, second } = await withSecondStore(ctx);
    const content = "everywhere, then nowhere";
    const hash = await upload(ctx, content);
    // Bytes in the second store the log does not know about: they go too.
    await second.put(hash, {
      stream: Readable.from([Buffer.from(content)]),
      size_bytes: content.length,
    });
    expect(await ctx.blobs.disk.has(hash)).not.toBeNull();
    expect(await second.has(hash)).not.toBeNull();
    expect(await ctx.storage.blobs.get(hash)).not.toBeNull();
    expect(await ctx.storage.blobs.listLocations(hash)).toHaveLength(1);
    await purgeBlob(ctx.storage, stores, hash);
    expect(await ctx.blobs.disk.has(hash)).toBeNull();
    expect(await second.has(hash)).toBeNull();
    expect(await ctx.storage.blobs.get(hash)).toBeNull();
    expect(await ctx.storage.blobs.listLocations(hash)).toEqual([]);
  });
});
