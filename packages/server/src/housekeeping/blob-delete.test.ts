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

/** Holds a store's `delete` open until released, so a deletion in flight
 *  can be raced against an upload of the same bytes. */
function gateDelete(store: { delete: (hash: string) => Promise<void> }) {
  const original = store.delete.bind(store);
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  store.delete = async (hash: string) => {
    entered();
    await held;
    await original(hash);
  };
  return {
    started,
    release,
    restore: () => {
      store.delete = original;
    },
  };
}

describe("the per-hash lock", () => {
  it("holds an upload of the same bytes behind a drop in flight, so the log and the bytes agree", async () => {
    // The drop removes the disk's row, then deletes its bytes. An upload
    // arriving between the two would see the bytes present, skip its own
    // put, and record the disk again for bytes about to go; behind the
    // lock it runs after the drop, puts the bytes back and records them.
    ctx = await createTestContext();
    const { stores, second } = await withSecondStore(ctx);
    const content = "raced by a drop";
    const hash = await upload(ctx, content);
    await second.put(hash, {
      stream: Readable.from([Buffer.from(content)]),
      size_bytes: content.length,
    });
    await ctx.storage.blobs.recordLocation(hash, second.id);
    const gate = gateDelete(ctx.blobs.disk);
    try {
      const dropping = dropBlobCopy(
        ctx.storage,
        stores,
        hash,
        ctx.blobs.disk.id,
        1,
      );
      await gate.started;
      let uploaded = false;
      const uploading = upload(ctx, content).then((h) => {
        uploaded = true;
        return h;
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(uploaded).toBe(false);
      gate.release();
      await dropping;
      expect(await uploading).toBe(hash);
    } finally {
      gate.restore();
    }
    const locations = await ctx.storage.blobs.listLocations(hash);
    expect(locations.map((l) => l.store_id).sort()).toEqual(
      [ctx.blobs.disk.id, second.id].sort(),
    );
    expect(await ctx.blobs.disk.has(hash)).not.toBeNull();
  });

  it("holds an upload of the same bytes behind a purge in flight, so the row outlives the purge", async () => {
    // The purge deletes the bytes, then the registry row. An upload
    // arriving between the two would find the row still there, record
    // nothing new, answer 201, and then lose the row to the purge; behind
    // the lock it runs after the purge and registers the bytes afresh.
    ctx = await createTestContext();
    const { stores } = await withSecondStore(ctx);
    const content = "raced by a purge";
    const hash = await upload(ctx, content);
    const gate = gateDelete(ctx.blobs.disk);
    try {
      const purging = purgeBlob(ctx.storage, stores, hash);
      await gate.started;
      let uploaded = false;
      const uploading = upload(ctx, content).then((h) => {
        uploaded = true;
        return h;
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(uploaded).toBe(false);
      gate.release();
      await purging;
      expect(await uploading).toBe(hash);
    } finally {
      gate.restore();
    }
    expect(await ctx.storage.blobs.get(hash)).not.toBeNull();
    expect(
      (await ctx.storage.blobs.listLocations(hash)).map((l) => l.store_id),
    ).toEqual([ctx.blobs.disk.id]);
    expect(await ctx.blobs.disk.has(hash)).not.toBeNull();
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
