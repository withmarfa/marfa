/**
 * The integrity check stamps a copy found present and intact and strikes
 * one found missing or altered, so replication can put it back. A second
 * disk store stands in for the bucket in most of these, checked the way a
 * disk is, by re-hashing; the object store's own check, by name and size,
 * is driven through a stub of that kind.
 */
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it, expect, afterEach } from "vitest";
import { createTestContext, withSecondStore } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import type { BlobStore } from "../storage/blob-store.js";
import { BlobIntegrityChecker } from "./blob-integrity.js";
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

/** Where a disk store keeps one hash: four hex characters of directory,
 *  then the hex. */
function diskPath(locator: string, hash: string): string {
  const hex = hash.slice("sha256:".length);
  return join(locator, hex.slice(0, 4), hex);
}

function quiet(): () => void {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  return () => {
    process.stdout.write = write;
  };
}

describe("BlobIntegrityChecker.runOnce", () => {
  it("stamps every intact copy, strikes an altered one and a missing one, and audits each strike", async () => {
    ctx = await createTestContext();
    const { stores, second } = await withSecondStore(ctx);
    const altered = await upload(ctx, "will be overwritten on disk");
    const missing = await upload(ctx, "will be removed from the second store");
    const sound = await upload(ctx, "left alone");
    await new BlobReplicator(ctx.storage, stores, {
      maxBlobs: 100,
      maxBytes: 1024 * 1024,
    }).runOnce();

    const now = new Date();
    const checker = new BlobIntegrityChecker(
      ctx.storage,
      stores,
      { maxRows: 100, maxBytes: 1024 * 1024 },
      () => now,
    );
    // Before anything is wrong: every copy stamped, nothing struck.
    expect(await checker.runOnce()).toMatchObject({ verified: 6, struck: 0 });
    for (const hash of [altered, missing, sound]) {
      const locations = await ctx.storage.blobs.listLocations(hash);
      expect(locations).toHaveLength(2);
      for (const location of locations) {
        expect(location.verified_at).toBe(now.toISOString());
      }
    }

    // A corrupt copy on the disk, the same length as the bytes it replaces
    // so only the digest can tell, and a copy gone from the second store.
    await writeFile(
      diskPath(ctx.blobs.disk.locator, altered),
      "will be overwritten on DISK",
    );
    await rm(diskPath(second.locator, missing));
    const restore = quiet();
    let result;
    try {
      result = await checker.runOnce();
    } finally {
      restore();
    }
    expect(result).toMatchObject({ verified: 4, struck: 2 });
    expect(
      (await ctx.storage.blobs.listLocations(altered)).map((l) => l.store_id),
    ).toEqual([second.id]);
    expect(
      (await ctx.storage.blobs.listLocations(missing)).map((l) => l.store_id),
    ).toEqual([ctx.blobs.disk.id]);
    expect(await ctx.storage.blobs.listLocations(sound)).toHaveLength(2);
    const audits = await ctx.storage.audit.list({
      action: "blob.copy_struck",
      limit: 10,
    });
    expect(audits.data.map((row) => row.resource_id).sort()).toEqual(
      [altered, missing].sort(),
    );

    // Replication puts both back from the copy that survived, and the next
    // check finds the whole set intact again.
    await new BlobReplicator(ctx.storage, stores, {
      maxBlobs: 100,
      maxBytes: 1024 * 1024,
    }).runOnce();
    expect(await checker.runOnce()).toMatchObject({ verified: 6, struck: 0 });
    const read = await ctx.blobs.disk.get(altered);
    const chunks: Buffer[] = [];
    for await (const chunk of read!.stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString("utf8")).toBe(
      "will be overwritten on disk",
    );
  });

  it("checks the least recently checked first, within its bounds", async () => {
    ctx = await createTestContext();
    const { stores } = await withSecondStore(ctx);
    const first = await upload(ctx, "checked first");
    const second = await upload(ctx, "checked second");
    let now = new Date();
    const checker = new BlobIntegrityChecker(
      ctx.storage,
      stores,
      { maxRows: 1, maxBytes: 1024 * 1024 },
      () => now,
    );
    // One row per store per run: the disk holds both, the second store
    // holds neither yet, so the first run stamps one disk copy.
    expect(await checker.runOnce()).toMatchObject({ verified: 1, struck: 0 });
    const stampedFirst = (await ctx.storage.blobs.listLocations(first))[0];
    const stampedSecond = (await ctx.storage.blobs.listLocations(second))[0];
    const stamped = [stampedFirst, stampedSecond].filter(
      (l) => l?.verified_at !== null,
    );
    expect(stamped).toHaveLength(1);
    // The next run takes the one never checked, not the one just stamped.
    const t0 = now.toISOString();
    now = new Date(now.getTime() + 1_000);
    expect(await checker.runOnce()).toMatchObject({ verified: 1, struck: 0 });
    const stampOf = async (hash: string) =>
      (await ctx!.storage.blobs.listLocations(hash))[0]?.verified_at;
    const t1 = now.toISOString();
    expect([await stampOf(first), await stampOf(second)].sort()).toEqual([
      t0,
      t1,
    ]);
    // Then the older stamp moves and the newer stays: least recently
    // checked, not first registered.
    const oldest = (await stampOf(first)) === t0 ? first : second;
    const newest = oldest === first ? second : first;
    now = new Date(now.getTime() + 1_000);
    expect(await checker.runOnce()).toMatchObject({ verified: 1, struck: 0 });
    expect(await stampOf(oldest)).toBe(now.toISOString());
    expect(await stampOf(newest)).toBe(t1);

    // By bytes: a copy that would cross the bound waits for the next run,
    // unless it is the run's first.
    const large = await upload(ctx, "z".repeat(5_000));
    const byBytes = new BlobIntegrityChecker(
      ctx.storage,
      stores,
      { maxRows: 100, maxBytes: 100 },
      () => now,
    );
    // The large copy is never checked, so it is first, and goes alone.
    expect(await byBytes.runOnce()).toMatchObject({
      verified: 1,
      bytes: 5_000,
    });
    expect((await ctx.storage.blobs.listLocations(large))[0]?.verified_at).toBe(
      now.toISOString(),
    );
  });

  it("reaches every store in turn when one store's copies fill the byte bound", async () => {
    // Two copies of each of two blobs, in two stores, and a bound that
    // admits one copy per run: four runs stamp all four, in order of
    // staleness across the stores rather than store by store.
    ctx = await createTestContext();
    const { stores, second } = await withSecondStore(ctx);
    const one = await upload(ctx, "shared by both stores, one");
    const two = await upload(ctx, "shared by both stores, two");
    await new BlobReplicator(ctx.storage, stores, {
      maxBlobs: 100,
      maxBytes: 1024 * 1024,
    }).runOnce();
    let now = new Date();
    const checker = new BlobIntegrityChecker(
      ctx.storage,
      stores,
      { maxRows: 100, maxBytes: 1 },
      () => now,
    );
    const stampOf = async (hash: string, storeId: string) =>
      (await ctx!.storage.blobs.listLocations(hash)).find(
        (l) => l.store_id === storeId,
      )?.verified_at ?? null;
    const copies = [
      [one, ctx.blobs.disk.id],
      [two, ctx.blobs.disk.id],
      [one, second.id],
      [two, second.id],
    ] as const;
    for (const [hash, storeId] of copies) {
      expect(await stampOf(hash, storeId)).toBeNull();
    }
    const stamps: string[] = [];
    for (let i = 0; i < 4; i++) {
      now = new Date(now.getTime() + 1_000);
      expect(await checker.runOnce()).toMatchObject({ verified: 1 });
      stamps.push(now.toISOString());
    }
    // Every copy in both stores carries one of the four stamps, each once.
    const carried = [];
    for (const [hash, storeId] of copies) {
      carried.push(await stampOf(hash, storeId));
    }
    expect(carried.sort()).toEqual([...stamps].sort());
    // And the second store was reached within the first two runs: the
    // never-checked copies went in one order across both stores, so a
    // store's backlog cannot hold the other back.
    const secondStoreFirst = [
      await stampOf(one, second.id),
      await stampOf(two, second.id),
    ].some((at) => at === stamps[0] || at === stamps[1]);
    expect(secondStoreFirst).toBe(true);
  });

  it("asks an object store for a copy by name and size, and strikes one it cannot answer for", async () => {
    ctx = await createTestContext();
    const good = await upload(ctx, "present in the object store");
    const gone = await upload(ctx, "missing from the object store");
    const wrong = await upload(ctx, "a different size in the object store");
    // A stub of the object store's kind: `has` is what the check asks it,
    // and `get` is never called on it.
    const answers = new Map<string, { size_bytes: number } | null>([
      [good, { size_bytes: "present in the object store".length }],
      [gone, null],
      [wrong, { size_bytes: 1 }],
    ]);
    let fetched = 0;
    const deleted: string[] = [];
    const stub: BlobStore = {
      id: "stub-object-store",
      kind: "s3",
      locator: "s3://stub/blobs",
      attach: () => Promise.resolve(),
      put: () => Promise.resolve(),
      get: () => {
        fetched += 1;
        return Promise.resolve({
          stream: Readable.from([]),
          size_bytes: 0,
          offset: 0,
          length: 0,
        });
      },
      has: (hash) => Promise.resolve(answers.get(hash) ?? null),
      delete: (hash) => {
        deleted.push(hash);
        return Promise.resolve();
      },
    };
    await ctx.storage.blobs.attachStore({
      id: stub.id,
      kind: stub.kind,
      locator: stub.locator,
    });
    for (const hash of [good, gone, wrong]) {
      await ctx.storage.blobs.recordLocation(hash, stub.id);
    }
    const all = [ctx.blobs.disk, stub];
    const checker = new BlobIntegrityChecker(
      ctx.storage,
      { stores: all, byId: (id) => all.find((s) => s.id === id) },
      { maxRows: 100, maxBytes: 1024 * 1024 },
    );
    const restore = quiet();
    let result;
    try {
      result = await checker.runOnce();
    } finally {
      restore();
    }
    // Three disk copies and the good stub copy stamped; the missing and
    // the wrong-sized stub copies struck, and their names discarded.
    expect(result).toMatchObject({ verified: 4, struck: 2 });
    expect(fetched).toBe(0);
    expect(deleted.sort()).toEqual([gone, wrong].sort());
    const stubHolds = async (hash: string) =>
      (await ctx!.storage.blobs.listLocations(hash)).some(
        (l) => l.store_id === stub.id,
      );
    expect(await stubHolds(good)).toBe(true);
    expect(await stubHolds(gone)).toBe(false);
    expect(await stubHolds(wrong)).toBe(false);
  });
});
