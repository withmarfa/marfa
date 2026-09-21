/**
 * The integrity check stamps a copy found present and intact and strikes
 * one found missing or altered, so replication can put it back. A second
 * disk store stands in for the bucket; its copies are checked the way a
 * disk's are, by re-hashing, because both stores here are disks.
 */
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { createTestContext, withSecondStore } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
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

/** Where a disk store keeps one hash: two hex characters of directory,
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

    // A corrupt copy on the disk, and a copy gone from the second store.
    await writeFile(diskPath(ctx.blobs.disk.locator, altered), "not the bytes");
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
    now = new Date(now.getTime() + 1_000);
    expect(await checker.runOnce()).toMatchObject({ verified: 1, struck: 0 });
    for (const hash of [first, second]) {
      expect(
        (await ctx.storage.blobs.listLocations(hash))[0]?.verified_at,
      ).not.toBeNull();
    }
    // Then the oldest stamp, which moves to now.
    now = new Date(now.getTime() + 1_000);
    expect(await checker.runOnce()).toMatchObject({ verified: 1, struck: 0 });
    const stamps = [
      (await ctx.storage.blobs.listLocations(first))[0]?.verified_at,
      (await ctx.storage.blobs.listLocations(second))[0]?.verified_at,
    ];
    expect(stamps).toContain(now.toISOString());

    // By bytes: a copy that would cross the bound waits for the next run,
    // unless it is the run's first.
    const large = await upload(ctx, "z".repeat(5_000));
    const byBytes = new BlobIntegrityChecker(
      ctx.storage,
      stores,
      { maxRows: 100, maxBytes: 100 },
      () => now,
    );
    // Three unstamped-or-oldest rows on the disk: the large one is never
    // checked, so it is first, and goes alone.
    expect(await byBytes.runOnce()).toMatchObject({
      verified: 1,
      bytes: 5_000,
    });
    expect((await ctx.storage.blobs.listLocations(large))[0]?.verified_at).toBe(
      now.toISOString(),
    );
  });
});
