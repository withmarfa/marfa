import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { SCHEMA_SQL } from "./connection.js";
import { createSqliteStorage } from "./index.js";
import {
  BulkActionLeaseLost,
  jobLease,
} from "../../bulk-actions/checkpoint.js";
import type { BulkActionJobLease } from "../interface.js";

let storage: Awaited<ReturnType<typeof createSqliteStorage>>;
let directory: string;
const AN_API_KEY_ROW =
  "INSERT INTO api_keys (id, key_hash, label, source, type_permissions, created_at) VALUES ('k1', 'h1', 'acme', 'integration:acme/thing', '{}', '2026-01-01T00:00:00.000Z')";
const clock = Date.now();
const at = (offset: number) => new Date(clock + offset).toISOString();
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "marfa-job-ownership-"));
  storage = await createSqliteStorage(join(directory, "test.db"));
});
afterEach(async () => {
  await storage.close();
  rmSync(directory, { recursive: true, force: true });
});
async function create(size = 3, action = "purge"): Promise<BulkActionJobLease> {
  const jobs = storage.bulkActionJobs;
  await jobs.create({
    id: "job",
    api_key_id: null,
    credential: "fixture",
    action,
    input: "{}",
    matched_ids: JSON.stringify(
      Array.from({ length: size }, (_, n) => String(n)),
    ),
    matched_count: size,
    created_at: at(0),
  });
  const row = await jobs.claimNext("first-owner", at(1));
  if (!row) throw new Error("fixture job was not claimed");
  return jobLease(row);
}

it("refuses every write from a reclaimed owner while preserving committed progress and history", async () => {
  const jobs = storage.bulkActionJobs;
  const old = await create();
  expect(await jobs.beginChunk(old, 0, at(2))).not.toBeNull();
  await jobs.checkpointChunk(
    old,
    0,
    1,
    {
      succeeded: ["0"],
      errors: [],
      carried: new Set(["child"]),
      blobHashes: new Set(["shared"]),
    },
    at(3),
  );
  expect(await jobs.recoverStale(at(4))).toBe(1);
  const replacement = await jobs.claimNext("replacement", at(5));
  if (!replacement) throw new Error("replacement did not claim");
  const lease = jobLease(replacement);
  expect(lease.generation).toBeGreaterThan(old.generation);
  expect(replacement.started_at).toBe(at(1));
  expect(replacement.next_offset).toBe(1);
  expect(await jobs.beginChunk(old, 1, at(6))).toBeNull();
  await expect(
    jobs.checkpointChunk(
      old,
      1,
      2,
      {
        succeeded: ["1"],
        errors: [],
        carried: new Set(["stale"]),
        blobHashes: new Set(["stale"]),
      },
      at(6),
    ),
  ).rejects.toBeInstanceOf(BulkActionLeaseLost);
  expect(await jobs.completeOwned(old, 1, at(6))).toBe(false);
  expect(await jobs.failOwned(old, "stale failure", at(6))).toBe(false);
  expect((await jobs.getById("job"))?.processed_count).toBe(1);
  expect(await jobs.carriedItems("job", ["child", "stale"])).toEqual(
    new Set(["child"]),
  );
  await expect(
    jobs.checkpointChunk(lease, 0, 1, { succeeded: ["0"], errors: [] }, at(6)),
  ).rejects.toBeInstanceOf(BulkActionLeaseLost);
  await jobs.checkpointChunk(
    lease,
    1,
    2,
    { succeeded: ["1"], errors: [], blobHashes: new Set(["shared", "new"]) },
    at(7),
  );
  const done = await jobs.checkpointChunk(
    lease,
    2,
    3,
    {
      succeeded: [],
      errors: [{ id: "2", code: "refused", message: "row refusal" }],
    },
    at(8),
  );
  expect(done).toMatchObject({
    status: "completed",
    next_offset: 3,
    processed_count: 3,
    succeeded_count: 2,
    errored_count: 1,
    blob_hashes_referenced_count: 2,
  });
  expect(JSON.parse(done.result!)).toMatchObject({
    ids: ["0", "1"],
    blob_hashes_referenced: 2,
    errors: [{ id: "2", code: "refused" }],
  });
  expect(await jobs.cancel("job", at(9))).toBe(false);
  expect(await jobs.failOwned(lease, "late failure", at(9))).toBe(false);
  expect(await jobs.recoverStale(at(10))).toBe(0);
});

it("cancellation invalidates the lease and terminal jobs cannot be resurrected", async () => {
  const jobs = storage.bulkActionJobs;
  const lease = await create();
  expect(await jobs.cancel("job", at(2))).toBe(true);
  expect(await jobs.beginChunk(lease, 0, at(3))).toBeNull();
  await expect(
    jobs.checkpointChunk(lease, 0, 1, { succeeded: ["0"], errors: [] }, at(3)),
  ).rejects.toBeInstanceOf(BulkActionLeaseLost);
  expect(await jobs.completeOwned(lease, 0, at(3))).toBe(false);
  expect(await jobs.failOwned(lease, "failure", at(3))).toBe(false);
  expect(await jobs.claimNext("new-owner", at(3))).toBeNull();
  expect(await jobs.recoverStale(at(4))).toBe(0);
  expect(await jobs.getById("job")).toMatchObject({
    status: "canceled",
    processed_count: 0,
    finished_at: at(2),
    result: null,
  });
});

it("a failed checkpoint rolls back counts, samples, carried rows and referenced hashes together", async () => {
  const jobs = storage.bulkActionJobs;
  const lease = await create();
  await storage.__sqliteRun(
    "CREATE TRIGGER refuses_checkpoint BEFORE UPDATE OF next_offset ON bulk_action_jobs BEGIN SELECT RAISE(ABORT, 'checkpoint witness'); END",
    [],
  );
  await expect(
    jobs.checkpointChunk(
      lease,
      0,
      1,
      {
        succeeded: ["0"],
        errors: [],
        carried: new Set(["child"]),
        blobHashes: new Set(["hash"]),
      },
      at(2),
    ),
  ).rejects.toThrow();
  expect(await jobs.getById("job")).toMatchObject({
    next_offset: 0,
    processed_count: 0,
    succeeded_count: 0,
    blob_hashes_referenced_count: 0,
    checkpoint_json: '{"ids":[],"errors":[]}',
  });
  expect(await jobs.carriedItems("job", ["child"])).toEqual(new Set());
  expect(
    await storage.__sqliteAll("SELECT * FROM bulk_action_job_purge_hashes"),
  ).toEqual([]);
});

it("keeps bounded samples, independent counters and batched carried membership", async () => {
  const jobs = storage.bulkActionJobs;
  const lease = await create(210, "update_tags");
  const ids = Array.from({ length: 105 }, (_, n) => String(n));
  const carried = new Set(
    Array.from({ length: 1200 }, (_, n) => `child-${String(n)}`),
  );
  await jobs.checkpointChunk(
    lease,
    0,
    105,
    { succeeded: ids, errors: [], carried },
    at(2),
  );
  const done = await jobs.checkpointChunk(
    lease,
    105,
    210,
    {
      succeeded: [],
      errors: ids.map((id) => ({ id, code: "refusal", message: "no" })),
    },
    at(3),
  );
  expect(done).toMatchObject({
    processed_count: 210,
    succeeded_count: 105,
    errored_count: 105,
  });
  const result = JSON.parse(done.result!) as {
    ids?: string[];
    errors: unknown[];
  };
  expect(result.ids).toBeUndefined();
  expect(result.errors).toHaveLength(100);
  expect(
    (JSON.parse(done.checkpoint_json) as { ids: string[] }).ids,
  ).toHaveLength(0);
  expect(await jobs.carriedItems("job", [...carried, "absent"])).toEqual(
    carried,
  );
  expect(await jobs.gcExpired(at(4))).toBe(1);
  expect(
    await storage.__sqliteAll("SELECT * FROM bulk_action_job_carried_items"),
  ).toEqual([]);
});

it("completes an owned empty job and fails from the durable summary only", async () => {
  const jobs = storage.bulkActionJobs;
  const empty = await create(0, "update_tags");
  expect(await jobs.completeOwned(empty, 0, at(2))).toBe(true);
  expect(JSON.parse((await jobs.getById("job"))!.result!)).toMatchObject({
    matched: 0,
    succeeded: 0,
    errored: 0,
  });
  await jobs.gcExpired(at(3));
  const lease = await create();
  await jobs.checkpointChunk(
    lease,
    0,
    1,
    { succeeded: ["0"], errors: [], blobHashes: new Set(["shared"]) },
    at(4),
  );
  expect(await jobs.failOwned(lease, "credential withdrawn", at(5))).toBe(true);
  const failed = await jobs.getById("job");
  expect(failed?.status).toBe("failed");
  expect(JSON.parse(failed!.result!)).toMatchObject({
    succeeded: 1,
    ids: ["0"],
    blob_hashes_referenced: 1,
  });
  expect(await jobs.completeOwned(lease, 1, at(6))).toBe(false);
});

it("reopens committed ownership, cursor, carry and hash ledgers without resetting them", async () => {
  const lease = await create();
  await storage.runInTransaction(() =>
    storage.bulkActionJobs.checkpointChunk(
      lease,
      0,
      1,
      {
        succeeded: ["0"],
        errors: [],
        carried: new Set(["child"]),
        blobHashes: new Set(["shared"]),
      },
      at(2),
    ),
  );
  await storage.close();
  storage = await createSqliteStorage(join(directory, "test.db"));
  expect(await storage.bulkActionJobs.getById("job")).toMatchObject({
    worker_id: lease.workerId,
    claim_generation: lease.generation,
    next_offset: 1,
    processed_count: 1,
    succeeded_count: 1,
    blob_hashes_referenced_count: 1,
  });
  expect(await storage.bulkActionJobs.carriedItems("job", ["child"])).toEqual(
    new Set(["child"]),
  );
  expect(await storage.bulkActionJobs.recoverStale(at(3))).toBe(1);
  const row = await storage.bulkActionJobs.claimNext("replacement", at(4));
  expect(row?.next_offset).toBe(1);
  const done = await storage.bulkActionJobs.checkpointChunk(
    jobLease(row!),
    1,
    3,
    {
      succeeded: ["1", "2"],
      errors: [],
      blobHashes: new Set(["shared", "new"]),
    },
    at(5),
  );
  expect(JSON.parse(done.result!)).toMatchObject({
    ids: ["0", "1", "2"],
    blob_hashes_referenced: 2,
  });
});

it.each(["checkpoint columns", "carried ledger", "hash ledger"] as const)(
  "refuses an existing database missing its durable %s",
  async (missing) => {
    const path = join(directory, "older.db");
    let sql = SCHEMA_SQL;
    if (missing === "checkpoint columns")
      sql = sql.replace(
        /\n\t`(?:claim_generation|next_offset|checkpoint_json|blob_hashes_referenced_count)`[^\n]+/g,
        "",
      );
    else {
      const table =
        missing === "carried ledger"
          ? "bulk_action_job_carried_items"
          : "bulk_action_job_purge_hashes";
      sql = sql.replace(
        new RegExp(
          "CREATE TABLE IF NOT EXISTS `" + table + "` \\([\\s\\S]*?\\);\\n",
          "g",
        ),
        "",
      );
    }
    expect(sql).not.toBe(SCHEMA_SQL);
    const raw = createClient({ url: `file:${path}` });
    await raw.executeMultiple(sql);
    // A file that lacks tables and holds no rows is completed, not refused.
    if (missing !== "checkpoint columns") await raw.execute(AN_API_KEY_ROW);
    raw.close();
    await expect(createSqliteStorage(path)).rejects.toThrow(
      missing === "checkpoint columns"
        ? /bulk_action_jobs table lacks claim_generation/
        : /file lacks the bulk_action_job_/,
    );
  },
);
