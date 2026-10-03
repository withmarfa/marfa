import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import {
  createTestContext,
  mintWorkingKey,
  request as appRequest,
  withSecondStore,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { BulkActionWorker } from "../bulk-actions/worker.js";
import type { BulkActionJob } from "../bulk-actions/types.js";
import { BlobOrphanReporter } from "../housekeeping/blob-orphans.js";
import { BlobReplicator } from "../housekeeping/blob-replicate.js";
import type { Item } from "@withmarfa/shared";
import { createApp } from "../app.js";
import { createSqliteStorage } from "../storage/sqlite/index.js";
import { ensureInstanceId } from "../storage/instance-id.js";
import { Housekeeping } from "../housekeeping/scheduler.js";
import { purgeBlob } from "../housekeeping/blob-delete.js";

let ctx: TestContext | undefined;
let writer: string;
let reader: string;
let time: number;
let network: ReturnType<typeof serve> | undefined;
let baseUrl: string | undefined;

async function request(
  ...args: Parameters<typeof appRequest>
): Promise<Response> {
  if (!baseUrl) return appRequest(...args);
  const [, method, path, options] = args;
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(options?.key ? { Authorization: `Bearer ${options.key}` } : {}),
      ...(options?.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
    },
    ...(options?.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });
}

async function setup(): Promise<TestContext> {
  ctx = await createTestContext();
  writer = await mintWorkingKey(ctx, {
    type_permissions: { "core.note": "write" },
  });
  reader = await mintWorkingKey(ctx, {
    type_permissions: { "core.note": "read" },
  });
  time = Date.now();
  await withSecondStore(ctx);
  const reporter = new BlobOrphanReporter(
    ctx.storage,
    ctx.blobs,
    0,
    () => new Date(time),
  );
  const replicator = new BlobReplicator(ctx.storage, ctx.blobs, {
    maxBlobs: 20,
    maxBytes: 1_000_000,
  });
  for (const [name, run] of [
    ["blob-orphans", () => reporter.runOnce()],
    ["blob-replicate", () => replicator.runOnce()],
  ] as const) {
    ctx.housekeeping.register({
      name,
      run,
      intervalMs: 3_600_000,
      firstRunDelayMs: 3_600_000,
    });
  }
  await ctx.housekeeping.start();
  await ctx.housekeeping.stop();
  return ctx;
}

afterEach(async () => {
  if (network)
    await new Promise<void>((resolve) => {
      network!.close(() => {
        resolve();
      });
    });
  network = undefined;
  baseUrl = undefined;
  if (!ctx) return;
  const path = ctx.tmpDir;
  await ctx.storage.close();
  await ctx.cleanup();
  expect(existsSync(path)).toBe(false);
  ctx = undefined;
});

async function json<T>(res: Response, status: number): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

async function upload(
  c: TestContext,
  bytes: string,
  key = writer,
): Promise<string> {
  const init = {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "text/plain" },
    body: new TextEncoder().encode(bytes),
  };
  return (
    await json<{ hash: string }>(
      await (baseUrl
        ? fetch(`${baseUrl}/blobs`, init)
        : c.app.request("/blobs", init)),
      201,
    )
  ).hash;
}

async function note(
  c: TestContext,
  tag: string,
  attachment?: string,
): Promise<Item> {
  return (
    await json<{ item: Item }>(
      await request(c.app, "POST", "/items", {
        key: writer,
        body: {
          type: "core.note",
          tags: [tag],
          properties: { body: tag, ...(attachment ? { attachment } : {}) },
        },
      }),
      201,
    )
  ).item;
}

async function queue(
  c: TestContext,
  tag: string,
  patch: Record<string, unknown>,
): Promise<BulkActionJob> {
  const job = await json<BulkActionJob>(
    await request(c.app, "POST", "/items/bulk-actions", {
      key: writer,
      body: {
        action: "update_properties",
        filter: { type: "core.note", tags: [tag] },
        patch,
      },
    }),
    202,
  );
  expect(job.status).toBe("queued");
  return job;
}

async function sweep(c: TestContext, name = "blob-orphans") {
  time += 1;
  const run = await json<{ outcome: string; result: Record<string, number> }>(
    await request(c.app, "POST", `/housekeeping/${name}/run`, {
      key: c.operatorKey,
    }),
    200,
  );
  expect(run.outcome).toBe("ok");
  return run.result;
}

async function held(
  c: TestContext,
  hash: string,
  copies: number,
): Promise<void> {
  expect(await c.storage.blobs.get(hash)).not.toBeNull();
  expect(await c.storage.blobs.listLocations(hash)).toHaveLength(copies);
  expect(c.blobs.stores).toHaveLength(copies);
  for (const store of c.blobs.stores) {
    const physical = await store.has(hash);
    expect(physical).not.toBeNull();
    expect(physical!.size_bytes).toBeGreaterThan(0);
  }
}

async function finish(
  c: TestContext,
  id: string,
  key = writer,
): Promise<BulkActionJob> {
  const worker = new BulkActionWorker({
    storage: c.storage,
    chunkSize: 1,
    pollIntervalMs: 1,
  });
  expect(await worker.runOnce()).toBe(true);
  expect(await worker.runOnce()).toBe(false);
  return json<BulkActionJob>(
    await request(c.app, "GET", `/items/bulk-actions/jobs/${id}`, { key }),
    200,
  );
}

async function getItem(c: TestContext, id: string): Promise<Item> {
  return (
    await json<{ item: Item }>(
      await request(c.app, "GET", `/items/${id}`, { key: reader }),
      200,
    )
  ).item;
}

describe("bulk property updates retain their blobs", () => {
  it("keeps both actual copies while queued, then reads the successful terminal item and bytes", async () => {
    const c = await setup();
    network = serve({ fetch: c.app.fetch, hostname: "127.0.0.1", port: 0 });
    await once(network, "listening");
    const address = network.address();
    if (!address || typeof address === "string")
      throw new Error("fixture server has no port");
    baseUrl = `http://127.0.0.1:${String(address.port)}`;
    const bytes = "queued upload awaiting a property update";
    const hash = await upload(c, bytes);
    const target = await note(c, "target");
    const before = await request(c.app, "GET", `/blobs/${hash}`, {
      key: c.operatorKey,
    });
    expect(before.status).toBe(200);
    expect(await before.text()).toBe(bytes);
    expect(await sweep(c, "blob-replicate")).toMatchObject({
      copied: 1,
      remaining: 0,
    });
    await held(c, hash, 2);
    const job = await queue(c, "target", { attachment: hash });
    expect(job.matched).toBe(1);
    expect(await sweep(c)).toEqual({ reported: 0, purged: 0 });
    expect(await sweep(c)).toEqual({ reported: 0, purged: 0 });
    expect((await c.storage.bulkActionJobs.getById(job.id))?.status).toBe(
      "queued",
    );
    await held(c, hash, 2);
    const done = await finish(c, job.id);
    expect(done).toMatchObject({
      status: "completed",
      result: { succeeded: 1, errored: 0 },
    });
    expect((await getItem(c, target.id)).properties.attachment).toBe(hash);
    expect(await sweep(c)).toEqual({ reported: 0, purged: 0 });
    const back = await request(c.app, "GET", `/blobs/${hash}`, { key: reader });
    expect(back.status).toBe(200);
    expect(await back.text()).toBe(bytes);
    await held(c, hash, 2);
  });

  it.each(["canceled", "failed", "completed"] as const)(
    "reports then purges inputs only after the job is %s",
    async (terminal) => {
      const c = await setup();
      const hash = await upload(c, `terminal ${terminal}`);
      const target = await note(c, "terminal target");
      const job = await queue(
        c,
        terminal === "completed" ? "no matches" : "terminal target",
        { attachment: hash },
      );
      expect(await sweep(c)).toEqual({ reported: 0, purged: 0 });
      expect(await c.blobs.disk.has(hash)).not.toBeNull();
      if (terminal === "canceled") {
        expect(
          (
            await json<BulkActionJob>(
              await request(
                c.app,
                "DELETE",
                `/items/bulk-actions/jobs/${job.id}`,
                { key: writer },
              ),
              200,
            )
          ).status,
        ).toBe(terminal);
      } else if (terminal === "failed") {
        const key = await json<{ id: string }>(
          await request(c.app, "GET", "/keys/current", { key: writer }),
          200,
        );
        expect(
          (
            await request(c.app, "DELETE", `/keys/${key.id}`, {
              key: c.workingKey,
            })
          ).status,
        ).toBe(200);
        expect((await finish(c, job.id, c.operatorKey)).status).toBe(terminal);
      } else {
        expect(await finish(c, job.id)).toMatchObject({
          status: terminal,
          result: { matched: 0, succeeded: 0 },
        });
      }
      expect((await getItem(c, target.id)).properties).not.toHaveProperty(
        "attachment",
      );
      expect(await sweep(c)).toEqual({ reported: 1, purged: 0 });
      expect(await c.blobs.disk.has(hash)).not.toBeNull();
      expect(await sweep(c)).toEqual({ reported: 0, purged: 1 });
      expect(await c.storage.blobs.get(hash)).toBeNull();
      expect(
        await Promise.all(c.blobs.stores.map((store) => store.has(hash))),
      ).toEqual([null, null]);
    },
  );

  it("keeps durable inputs across close, reopen and recovery of an abandoned owner", async () => {
    const c = await setup();
    const bytes = "durable input after ordinary reopening";
    const hash = await upload(c, bytes);
    const target = await note(c, "reopen target");
    const job = await queue(c, "reopen target", { attachment: hash });
    const claim = await c.storage.bulkActionJobs.claimNext(
      "prior owner",
      new Date(time).toISOString(),
    );
    expect(claim?.id).toBe(job.id);
    expect(await sweep(c)).toEqual({ reported: 0, purged: 0 });
    await c.storage.close();
    c.storage = await createSqliteStorage(join(c.tmpDir, "test.db"));
    c.housekeeping = new Housekeeping(c.storage.housekeeping, {
      pollIntervalMs: 1_000,
    });
    c.app = createApp(
      c.storage,
      c.blobs,
      c.housekeeping,
      c.config,
      await ensureInstanceId(c.storage.settings),
    );
    const reporter = new BlobOrphanReporter(
      c.storage,
      c.blobs,
      0,
      () => new Date(++time),
    );
    expect(await reporter.runOnce()).toEqual({ reported: 0, purged: 0 });
    expect((await c.storage.bulkActionJobs.getById(job.id))?.status).toBe(
      "in_progress",
    );
    expect(
      await c.storage.bulkActionJobs.recoverStale(
        new Date(time + 1).toISOString(),
      ),
    ).toBe(1);
    expect((await c.storage.bulkActionJobs.getById(job.id))?.status).toBe(
      "queued",
    );
    expect(await reporter.runOnce()).toEqual({ reported: 0, purged: 0 });
    expect(await finish(c, job.id)).toMatchObject({
      status: "completed",
      result: { succeeded: 1, errored: 0 },
    });
    expect((await getItem(c, target.id)).properties.attachment).toBe(hash);
    const res = await request(c.app, "GET", `/blobs/${hash}`, { key: reader });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(bytes);
  });

  it("keeps an enqueue committed during the item walk and lifts its earlier report", async () => {
    const c = await setup();
    const hash = await upload(c, "during walk");
    await note(c, "walk target");
    expect(await sweep(c)).toEqual({ reported: 1, purged: 0 });
    const list = c.storage.items.list.bind(c.storage.items);
    let enqueued = false;
    c.storage.items.list = async (...args) => {
      const page = await list(...args);
      if (!enqueued) {
        enqueued = true;
        await queue(c, "walk target", { attachment: hash });
      }
      return page;
    };
    expect(await sweep(c)).toEqual({ reported: 0, purged: 0 });
    expect(enqueued).toBe(true);
    expect(await c.blobs.disk.has(hash)).not.toBeNull();
  });

  it("keeps a late enqueue out of a stale report and starts the grace after cancellation", async () => {
    const c = await setup();
    const hash = await upload(c, "after walk before report");
    await note(c, "claim target");
    const retain = c.storage.blobs.retainOrphans.bind(c.storage.blobs);
    let enqueued = false;
    c.storage.blobs.retainOrphans = async (...args) => {
      if (!enqueued) {
        enqueued = true;
        await queue(c, "claim target", { attachment: hash });
      }
      await retain(...args);
    };
    expect(await sweep(c)).toEqual({ reported: 0, purged: 0 });
    expect(enqueued).toBe(true);
    expect(await c.storage.blobs.listOrphans()).toEqual([]);
    expect(await c.blobs.disk.has(hash)).not.toBeNull();
    const page = await c.storage.bulkActionJobs.scanPendingPropertyPatches(1);
    expect(page.patches).toEqual([{ attachment: hash }]);
    const jobs = await c.storage.bulkActionJobs.claimNext(
      "cancel owner",
      new Date(time).toISOString(),
    );
    expect(jobs).not.toBeNull();
    await json(
      await request(c.app, "DELETE", `/items/bulk-actions/jobs/${jobs!.id}`, {
        key: writer,
      }),
      200,
    );
    expect(await sweep(c)).toEqual({ reported: 1, purged: 0 });
    expect(await c.blobs.disk.has(hash)).not.toBeNull();
    expect(await sweep(c)).toEqual({ reported: 0, purged: 1 });
    expect(await c.blobs.disk.has(hash)).toBeNull();
  });

  it("lifts a report when enqueue commits after due hashes were selected but before their claim", async () => {
    const c = await setup();
    const hash = await upload(c, "before claim");
    await note(c, "due target");
    expect(await sweep(c)).toEqual({ reported: 1, purged: 0 });
    const due = c.storage.blobs.listOrphansToPurge.bind(c.storage.blobs);
    let witnessed = false;
    c.storage.blobs.listOrphansToPurge = async (...args) => {
      const hashes = await due(...args);
      expect(hashes).toEqual([hash]);
      await queue(c, "due target", { attachment: hash });
      witnessed = true;
      return hashes;
    };
    expect(await sweep(c)).toEqual({ reported: 0, purged: 0 });
    expect(witnessed).toBe(true);
    expect(await c.blobs.disk.has(hash)).not.toBeNull();
  });

  it("does not resurrect a purge already decided before enqueue and leaves its later reference non-lending", async () => {
    const c = await setup();
    const hash = await upload(c, "after purge decision");
    const target = await note(c, "late target");
    expect(await sweep(c)).toEqual({ reported: 1, purged: 0 });
    const claim = c.storage.blobs.claimOrphanPurge.bind(c.storage.blobs);
    let job: BulkActionJob | undefined;
    c.storage.blobs.claimOrphanPurge = async (...args) => {
      const decided = await claim(...args);
      expect(decided).toBe(true);
      expect(await c.storage.blobs.get(hash)).toBeNull();
      job = await queue(c, "late target", { attachment: hash });
      return decided;
    };
    expect(await sweep(c)).toEqual({ reported: 0, purged: 1 });
    expect(job).toBeDefined();
    expect(await c.blobs.disk.has(hash)).toBeNull();
    expect(await finish(c, job!.id)).toMatchObject({
      status: "completed",
      result: { succeeded: 1 },
    });
    expect((await getItem(c, target.id)).properties.attachment).toBe(hash);
    expect(await c.storage.blobs.lendingHashesOf(target.id)).toEqual([]);
    expect(
      (await request(c.app, "GET", `/blobs/${hash}`, { key: reader })).status,
    ).toBe(404);
    expect(
      (await request(c.app, "GET", `/blobs/${hash}`, { key: c.operatorKey }))
        .status,
    ).toBe(404);
  });

  it("retains but lends nothing through a pending patch from a key without byte proof", async () => {
    const c = await setup();
    const bytes = "retention grants no reach";
    const hash = await upload(c, bytes, c.workingKey);
    const target = await note(c, "non-lending target");
    const job = await queue(c, "non-lending target", { attachment: hash });
    expect(await sweep(c)).toEqual({ reported: 0, purged: 0 });
    expect(
      (await request(c.app, "GET", `/blobs/${hash}`, { key: writer })).status,
    ).toBe(404);
    expect(await finish(c, job.id)).toMatchObject({
      status: "completed",
      result: { succeeded: 1 },
    });
    expect((await getItem(c, target.id)).properties.attachment).toBe(hash);
    expect(await c.storage.blobs.lendingHashesOf(target.id)).toEqual([]);
    expect(
      (await request(c.app, "GET", `/blobs/${hash}`, { key: reader })).status,
    ).toBe(404);
    const res = await request(c.app, "GET", `/blobs/${hash}`, {
      key: c.operatorKey,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(bytes);
  });

  it.each([
    ["whole hash", (hash: string) => hash, true],
    ["bare hex", (hash: string) => hash.slice(7), true],
    ["embedded", (hash: string) => `image(${hash})`, true],
    ["encoded", (hash: string) => hash.replace(":", "%3A"), true],
    ["escaped", (hash: string) => hash.replace(":", "\\:"), true],
    ["65 hex", (hash: string) => `${hash.slice(7)}a`, false],
    ["63 hex", (hash: string) => hash.slice(7, -1), false],
    ["uppercase", (hash: string) => hash.toUpperCase(), false],
  ] as const)(
    "uses the canonical digest rule for %s in nested pending properties",
    async (_label, text, retained) => {
      const c = await setup();
      const hash = await upload(c, "canonical queued digest");
      await note(c, "canonical target");
      expect(await sweep(c)).toEqual({ reported: 1, purged: 0 });
      await queue(c, "canonical target", {
        nested: [{ attachment: text(hash) }],
      });
      expect((await c.storage.blobs.listOrphans()).length).toBe(
        retained ? 0 : 1,
      );
      expect(await sweep(c)).toEqual({ reported: 0, purged: retained ? 0 : 1 });
      expect((await c.blobs.disk.has(hash)) !== null).toBe(retained);
    },
  );

  it("ignores digests in a job's filter and actions that do not write properties", async () => {
    const c = await setup();
    const namedOnlyInFilter = await upload(
      c,
      "filter never writes this digest",
    );
    const namedOnlyInTags = await upload(c, "tags never write blob properties");
    await json(
      await request(c.app, "POST", "/items", {
        key: writer,
        body: {
          type: "core.note",
          tags: [namedOnlyInFilter],
          properties: { body: "filter target without a digest" },
        },
      }),
      201,
    );
    expect(await sweep(c)).toEqual({ reported: 2, purged: 0 });
    await queue(c, namedOnlyInFilter, { body: "no digest in patch" });
    await json(
      await request(c.app, "POST", "/items/bulk-actions", {
        key: writer,
        body: {
          action: "update_tags",
          filter: { type: "core.note", tags: [namedOnlyInFilter] },
          add: [namedOnlyInTags],
        },
      }),
      202,
    );
    expect(await c.storage.blobs.listOrphans()).toHaveLength(2);
    expect(await sweep(c)).toEqual({ reported: 0, purged: 2 });
    expect(await c.blobs.disk.has(namedOnlyInFilter)).toBeNull();
    expect(await c.blobs.disk.has(namedOnlyInTags)).toBeNull();
  });

  it("keeps an unknown digest accepted without a registry row or lending rights", async () => {
    const c = await setup();
    const hash = `sha256:${"e".repeat(64)}`;
    const target = await note(c, "unknown target");
    const job = await queue(c, "unknown target", { attachment: hash });
    expect(await sweep(c)).toEqual({ reported: 0, purged: 0 });
    expect(await c.storage.blobs.get(hash)).toBeNull();
    expect(await finish(c, job.id)).toMatchObject({
      status: "completed",
      result: { succeeded: 1 },
    });
    expect((await getItem(c, target.id)).properties.attachment).toBe(hash);
    expect(await c.storage.blobs.lendingHashesOf(target.id)).toEqual([]);
    expect(
      (await request(c.app, "GET", `/blobs/${hash}`, { key: reader })).status,
    ).toBe(404);
  });

  it("rechecks current pending patches in the purge transaction even for a stale recorded report", async () => {
    const c = await setup();
    const hash = await upload(c, "final claim witness");
    await note(c, "final claim target");
    const job = await queue(c, "final claim target", { attachment: hash });
    const run = (
      c.storage as unknown as {
        __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
      }
    ).__sqliteRun;
    const before = new Date(++time).toISOString();
    await run("INSERT INTO blob_orphans(hash, reported_at) VALUES (?, ?)", [
      hash,
      new Date(time - 10).toISOString(),
    ]);
    expect(
      await purgeBlob(c.storage, c.blobs, hash, {
        before,
        runStartedAt: before,
      }),
    ).toBe(false);
    expect(await c.storage.blobs.listOrphans()).toEqual([]);
    expect(await c.blobs.disk.has(hash)).not.toBeNull();
    await c.storage.bulkActionJobs.cancel(job.id, before);
    expect(await sweep(c)).toEqual({ reported: 1, purged: 0 });
    expect(await sweep(c)).toEqual({ reported: 0, purged: 1 });
    expect(await c.blobs.disk.has(hash)).toBeNull();
  });
});
