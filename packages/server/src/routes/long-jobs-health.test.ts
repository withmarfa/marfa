import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { Hono } from "hono";
import * as tar from "tar-stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BulkActionWorker } from "../bulk-actions/worker.js";
import { BlobOrphanReporter } from "../background-jobs/blob-orphans.js";
import { GrantInactivityRetirer } from "../storage/retention.js";
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
 * What is measured is the longest stretch of processor time the process spent
 * between two turns of the event loop. A job that holds the loop across its
 * pages stops every request, `/health` included, for as long as it runs, and
 * that wait grows with the instance until a container's health check gives up
 * on a server that is working.
 *
 * Processor time and not the wait on the clock, because the clock counts what
 * the server does not control: a machine running other work leaves this
 * process waiting for a core, and a wait of seconds then costs the process
 * milliseconds. A held loop spends its time computing, so its stretch is as
 * long in processor time as on the clock, however busy the machine is. The
 * clock is used once, in the witness's favor: `/health` has to be answered at
 * all while the job runs.
 *
 * The bound is two seconds of processor time. A job that hands the loop over
 * between units of work spends one unit between turns: at most about 65 ms
 * for the archive export, 310 ms for a restore batch and 460 ms for a
 * bulk-action chunk on a laptop, so the bound is more than four times the
 * largest. A bulk action that does not hand the loop over spent 7 seconds at
 * this size on the same laptop, and spends more the larger the instance.
 *
 * The archive export and the archive restore pass without their explicit
 * turns too, because the files and streams they write to hand the loop over
 * by themselves, so these two tests measure the whole job and do not witness
 * the turns; `export-archive-stream.test.ts` and `archive-restore-bounds.test.ts`
 * do. Every other job here fails its test when its turn is removed, and the
 * tighter bounds below are what make it fail. On the same laptop, in
 * milliseconds of processor time between two turns of the loop, with the
 * turns and without them: the NDJSON export 27 and 1,770; the blob orphan
 * sweep 31 and 800; version thinning over 6,100 items 280 and 5,900; the
 * retirement of 400 inactive grants 56 and 730.
 *
 * The enrichment sweep is not tested here: it reads one batch, at most
 * `MARFA_ENRICHMENT_BATCH_SIZE` candidates (8 by default), which does not
 * grow with the instance, and it took 15 ms with its turns and without them.
 * The retirement of grants is capped at 500 a run, which is still 700 ms
 * without its turns, so it is tested.
 */
const CPU_BOUND_MS = 2_000;

/**
 * Jobs that walk the instance in pages, or retire grants one by one, are held
 * to a tighter bound, set between the stretch of one unit and the stretch of
 * the whole run, so that the test fails when its job stops handing the loop
 * over. Against the two seconds above they would pass without it. A hosted
 * runner spends about four times the laptop's processor time on one unit,
 * so the bound leaves that much room. Version thinning keeps the two seconds:
 * its corpus is large enough that the whole run exceeds them.
 */
const PAGED_BOUND_MS = 500;

const ITEMS = 20_000;
const BULK_TARGETS = 10_000;
const THINNING_ITEMS = 6_000;
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

const cpuMs = () => {
  const used = process.cpuUsage();
  return (used.user + used.system) / 1000;
};

/** Holds the loop for `ms` of processor time, whatever else the machine does. */
function spin(ms: number) {
  const until = cpuMs() + ms;
  while (cpuMs() < until);
}

/**
 * The most processor time the process spent between two consecutive answers
 * of `/health` while `job` ran, with how many answers there were. The first
 * request commits the write probe before the job begins, so it is not the one
 * that meets a lock the job holds.
 */
async function longestStretch<T>(
  server: Hono<AppEnv>,
  job: () => Promise<T>,
): Promise<{ worstCpuMs: number; asked: number; result: T }> {
  await server.request("/health");
  const state = { running: true };
  let worstCpuMs = 0;
  let asked = 0;
  let last = cpuMs();
  const sampler = (async () => {
    while (state.running) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const res = await server.request("/health");
      const now = cpuMs();
      worstCpuMs = Math.max(worstCpuMs, now - last);
      last = now;
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
  worstCpuMs = Math.max(worstCpuMs, cpuMs() - last);
  return { worstCpuMs, asked, result };
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
    const { worstCpuMs } = await longestStretch(health, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      spin(2_600);
    });
    expect(worstCpuMs).toBeGreaterThan(CPU_BOUND_MS);
  });

  it("answers within the bound during an archive export of 20,000 items", async () => {
    const { worstCpuMs, asked, result } = await longestStretch(
      health,
      async () => {
        const res = await source.app.request("/export?format=archive", {
          headers: { Authorization: `Bearer ${source.workingKey}` },
        });
        expect(res.status).toBe(200);
        return Buffer.from(await res.arrayBuffer());
      },
    );
    archive = result;
    // The job did the work the bound is held against.
    expect(await manifestOf(archive)).toMatchObject({
      item_count: ITEMS + 20,
      edge_count: ITEMS * 0.75,
      blob_count: 20,
    });
    expect(worstCpuMs).toBeLessThan(CPU_BOUND_MS);
    expect(asked).toBeGreaterThan(0);
  }, 120_000);

  it("answers within the bound during an archive restore of that archive", async () => {
    const target = await createTestContext();
    try {
      initEventLog(target.storage.eventLog);
      const { worstCpuMs, asked, result } = await longestStretch(
        mountHealth(target),
        async () =>
          target.app.request("/restore", {
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
      expect(worstCpuMs).toBeLessThan(CPU_BOUND_MS);
      expect(asked).toBeGreaterThan(0);
    } finally {
      await target.cleanup();
    }
  }, 300_000);

  it("answers within the bound during an NDJSON export of 20,000 items", async () => {
    const { worstCpuMs, asked, result } = await longestStretch(
      health,
      async () => {
        const res = await source.app.request("/export", {
          headers: { Authorization: `Bearer ${source.workingKey}` },
        });
        expect(res.status).toBe(200);
        return (await res.text()).split("\n").filter(Boolean).length;
      },
    );
    expect(result).toBe(ITEMS + 20 + ITEMS * 0.75);
    expect(worstCpuMs).toBeLessThan(PAGED_BOUND_MS);
    expect(asked).toBeGreaterThan(0);
  }, 120_000);

  it("answers within the bound during a bulk action over 10,000 items", async () => {
    const { worstCpuMs, asked, result } = await longestStretch(
      health,
      async () => {
        const queued = await request(
          source.app,
          "POST",
          "/items/bulk-actions",
          {
            key: source.workingKey,
            body: {
              action: "update_tier",
              tier: "feed",
              filter: { source: "bulk-target" },
              max_items: BULK_TARGETS,
            },
          },
        );
        expect(queued.status, await queued.clone().text()).toBe(202);
        const job = (await queued.json()) as { id: string };
        const worker = new BulkActionWorker({ storage: source.storage });
        expect(await worker.runOnce()).toBe(true);
        return source.storage.bulkActionJobs.getById(job.id);
      },
    );
    expect(result).toMatchObject({
      status: "completed",
      processed_count: BULK_TARGETS,
    });
    expect(worstCpuMs).toBeLessThan(CPU_BOUND_MS);
    expect(asked).toBeGreaterThan(0);
  }, 120_000);

  it("answers within the bound during the blob orphan sweep", async () => {
    const reporter = new BlobOrphanReporter(
      source.storage,
      source.blobs,
      86_400_000,
    );
    const { worstCpuMs, asked, result } = await longestStretch(health, () =>
      reporter.runOnce(),
    );
    // Every blob is named by a row, so the sweep walked the corpus to learn
    // that and reported none.
    expect(result).toEqual({ reported: 0, purged: 0 });
    expect(worstCpuMs).toBeLessThan(PAGED_BOUND_MS);
    expect(asked).toBeGreaterThan(0);
  }, 120_000);

  it("answers within the bound during version thinning", async () => {
    // The thinner gives the loop a turn between pages of 100 items, so the
    // shared seed's hundred long histories are one page and prove nothing;
    // this many more are sixty.
    await sql(
      source,
      `WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v + 1 FROM n WHERE v < ?)
       INSERT INTO items (id, type, properties, created_at, updated_at, occurred_at, version)
       SELECT printf('01912350-0000-7000-8000-%012x', v), 'core.note',
         jsonb(json_object('body', 'thin ' || v)), ?, ?, ?, 5 FROM n`,
      [THINNING_ITEMS, at, at, at],
    );
    await sql(
      source,
      `WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v + 1 FROM n WHERE v < ?)
       INSERT INTO versions (id, item_id, version, properties, type, tier, occurred_at, source_id, created_at)
       SELECT printf('01912351-0000-7000-8000-%012x', v * 10 + j),
         printf('01912350-0000-7000-8000-%012x', v), j,
         json_object('body', 'thin ' || v || ' v' || j), 'core.note', 'feed', ?, 'thin-' || v || '-' || j, ?
       FROM n, (SELECT 1 AS j UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4)`,
      [THINNING_ITEMS, at, at],
    );
    const thinner = new VersionThinner(source.storage, {
      recentDays: 0,
      dailySnapshotDays: 0,
      weeklySnapshotDays: 0,
      maxVersions: 1,
    });
    const { worstCpuMs, asked, result } = await longestStretch(health, () =>
      thinner.runOnce(),
    );
    expect(result.items).toBe(100 + THINNING_ITEMS);
    expect(result.pruned).toBeGreaterThan(400 + THINNING_ITEMS * 3);
    expect(worstCpuMs).toBeLessThan(CPU_BOUND_MS);
    expect(asked).toBeGreaterThan(0);
  }, 120_000);

  it("answers within the bound during the retirement of inactive grants", async () => {
    // Grants with no client behind them, so the retirement is one update
    // each; 400 of them, forgotten for years.
    await sql(
      source,
      `WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v + 1 FROM n WHERE v < 400)
       INSERT INTO items (id, type, properties, created_at, updated_at, occurred_at)
       SELECT printf('01912349-0000-7000-8000-%012x', v), 'system.connection',
         jsonb(json_object('kind', 'app', 'status', 'active', 'granted_at', ?, 'last_used_at', ?)),
         ?, ?, ? FROM n`,
      [at, at, at, at, at],
    );
    const retirer = new GrantInactivityRetirer(source.storage, 365);
    const { worstCpuMs, asked, result } = await longestStretch(health, () =>
      retirer.runOnce(),
    );
    expect(result).toBe(400);
    expect(worstCpuMs).toBeLessThan(PAGED_BOUND_MS);
    expect(asked).toBeGreaterThan(0);
  }, 120_000);
});
