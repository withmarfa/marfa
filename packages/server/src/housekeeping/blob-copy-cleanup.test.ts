import { afterEach, beforeEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, unlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createTestContext, type TestContext } from "../test-utils.js";
import { createSqliteStorage } from "../storage/sqlite/index.js";
import { finishPendingCopyDeletions } from "./blob-delete.js";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => {
  await ctx.cleanup();
});

it("advances a bounded cleanup past a persistent failure across restart, then retries the retained intent", async () => {
  const disk = ctx.blobs.disk;
  const rows = ["first cleanup", "second cleanup"]
    .map((text) => {
      const bytes = Buffer.from(text);
      return {
        bytes,
        hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      };
    })
    .sort((a, b) => a.hash.localeCompare(b.hash));
  for (const row of rows) {
    await disk.put(row.hash, {
      stream: Readable.from(row.bytes),
      size_bytes: row.bytes.length,
    });
    await ctx.storage.blobs.queueCopyDeletion(row.hash, disk.id);
  }
  const [first, second] = rows;
  const hex = first!.hash.slice(7);
  const badPath = join(disk.locator, hex.slice(0, 4), hex);
  await unlink(badPath);
  await mkdir(badPath);

  await finishPendingCopyDeletions(ctx.storage, ctx.blobs, 1);
  expect(await disk.has(second!.hash)).not.toBeNull();
  expect(await ctx.storage.blobs.listPendingCopyDeletions(100)).toHaveLength(2);
  const laterBytes = Buffer.from("cleanup queued after the failed attempt");
  const laterHash = `sha256:${createHash("sha256").update(laterBytes).digest("hex")}`;
  await disk.put(laterHash, {
    stream: Readable.from(laterBytes),
    size_bytes: laterBytes.length,
  });
  await ctx.storage.blobs.queueCopyDeletion(laterHash, disk.id);
  await ctx.storage.close();
  const reopened = await createSqliteStorage(join(ctx.tmpDir, "test.db"));
  try {
    await finishPendingCopyDeletions(reopened, ctx.blobs, 1);
    expect(await disk.has(second!.hash)).toBeNull();
    expect(await reopened.blobs.listPendingCopyDeletions(100)).toEqual([
      { hash: first!.hash, store_id: disk.id },
      { hash: laterHash, store_id: disk.id },
    ]);
    await finishPendingCopyDeletions(reopened, ctx.blobs, 1);
    expect(await disk.has(laterHash)).not.toBeNull();
    await finishPendingCopyDeletions(reopened, ctx.blobs, 1);
    expect(await disk.has(laterHash)).toBeNull();
    expect(await reopened.blobs.listPendingCopyDeletions(100)).toHaveLength(1);
    await rm(badPath, { recursive: true });
    await finishPendingCopyDeletions(reopened, ctx.blobs, 1);
    expect(await reopened.blobs.listPendingCopyDeletions(100)).toEqual([]);
    await finishPendingCopyDeletions(reopened, ctx.blobs, 1);
    expect(
      (await reopened.audit.list({ action: "blob.copy_dropped" })).data,
    ).toEqual([]);
  } finally {
    await reopened.close();
  }
});
