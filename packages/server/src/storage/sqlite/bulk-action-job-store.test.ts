import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStorage } from "./index.js";
import type { BulkActionJobStore, Storage } from "../interface.js";
import { jobLease } from "../../bulk-actions/checkpoint.js";
import { BulkActionWorker } from "../../bulk-actions/worker.js";

const T0 = Date.now();
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

let tmpDir: string | undefined;
let storage: Storage | undefined;

async function open(): Promise<Storage> {
  tmpDir = mkdtempSync(join(tmpdir(), "marfa-bulk-jobs-"));
  storage = await createSqliteStorage(join(tmpDir, "marfa.db"));
  return storage;
}

async function inProgressJob(
  jobs: BulkActionJobStore,
  id: string,
  apiKeyId: string | null = null,
) {
  await jobs.create({
    id,
    api_key_id: apiKeyId,
    credential: apiKeyId ?? "fixture",
    action: "transition",
    input: JSON.stringify({ action: "transition", state: "archived" }),
    matched_ids: JSON.stringify(["a"]),
    matched_count: 1,
    created_at: at(0),
  });
  const claimed = await jobs.claimNext("worker", at(1));
  expect(claimed?.id).toBe(id);
  if (!claimed) throw new Error("fixture job did not claim");
  return jobLease(claimed);
}

afterEach(async () => {
  await storage?.close();
  storage = undefined;
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

describe("SqliteBulkActionJobStore terminal states", () => {
  it("leaves a canceled job canceled when the worker then completes it", async () => {
    const jobs = (await open()).bulkActionJobs;
    const lease = await inProgressJob(jobs, "baj_c");
    expect(await jobs.cancel("baj_c", at(2))).toBe(true);

    expect(await jobs.completeOwned(lease, 0, at(3))).toBe(false);

    const row = await jobs.getById("baj_c");
    expect(row?.status).toBe("canceled");
    expect(row?.finished_at).toBe(at(2));
    expect(row?.result).toBeNull();
  });

  it("leaves a canceled job canceled when the worker then fails it", async () => {
    const jobs = (await open()).bulkActionJobs;
    const lease = await inProgressJob(jobs, "baj_f");
    expect(await jobs.cancel("baj_f", at(2))).toBe(true);

    expect(await jobs.failOwned(lease, "boom", at(3))).toBe(false);

    const row = await jobs.getById("baj_f");
    expect(row?.status).toBe("canceled");
    expect(row?.error).toBeNull();
  });

  it("still completes and fails a job that is in progress", async () => {
    const jobs = (await open()).bulkActionJobs;
    const lease = await inProgressJob(jobs, "baj_ok");
    await jobs.checkpointChunk(
      lease,
      0,
      1,
      { succeeded: ["a"], errors: [] },
      at(2),
    );
    expect((await jobs.getById("baj_ok"))?.status).toBe("completed");

    const bad = await inProgressJob(jobs, "baj_bad");
    await jobs.failOwned(bad, "boom", at(2));
    const failed = await jobs.getById("baj_bad");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("boom");
  });

  it("finishes the last chunk atomically before a later cancellation", async () => {
    const s = await open();
    // The worker acts only for a credential that still stands.
    const key = await s.keys.create(
      {
        label: "worker",
        source: "worker",
        type_permissions: { "*": "write" },
        extension_permissions: {},
        edge_permissions: {},
        default_tier: "library",
        is_operator: false,
      },
      "worker-key-hash",
    );
    await inProgressJob(s.bulkActionJobs, "baj_w", key.id);
    // Back to queued so the worker claims it itself.
    await s.bulkActionJobs.recoverStale(at(60_000));

    const jobs = s.bulkActionJobs;
    const original = s.runInTransaction.bind(s);
    let canceled: boolean | undefined;
    s.runInTransaction = async (fn) => {
      const result = await original(fn);
      if ((await jobs.getById("baj_w"))?.status === "completed")
        canceled = await jobs.cancel("baj_w", at(2));
      return result;
    };

    const worker = new BulkActionWorker({
      storage: s,
      nowFn: () => new Date(T0 + 1),
    });
    expect(await worker.runOnce()).toBe(true);

    const row = await jobs.getById("baj_w");
    expect(canceled).toBe(false);
    expect(row?.status).toBe("completed");
    expect(row?.processed_count).toBe(1);
    expect(row?.result).not.toBeNull();
  });
});
