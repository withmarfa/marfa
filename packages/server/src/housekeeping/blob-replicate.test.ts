/**
 * Replication gives every attached store the copies the log says it lacks,
 * bounded per run, and records a copy only once the target has verified
 * it. A second disk store stands in for the bucket.
 */
import { createHash } from "node:crypto";
import { rename } from "node:fs/promises";
import { Readable } from "node:stream";
import { describe, it, expect, afterEach } from "vitest";
import { createTestContext, withSecondStore } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { BlobStore } from "../storage/blob-store.js";
import { storeChecks } from "../storage/blob-layer.js";
import { BlobReplicator } from "./blob-replicate.js";

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

/** `work`'s value, or a rejection once `ms` pass without it settling. */
async function settlesWithin<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`still running after ${String(ms)} ms`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** `work` with the process's log lines held back. */
async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try {
    return await work();
  } finally {
    process.stdout.write = write;
  }
}

async function bytesOf(store: BlobStore, hash: string): Promise<string> {
  const read = await store.get(hash);
  if (!read) throw new Error(`${hash} absent`);
  const chunks: Buffer[] = [];
  for await (const chunk of read.stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

describe("BlobReplicator.runOnce", () => {
  it("copies what a store lacks from a store that has it, and records the copy", async () => {
    ctx = await createTestContext();
    const { stores, second } = await withSecondStore(ctx);
    const one = await upload(ctx, "replicated one");
    const two = await upload(ctx, "replicated two");
    expect(await second.has(one)).toBeNull();
    expect(
      (await ctx.storage.blobs.listLocations(one)).map((l) => l.store_id),
    ).toEqual([ctx.blobs.disk.id]);

    const replicator = new BlobReplicator(ctx.storage, stores, {
      maxBlobs: 100,
      maxBytes: 1024 * 1024,
    });
    expect(await replicator.runOnce()).toEqual({
      copied: 2,
      bytes: "replicated one".length + "replicated two".length,
      remaining: 0,
    });
    for (const hash of [one, two]) {
      expect(await bytesOf(second, hash)).toBe(
        await bytesOf(ctx.blobs.disk, hash),
      );
      const locations = await ctx.storage.blobs.listLocations(hash);
      expect(locations.map((l) => l.store_id).sort()).toEqual(
        [ctx.blobs.disk.id, second.id].sort(),
      );
      // Recorded unverified: the stamp is the integrity check's to write,
      // which is what makes it a fact about the copy rather than a default.
      expect(
        locations.find((l) => l.store_id === second.id)?.verified_at,
      ).toBeNull();
      await ctx.storage.blobs.markVerified(
        hash,
        second.id,
        "2026-09-21T00:00:00.000Z",
      );
      expect(
        (await ctx.storage.blobs.listLocations(hash)).find(
          (l) => l.store_id === second.id,
        )?.verified_at,
      ).toBe("2026-09-21T00:00:00.000Z");
    }
    // Nothing left to copy: a second run copies nothing.
    expect(await replicator.runOnce()).toEqual({
      copied: 0,
      bytes: 0,
      remaining: 0,
    });
  });

  it("copies in both directions: a blob only the second store holds reaches the disk", async () => {
    ctx = await createTestContext();
    const { stores, second } = await withSecondStore(ctx);
    const content = "only the bucket has this";
    const hash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    await second.put(hash, {
      stream: Readable.from([Buffer.from(content)]),
      size_bytes: content.length,
    });
    await ctx.storage.blobs.register(hash, "text/plain", content.length);
    await ctx.storage.blobs.recordLocation(hash, second.id);
    expect(await ctx.blobs.disk.has(hash)).toBeNull();

    const replicator = new BlobReplicator(ctx.storage, stores, {
      maxBlobs: 100,
      maxBytes: 1024 * 1024,
    });
    expect(await replicator.runOnce()).toMatchObject({
      copied: 1,
      remaining: 0,
    });
    expect(await bytesOf(ctx.blobs.disk, hash)).toBe(content);
    expect(
      (await ctx.storage.blobs.listLocations(hash))
        .map((l) => l.store_id)
        .sort(),
    ).toEqual([ctx.blobs.disk.id, second.id].sort());
  });

  it("goes on to the next store when one cannot be reached", async () => {
    ctx = await createTestContext();
    const { stores, second } = await withSecondStore(ctx);
    const onDisk = await upload(ctx, "the unreachable store lacks this");
    const content = "only the unreachable store has this";
    const onSecond = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    await second.put(onSecond, {
      stream: Readable.from([Buffer.from(content)]),
      size_bytes: content.length,
    });
    await ctx.storage.blobs.register(onSecond, "text/plain", content.length);
    await ctx.storage.blobs.recordLocation(onSecond, second.id);
    const has = second.has.bind(second);
    second.has = () => Promise.reject(new Error("store unreachable"));
    try {
      const replicator = new BlobReplicator(ctx.storage, stores, {
        maxBlobs: 100,
        maxBytes: 1024 * 1024,
      });
      expect(await replicator.runOnce()).toMatchObject({
        copied: 1,
        remaining: 1,
      });
    } finally {
      second.has = has;
    }
    expect(await bytesOf(ctx.blobs.disk, onSecond)).toBe(content);
    expect(await second.has(onDisk)).toBeNull();
  });

  it("gives up on a target that does not answer in time, copies nothing into it, and copies it once the store answers", async () => {
    ctx = await createTestContext();
    const { stores, second } = await withSecondStore(ctx);
    const hash = await upload(ctx, "a hanging store lacks this");
    const has = second.has.bind(second);
    let open = 0;
    second.has = (_hash, signal) => {
      open++;
      return new Promise<never>((_, reject) => {
        signal?.addEventListener("abort", () => {
          open--;
          reject(new Error("request aborted"));
        });
      });
    };
    const replicator = new BlobReplicator(ctx.storage, stores, {
      maxBlobs: 100,
      maxBytes: 1024 * 1024,
    });
    const timeout = storeChecks.timeoutMs;
    storeChecks.timeoutMs = 50;
    try {
      expect(
        await quietly(() => settlesWithin(replicator.runOnce(), 5_000)),
      ).toMatchObject({ copied: 0, remaining: 1 });
    } finally {
      second.has = has;
      storeChecks.timeoutMs = timeout;
    }
    expect(open).toBe(0);
    expect(await second.has(hash)).toBeNull();
    expect(
      (await ctx.storage.blobs.listLocations(hash)).map((l) => l.store_id),
    ).toEqual([ctx.blobs.disk.id]);
    // The lock is free and nothing stands in the way of the copy.
    expect(await replicator.runOnce()).toMatchObject({
      copied: 1,
      remaining: 0,
    });
    expect(await bytesOf(second, hash)).toBe("a hanging store lacks this");
  });

  it("gives up on a source that does not answer in time, and closes the read it opens after all", async () => {
    ctx = await createTestContext();
    const { stores, second } = await withSecondStore(ctx);
    const content = "only a hanging store has this";
    const hash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    await second.put(hash, {
      stream: Readable.from([Buffer.from(content)]),
      size_bytes: content.length,
    });
    await ctx.storage.blobs.register(hash, "text/plain", content.length);
    await ctx.storage.blobs.recordLocation(hash, second.id);
    const get = second.get.bind(second);
    let late: Readable | undefined;
    let opened!: () => void;
    const openedLate = new Promise<void>((resolve) => {
      opened = resolve;
    });
    // A store that ignores the call-off and answers after the bound.
    second.get = async (wanted, range) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const read = await get(wanted, range);
      late = read?.stream;
      opened();
      return read;
    };
    const timeout = storeChecks.timeoutMs;
    storeChecks.timeoutMs = 50;
    try {
      expect(
        await quietly(() =>
          settlesWithin(
            new BlobReplicator(ctx!.storage, stores, {
              maxBlobs: 100,
              maxBytes: 1024 * 1024,
            }).runOnce(),
            5_000,
          ),
        ),
      ).toMatchObject({ copied: 0, remaining: 1 });
      await openedLate;
      // The late answer reaches its handler after the store hands it back.
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      second.get = get;
      storeChecks.timeoutMs = timeout;
    }
    expect(late?.destroyed).toBe(true);
    expect(await ctx.blobs.disk.has(hash)).toBeNull();
    expect(
      (await ctx.storage.blobs.listLocations(hash)).map((l) => l.store_id),
    ).toEqual([second.id]);
  });

  it("stops at its bounds and says how many remain", async () => {
    ctx = await createTestContext();
    const { stores, second } = await withSecondStore(ctx);
    const hashes = [];
    for (const word of ["a", "b", "c", "d", "e"]) {
      hashes.push(await upload(ctx, `bounded ${word}`));
    }
    const byCount = new BlobReplicator(ctx.storage, stores, {
      maxBlobs: 2,
      maxBytes: 1024 * 1024,
    });
    expect(await byCount.runOnce()).toMatchObject({ copied: 2, remaining: 3 });
    expect(await byCount.runOnce()).toMatchObject({ copied: 2, remaining: 1 });
    expect(await byCount.runOnce()).toMatchObject({ copied: 1, remaining: 0 });
    for (const hash of hashes) expect(await second.has(hash)).not.toBeNull();

    // By bytes: one blob per run once the first would cross the bound, and
    // a blob larger than the bound still goes when it is the run's first.
    const large = await upload(ctx, "x".repeat(2_000));
    const small = await upload(ctx, "y");
    const byBytes = new BlobReplicator(ctx.storage, stores, {
      maxBlobs: 100,
      maxBytes: 1_000,
    });
    // `small` was uploaded after `large`, and copies go in upload order:
    // `large` first, alone, because it crosses the bound as the run's first.
    expect(await byBytes.runOnce()).toEqual({
      copied: 1,
      bytes: 2_000,
      remaining: 1,
    });
    expect(await second.has(large)).not.toBeNull();
    expect(await second.has(small)).toBeNull();
    expect(await byBytes.runOnce()).toEqual({
      copied: 1,
      bytes: 1,
      remaining: 0,
    });
  });

  it("records no copy for bytes the target refused, and finds them again next run", async () => {
    ctx = await createTestContext();
    const { stores, second } = await withSecondStore(ctx);
    const hash = await upload(ctx, "refused once");
    const put = second.put.bind(second);
    let refusals = 0;
    second.put = () => {
      refusals += 1;
      return Promise.reject(new Error("no room"));
    };
    const stdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    const replicator = new BlobReplicator(ctx.storage, stores, {
      maxBlobs: 100,
      maxBytes: 1024 * 1024,
    });
    try {
      expect(await replicator.runOnce()).toEqual({
        copied: 0,
        bytes: 0,
        remaining: 1,
      });
    } finally {
      process.stdout.write = stdout;
      second.put = put;
    }
    expect(refusals).toBe(1);
    expect(
      (await ctx.storage.blobs.listLocations(hash)).map((l) => l.store_id),
    ).toEqual([ctx.blobs.disk.id]);
    // The witness: once the store takes the bytes, the copy is recorded.
    expect(await replicator.runOnce()).toMatchObject({
      copied: 1,
      remaining: 0,
    });
    expect(await second.has(hash)).not.toBeNull();
  });

  it("reads from the disk when both a disk and an object store hold the blob", async () => {
    ctx = await createTestContext();
    const { stores, second } = await withSecondStore(ctx);
    const hash = await upload(ctx, "read from the nearer copy");
    // An object-store stub the log also names as holding the blob, which
    // counts how often it is read from.
    let reads = 0;
    const stub: BlobStore = {
      id: "stub-object-store",
      kind: "s3",
      locator: "s3://stub/blobs",
      attach: () => Promise.resolve(),
      put: () => Promise.resolve(),
      get: () => {
        reads += 1;
        return Promise.resolve({
          stream: Readable.from([Buffer.from("read from the nearer copy")]),
          size_bytes: "read from the nearer copy".length,
          offset: 0,
          length: "read from the nearer copy".length,
        });
      },
      has: () => Promise.resolve({ size_bytes: 25 }),
      delete: () => Promise.resolve(),
    };
    await ctx.storage.blobs.attachStore({
      id: stub.id,
      kind: stub.kind,
      locator: stub.locator,
    });
    await ctx.storage.blobs.recordLocation(hash, stub.id);
    const all = [...stores.stores, stub];
    const replicator = new BlobReplicator(
      ctx.storage,
      { stores: all, byId: (id) => all.find((s) => s.id === id) },
      { maxBlobs: 100, maxBytes: 1024 * 1024 },
    );
    expect(await replicator.runOnce()).toMatchObject({
      copied: 1,
      remaining: 0,
    });
    expect(await second.has(hash)).not.toBeNull();
    expect(reads).toBe(0);
    // The witness that the stub is a source at all: with the disk's copy
    // struck from the log, the object store is what is read.
    const third = await upload(
      ctx,
      "read from the far copy when it is all there is",
    );
    await ctx.storage.blobs.recordLocation(third, stub.id);
    await ctx.storage.blobs.removeLocation(third, ctx.blobs.disk.id);
    await ctx.blobs.disk.delete(third);
    stub.get = () => {
      reads += 1;
      return Promise.resolve({
        stream: Readable.from([
          Buffer.from("read from the far copy when it is all there is"),
        ]),
        size_bytes: "read from the far copy when it is all there is".length,
        offset: 0,
        length: "read from the far copy when it is all there is".length,
      });
    };
    // The disk gets its copy from the stub, the one read; the second store
    // then gets its copy from the disk, which now has one.
    expect(await replicator.runOnce()).toMatchObject({
      copied: 2,
      remaining: 0,
    });
    expect(reads).toBe(1);
    expect(await ctx.blobs.disk.has(third)).not.toBeNull();
    expect(await second.has(third)).not.toBeNull();
  });

  it("records nothing for a copy the log names but the source no longer has", async () => {
    ctx = await createTestContext();
    const { stores, second } = await withSecondStore(ctx);
    const hash = await upload(ctx, "named by the log, gone from the disk");
    await ctx.blobs.disk.delete(hash);
    const replicator = new BlobReplicator(ctx.storage, stores, {
      maxBlobs: 100,
      maxBytes: 1024 * 1024,
    });
    expect(await replicator.runOnce()).toEqual({
      copied: 0,
      bytes: 0,
      remaining: 1,
    });
    expect(await second.has(hash)).toBeNull();
    expect(
      (await ctx.storage.blobs.listLocations(hash)).map((l) => l.store_id),
    ).toEqual([ctx.blobs.disk.id]);
    // The witness: with the bytes back, the same run copies them.
    await ctx.blobs.disk.put(hash, {
      stream: Readable.from([
        Buffer.from("named by the log, gone from the disk"),
      ]),
      size_bytes: "named by the log, gone from the disk".length,
    });
    expect(await replicator.runOnce()).toMatchObject({
      copied: 1,
      remaining: 0,
    });
  });

  it("does not count a copy only a detached store holds as a source, or as work remaining", async () => {
    ctx = await createTestContext();
    const { stores, second } = await withSecondStore(ctx);
    const content = "held by a store the configuration no longer names";
    const hash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    await second.put(hash, {
      stream: Readable.from([Buffer.from(content)]),
      size_bytes: content.length,
    });
    await ctx.storage.blobs.register(hash, "text/plain", content.length);
    await ctx.storage.blobs.recordLocation(hash, second.id);
    const replicator = new BlobReplicator(ctx.storage, stores, {
      maxBlobs: 100,
      maxBytes: 1024 * 1024,
    });
    // Attached: the second store is a source, and the disk lacks the blob.
    expect(await ctx.storage.blobs.countMissingFrom(ctx.blobs.disk.id)).toBe(1);
    await ctx.storage.blobs.detachStoresExcept([ctx.blobs.disk.id]);
    expect(await ctx.storage.blobs.countMissingFrom(ctx.blobs.disk.id)).toBe(0);
    expect(await replicator.runOnce()).toEqual({
      copied: 0,
      bytes: 0,
      remaining: 0,
    });
    expect(await ctx.blobs.disk.has(hash)).toBeNull();
  });
});

describe("BlobReplicator.runOnce while a store cannot be reached", () => {
  it("ends no run on a copy whose queued deletion cannot reach the folder, and copies it back, settling the deletion, once the folder returns", async () => {
    ctx = await createTestContext();
    const { stores, second } = await withSecondStore(ctx);
    const hash = await upload(ctx, "struck from a disk that goes away");
    const replicator = new BlobReplicator(ctx.storage, stores, {
      maxBlobs: 100,
      maxBytes: 1024 * 1024,
    });
    await replicator.runOnce();

    // The disk's copy struck as the integrity check leaves it: the row gone
    // and the deletion queued.
    await ctx.storage.runInTransaction(async () => {
      await ctx!.storage.blobs.removeLocation(hash, ctx!.blobs.disk.id);
      await ctx!.storage.blobs.queueCopyDeletion(hash, ctx!.blobs.disk.id);
    });
    const folder = ctx.blobs.disk.locator;
    await rename(folder, `${folder}.away`);
    const during = await replicator.runOnce();
    expect(during).toMatchObject({ copied: 0, remaining: 1 });
    expect(await ctx.storage.blobs.listPendingCopyDeletions(10)).toHaveLength(
      1,
    );

    await rename(`${folder}.away`, folder);
    expect(await replicator.runOnce()).toMatchObject({
      copied: 1,
      remaining: 0,
    });
    expect(await ctx.storage.blobs.listPendingCopyDeletions(10)).toEqual([]);
    expect(await bytesOf(ctx.blobs.disk, hash)).toBe(
      "struck from a disk that goes away",
    );
    expect(
      (await ctx.storage.blobs.listLocations(hash))
        .map((l) => l.store_id)
        .sort(),
    ).toEqual([ctx.blobs.disk.id, second.id].sort());
  });
});
