import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStorage } from "./index.js";
import type { BulkActionJobStore, Storage } from "../interface.js";
import { BulkActionWorker } from "../../bulk-actions/worker.js";

const T0 = Date.parse("2026-09-20T12:00:00.000Z");
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const counts = { processed_count: 1, succeeded_count: 1, errored_count: 0 };

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
    action: "transition",
    input: JSON.stringify({ action: "transition", state: "archived" }),
    matched_ids: JSON.stringify(["a"]),
    matched_count: 1,
    idempotency_key: null,
    created_at: at(0),
  });
  const claimed = await jobs.claimNext("worker", at(1));
  expect(claimed?.id).toBe(id);
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
    await inProgressJob(jobs, "baj_c");
    expect(await jobs.cancel("baj_c", at(2))).toBe(true);

    await jobs.complete("baj_c", "{}", counts, at(3));

    const row = await jobs.getById("baj_c");
    expect(row?.status).toBe("canceled");
    expect(row?.finished_at).toBe(at(2));
    expect(row?.result).toBeNull();
  });

  it("leaves a canceled job canceled when the worker then fails it", async () => {
    const jobs = (await open()).bulkActionJobs;
    await inProgressJob(jobs, "baj_f");
    expect(await jobs.cancel("baj_f", at(2))).toBe(true);

    await jobs.fail("baj_f", "boom", at(3));

    const row = await jobs.getById("baj_f");
    expect(row?.status).toBe("canceled");
    expect(row?.error).toBeNull();
  });

  it("still completes and fails a job that is in progress", async () => {
    const jobs = (await open()).bulkActionJobs;
    await inProgressJob(jobs, "baj_ok");
    await jobs.complete("baj_ok", "{}", counts, at(2));
    expect((await jobs.getById("baj_ok"))?.status).toBe("completed");

    await inProgressJob(jobs, "baj_bad");
    await jobs.fail("baj_bad", "boom", at(2));
    const failed = await jobs.getById("baj_bad");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("boom");
  });

  it("keeps a job canceled during its last chunk, with the rows already processed", async () => {
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

    // The cancel lands after the worker's check at the top of the only
    // chunk, which is the window the store has to close.
    const jobs = s.bulkActionJobs;
    const updateProgress = jobs.updateProgress.bind(jobs);
    jobs.updateProgress = async (id, progress, heartbeatAt) => {
      await updateProgress(id, progress, heartbeatAt);
      await jobs.cancel(id, at(2));
    };

    const worker = new BulkActionWorker({
      storage: s,
      nowFn: () => new Date(T0 + 1),
    });
    expect(await worker.runOnce()).toBe(true);

    const row = await jobs.getById("baj_w");
    expect(row?.status).toBe("canceled");
    expect(row?.processed_count).toBe(1);
    expect(row?.result).toBeNull();
  });
});
