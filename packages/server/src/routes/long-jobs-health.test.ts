import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { Hono } from "hono";
import * as tar from "tar-stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BulkActionWorker } from "../bulk-actions/worker.js";
import { BlobOrphanReporter } from "../housekeeping/blob-orphans.js";
import { VersionThinner } from "../storage/version-thinner.js";
import { initEventLog, __resetEventLogForTests } from "../pubsub.js";
import type { AppEnv } from "../middleware/auth.js";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { healthRoutes } from "./health.js";
import { storageProbes } from "./health-probes.js";

/**
 * `GET /health` while the server does each of its long jobs, over an
 * instance of 20,000 items with history, edges and blobs.
 *
 * What is measured is how long a request waits for the event loop. A job
 * that holds the loop across its pages stops every request, `/health`
 * included, for as long as it runs, and that wait grows with the instance
 * until a container's health check gives up on a server that is working.
 *
 * The bound is two seconds. A healthy answer takes a few milliseconds, and a
 * job that hands the loop over between units of work delays a request by one
 * unit: 25 ms for the archive export, 160 ms for a restore batch and 300 ms
 * for a bulk-action chunk on a laptop. A shared runner is several times
 * slower, and two seconds still holds the slowest of them. A job that does
 * not hand the loop over held it for 3.4 seconds at this size on the same
 * laptop, and longer the larger the instance. The bound is also well inside
 * the five seconds a container's health check waits.
 */
const HEALTH_BOUND_MS = 2_000;

const ITEMS = 20_000;
const BULK_TARGETS = 10_000;
const at = "2024-01-02T03:04:05.678Z";

let source: TestContext;
let health: Hono<AppEnv>;
let archive: Buffer;

async function sql(
  target: TestContext,
  statement: string,
  params: unknown[] = [],
) {
  const storage = target.storage as typeof target.storage & {
    __sqliteRun: (statement: string, params: unknown[]) => Promise<unknown>;
  };
  return storage.__sqliteRun(statement, params);
}

/**
 * The route as the app mounts it, over the same storage. Its write probe
 * answers from the first commit for the whole run: that probe waits on a
 * held write lock, as a restore holds it (`instance.md` 12), and that wait is
 * a held lock reported as `degraded`, not a stalled loop.
 */
function mountHealth(target: TestContext): Hono<AppEnv> {
  return new Hono<AppEnv>().route(
    "/health",
    healthRoutes(
      target.storage,
      target.blobs,
      target.config,
      storageProbes(
        target.storage,
        {
          sqlitePath: `${target.tmpDir}/test.db`,
          blobPath: target.config.blobPath,
        },
        () => 0,
      ),
    ),
  );
}

async function seed(target: TestContext) {
  const body = "x".repeat(600);
  await sql(
    target,
    `WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v + 1 FROM n WHERE v < ?)
     INSERT INTO items (id, type, properties, created_at, updated_at, occurred_at, source, source_id, version)
     SELECT printf('01912345-0000-7000-8000-%012x', v), 'core.note',
       jsonb(json_object('body', 'note ' || v || ' ' || ?)),
       strftime('%Y-%m-%dT%H:%M:%fZ', '2024-01-01', '+' || v || ' seconds'),
       strftime('%Y-%m-%dT%H:%M:%fZ', '2024-01-01', '+' || v || ' seconds'),
       strftime('%Y-%m-%dT%H:%M:%fZ', '2024-01-01', '+' || v || ' seconds'),
       CASE WHEN v <= ? THEN 'bulk-target' END, CASE WHEN v <= ? THEN 'n' || v END,
       CASE WHEN v % 5 < 2 THEN 2 ELSE 1 END FROM n`,
    [ITEMS, body, BULK_TARGETS, BULK_TARGETS],
  );
  await sql(
    target,
    `WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v + 1 FROM n WHERE v < ?)
     INSERT INTO versions (id, item_id, version, properties, type, tier, occurred_at, source_id, created_at)
     SELECT printf('01912346-0000-7000-8000-%012x', v), printf('01912345-0000-7000-8000-%012x', v), 1,
       json_object('body', 'past ' || v || ' ' || ?), 'core.note', 'feed', ?, 'past-' || v, ? FROM n
     WHERE v % 5 < 2`,
    [ITEMS, body, at, at],
  );
  // Long histories on a hundred items, which the version thinner prunes.
  await sql(
    target,
    `WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v + 1 FROM n WHERE v < 500)
     INSERT INTO versions (id, item_id, version, properties, type, tier, occurred_at, source_id, created_at)
     SELECT printf('01912348-0000-7000-8000-%012x', v), printf('01912345-0000-7000-8000-%012x', (v - 1) / 5 + 1), 10 + (v - 1) % 5,
       json_object('body', 'long ' || v), 'core.note', 'feed', ?, 'long-' || v, ? FROM n`,
    [at, at],
  );
  await sql(
    target,
    `WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v + 1 FROM n WHERE v < ?)
     INSERT INTO edges (id, source_id, target_id, edge_type, created_at, updated_at)
     SELECT printf('01912347-0000-7000-8000-%012x', v),
       printf('01912345-0000-7000-8000-%012x', v),
       printf('01912345-0000-7000-8000-%012x', (v * 7) % ? + 1),
       'references', ?, ? FROM n`,
    [ITEMS * 0.75, ITEMS, at, at],
  );
  for (let i = 0; i < 20; i++) {
    const bytes = randomBytes(2_000);
    const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const uploaded = await target.app.request("/blobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${target.workingKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: bytes,
    });
    expect(uploaded.status).toBe(201);
    const file = await request(target.app, "POST", "/items", {
      key: target.workingKey,
      body: {
        type: "core.file",
        properties: { blob_ref: hash, mime_type: "text/plain" },
      },
    });
    expect(file.status).toBe(201);
  }
}

/** How long a request due every few milliseconds waited for the loop and for
 *  its answer, at worst, while `job` ran. A request is counted from when it
 *  fell due, so a loop held across the moment it was due counts in full. */
async function worstWait<T>(
  server: Hono<AppEnv>,
  job: () => Promise<T>,
): Promise<{ worstMs: number; asked: number; result: T }> {
  const state = { running: true };
  // The write probe is committed before the job begins, so the first request
  // is not the one that meets a lock the job holds.
  await server.request("/health");
  let worstMs = 0;
  let asked = 0;
  const sampler = (async () => {
    while (state.running) {
      const due = performance.now() + 5;
      await new Promise((resolve) => setTimeout(resolve, 5));
      const res = await server.request("/health");
      worstMs = Math.max(worstMs, performance.now() - due);
      asked++;
      expect(res.status).toBe(200);
      await res.arrayBuffer();
    }
  })();
  let result: T;
  try {
    result = await job();
  } finally {
    state.running = false;
  }
  // The request in flight when the job ended is the one a held loop delays
  // most, so it is counted before the worst is read.
  await sampler;
  return { worstMs, asked, result };
}

async function manifestOf(bytes: Buffer): Promise<unknown> {
  const extract = tar.extract();
  return new Promise((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => {
        if (header.name === "manifest.json") chunks.push(chunk);
      });
      stream.on("end", () => {
        if (header.name === "manifest.json") {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        }
        next();
      });
      stream.on("error", reject);
    });
    extract.on("error", reject);
    Readable.from(bytes).pipe(createGunzip()).pipe(extract);
  });
}

beforeAll(async () => {
  source = await createTestContext();
  initEventLog(source.storage.eventLog);
  await seed(source);
  health = mountHealth(source);
}, 120_000);

afterAll(async () => {
  __resetEventLogForTests();
  await source.cleanup();
});

describe("GET /health while a long job runs", () => {
  it("sees a loop held across the job, which is what the others are held against", async () => {
    const { worstMs } = await worstWait(health, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_400);
    });
    expect(worstMs).toBeGreaterThan(HEALTH_BOUND_MS);
  });

  it("answers within the bound during an archive export of 20,000 items", async () => {
    const { worstMs, asked, result } = await worstWait(health, async () => {
      const res = await source.app.request("/export?format=archive", {
        headers: { Authorization: `Bearer ${source.workingKey}` },
      });
      expect(res.status).toBe(200);
      return Buffer.from(await res.arrayBuffer());
    });
    archive = result;
    // The job did the work the bound is held against.
    expect(await manifestOf(archive)).toMatchObject({
      item_count: ITEMS + 20,
      edge_count: ITEMS * 0.75,
      blob_count: 20,
    });
    expect(worstMs).toBeLessThan(HEALTH_BOUND_MS);
    expect(asked).toBeGreaterThan(20);
  }, 120_000);

  it("answers within the bound during an archive restore of that archive", async () => {
    const target = await createTestContext();
    try {
      initEventLog(target.storage.eventLog);
      const { worstMs, asked, result } = await worstWait(
        mountHealth(target),
        async () =>
          target.app.request("/admin/restore-archive", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${target.operatorKey}`,
              "Content-Type": "application/gzip",
            },
            body: archive,
          }),
      );
      expect(result.status, await result.clone().text()).toBe(200);
      expect(await result.json()).toMatchObject({
        imported: ITEMS + 20,
        edges_imported: ITEMS * 0.75,
        blobs_imported: 20,
      });
      expect(worstMs).toBeLessThan(HEALTH_BOUND_MS);
      expect(asked).toBeGreaterThan(20);
    } finally {
      await target.cleanup();
    }
  }, 300_000);

  it("answers within the bound during an NDJSON export of 20,000 items", async () => {
    const { worstMs, asked, result } = await worstWait(health, async () => {
      const res = await source.app.request("/export", {
        headers: { Authorization: `Bearer ${source.workingKey}` },
      });
      expect(res.status).toBe(200);
      return (await res.text()).split("\n").filter(Boolean).length;
    });
    expect(result).toBe(ITEMS + 20 + ITEMS * 0.75);
    expect(worstMs).toBeLessThan(HEALTH_BOUND_MS);
    expect(asked).toBeGreaterThan(20);
  }, 120_000);

  it("answers within the bound during a bulk action over 10,000 items", async () => {
    const { worstMs, asked, result } = await worstWait(health, async () => {
      const queued = await request(source.app, "POST", "/items/bulk-actions", {
        key: source.workingKey,
        body: {
          action: "update_tier",
          tier: "feed",
          filter: { source: "bulk-target" },
          max_items: BULK_TARGETS,
        },
      });
      expect(queued.status, await queued.clone().text()).toBe(202);
      const job = (await queued.json()) as { id: string };
      const worker = new BulkActionWorker({ storage: source.storage });
      expect(await worker.runOnce()).toBe(true);
      return source.storage.bulkActionJobs.getById(job.id);
    });
    expect(result).toMatchObject({
      status: "completed",
      processed_count: BULK_TARGETS,
    });
    expect(worstMs).toBeLessThan(HEALTH_BOUND_MS);
    expect(asked).toBeGreaterThan(20);
  }, 120_000);

  it("answers within the bound during the blob orphan sweep", async () => {
    const reporter = new BlobOrphanReporter(
      source.storage,
      source.blobs,
      86_400_000,
    );
    const { worstMs, asked, result } = await worstWait(health, () =>
      reporter.runOnce(),
    );
    // Every blob is named by a row, so the sweep walked the corpus to learn
    // that and reported none.
    expect(result).toEqual({ reported: 0, purged: 0 });
    expect(worstMs).toBeLessThan(HEALTH_BOUND_MS);
    expect(asked).toBeGreaterThan(5);
  }, 120_000);

  it("answers within the bound during version thinning", async () => {
    const thinner = new VersionThinner(source.storage, {
      recentDays: 0,
      dailySnapshotDays: 0,
      weeklySnapshotDays: 0,
      maxVersions: 1,
    });
    const { worstMs, asked, result } = await worstWait(health, () =>
      thinner.runOnce(),
    );
    expect(result.items).toBe(100);
    expect(result.pruned).toBeGreaterThan(400);
    expect(worstMs).toBeLessThan(HEALTH_BOUND_MS);
    expect(asked).toBeGreaterThan(5);
  }, 120_000);
});
