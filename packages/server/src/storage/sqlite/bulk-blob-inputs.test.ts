import { afterEach, describe, expect, it } from "vitest";
import { createTestContext } from "../../test-utils.js";
import type { TestContext } from "../../test-utils.js";
import { jobLease } from "../../bulk-actions/checkpoint.js";
import { BlobOrphanReporter } from "../../housekeeping/blob-orphans.js";

let ctx: TestContext | undefined;
const now = () => new Date().toISOString();

afterEach(async () => {
  await ctx?.cleanup();
  ctx = undefined;
});

async function create(
  id: string,
  patch: unknown,
  action = "update_properties",
) {
  return ctx!.storage.bulkActionJobs.create({
    id,
    api_key_id: null,
    credential: "fixture",
    action,
    input: JSON.stringify({ action, patch }),
    matched_ids: "[]",
    matched_count: 0,
    created_at: now(),
  });
}

async function upload(bytes: string): Promise<string> {
  const res = await ctx!.app.request("/blobs", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx!.workingKey}`,
      "Content-Type": "text/plain",
    },
    body: new TextEncoder().encode(bytes),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { hash: string }).hash;
}

describe("durable pending property patches", () => {
  it("pages by job id and reads only nonterminal property actions", async () => {
    ctx = await createTestContext();
    const jobs = ctx.storage.bulkActionJobs;
    await create("a", { order: 1 });
    await create("b", { order: 2 });
    await create("c", { order: 3 });
    await create("d", { order: 4 });
    await create("e", { order: 5 });
    await create("aa unrelated", { order: -1 }, "update_tags");
    await create("bb canceled", { order: -2 });
    await jobs.cancel("bb canceled", now());
    const claim = await jobs.claimNext("fixture owner", now());
    expect(claim?.id).toBe("a");
    const first = await jobs.scanPendingPropertyPatches(2);
    expect(first).toEqual({
      patches: [{ order: 1 }, { order: 2 }],
      cursor: "b",
    });
    const second = await jobs.scanPendingPropertyPatches(2, first.cursor!);
    expect(second).toEqual({
      patches: [{ order: 3 }, { order: 4 }],
      cursor: "d",
    });
    const last = await jobs.scanPendingPropertyPatches(2, second.cursor!);
    expect(last).toEqual({ patches: [{ order: 5 }], cursor: null });
    expect(await jobs.scanPendingPropertyPatches(2, "z")).toEqual({
      patches: [],
      cursor: null,
    });
    expect(
      await jobs.recoverStale(new Date(Date.now() + 1_000).toISOString()),
    ).toBe(1);
    expect((await jobs.scanPendingPropertyPatches(2)).patches).toEqual(
      first.patches,
    );
  });

  it.each(["complete", "fail"] as const)(
    "excludes inputs after an owned %s",
    async (end) => {
      ctx = await createTestContext();
      const jobs = ctx.storage.bulkActionJobs;
      await create("ending", { held: "digest" });
      expect((await jobs.scanPendingPropertyPatches(1)).patches).toEqual([
        { held: "digest" },
      ]);
      const row = await jobs.claimNext("ending owner", now());
      const lease = jobLease(row!);
      expect((await jobs.scanPendingPropertyPatches(1)).patches).toHaveLength(
        1,
      );
      if (end === "complete")
        expect(await jobs.completeOwned(lease, 0, now())).toBe(true);
      else
        expect(await jobs.failOwned(lease, "ordinary fixture end", now())).toBe(
          true,
        );
      expect(await jobs.scanPendingPropertyPatches(1)).toEqual({
        patches: [],
        cursor: null,
      });
    },
  );

  it("commits the enqueue and report lift together, and rolls both back together", async () => {
    ctx = await createTestContext();
    const hash = await upload("atomic enqueue lift");
    await ctx.storage.runInTransaction(() =>
      ctx!.storage.blobs.retainOrphans([hash], now()),
    );
    expect(await ctx.storage.blobs.listOrphans()).toHaveLength(1);
    await expect(
      ctx.storage.runInTransaction(async () => {
        await create("rolled back", { attachment: hash });
        expect(await ctx!.storage.blobs.listOrphans()).toEqual([]);
        throw new Error("rollback the ordinary fixture transaction");
      }),
    ).rejects.toThrow("rollback the ordinary fixture transaction");
    expect(await ctx.storage.bulkActionJobs.getById("rolled back")).toBeNull();
    expect(await ctx.storage.blobs.listOrphans()).toHaveLength(1);
    await create("committed", { attachment: hash });
    expect(
      (await ctx.storage.bulkActionJobs.getById("committed"))?.status,
    ).toBe("queued");
    expect(await ctx.storage.blobs.listOrphans()).toEqual([]);
  });

  it("walks later job pages when retaining candidates and lifting stale existing reports", async () => {
    ctx = await createTestContext();
    const held = await upload("later page held blob");
    const free = await upload("unheld candidate");
    await ctx.storage.runInTransaction(async () => {
      for (let index = 0; index < 201; index++) {
        await create(`job-${String(index).padStart(3, "0")}`, {
          body: "no digest",
        });
      }
      await create("job-last", { attachment: held });
    });
    const run = (
      ctx.storage as unknown as {
        __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
      }
    ).__sqliteRun;
    const reportedAt = now();
    await run("INSERT INTO blob_orphans(hash, reported_at) VALUES (?, ?)", [
      held,
      reportedAt,
    ]);
    await ctx.storage.blobs.retainOrphans([held, free], now());
    expect(
      (await ctx.storage.blobs.listOrphans()).map((row) => row.hash),
    ).toEqual([free]);
    const reporter = new BlobOrphanReporter(
      ctx.storage,
      ctx.blobs,
      0,
      () => new Date(Date.now() + 1_000),
    );
    expect(await reporter.runOnce()).toEqual({ reported: 0, purged: 1 });
    expect(await ctx.blobs.disk.has(free)).toBeNull();
    expect(await ctx.blobs.disk.has(held)).not.toBeNull();
    await run("INSERT INTO blob_orphans(hash, reported_at) VALUES (?, ?)", [
      held,
      reportedAt,
    ]);
    const later = new Date(Date.now() + 2_000).toISOString();
    expect(await ctx.storage.blobs.claimOrphanPurge(held, later, later)).toBe(
      false,
    );
    expect(await ctx.storage.blobs.listOrphans()).toEqual([]);
    expect(await ctx.blobs.disk.has(held)).not.toBeNull();
  });
});
