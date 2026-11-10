import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  HOLD,
  idsWith,
  mark,
  rowsAndChunk,
  seed,
} from "../../utils/bulk-jobs.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * A fault that ends a bulk-action job's write partway through a chunk of its
 * matched items. The target's `fail:job-row=2` fault fails the first
 * statement of the second row written for a job, and the database ends the
 * chunk's transaction as it fails, as it may for a failing disk. The row is
 * partway through its chunk, and the rows before it are written and lost with
 * the transaction.
 *
 * **Independent of the chunk size.** The contract states none, so the
 * fixture learns it from an earlier job of the same kind: the audit entries of
 * a job's chunks (`events/audit-job-chunk`) give each chunk's offsets. It
 * seeds more rows until a job takes more than one chunk, so a chunk after the
 * failed one exists to be gone on to.
 */
let server: FreshServer;
let client: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("job-chunk-faults");
  client = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterEach(async () => {
  await server.clearFault();
});

afterAll(async () => {
  await server.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

/** Waits until the fault `name` has acted `times` times. */
async function firedAtLeast(name: string, times: number): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const fired =
      (await server.faults()).find((fault) => fault.name === name)?.fired ?? 0;
    if (fired >= times) return;
    if (Date.now() > deadline) {
      throw new Error(
        `${name} acted ${String(fired)} of ${String(times)} times`,
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

async function run(tag: string, marker: string) {
  const job = await client.pollBulkActionToTerminal(
    await mark(client, tag, marker),
  );
  return { job, errors: job.result?.errors ?? [] };
}

describe("a fault that ends a job's write partway through a chunk", () => {
  /** The items the chunk had reached when `fail:job-row=2` ended it. */
  const TRIED = 2;

  it("reports the chunk's unwritten items in the job's errors with the fault's own cause, and goes on to the next chunk", async () => {
    const { rows, chunk } = await rowsAndChunk(client);
    const tag = "chunk-fault";
    await seed(client, tag, rows);

    await server.setFault("fail:job-row=2");
    const { job, errors } = await run(tag, "written");
    const acted = (await server.faults()).find(
      (fault) => fault.name === "fail:job-row",
    );
    // The witness that the fault acted once, on an item.
    expect(acted?.fired).toBe(1);

    const written = await idsWith(client, "written");
    const everyone = await idsWith(client, tag);
    const unwritten = everyone.filter((id) => !written.includes(id));
    // The job's counters cover the chunk as far as it got (items/job-chunk-fault):
    // the item written before the failed one went with the chunk's
    // transaction, so both are counted as failed, and every item after them
    // was written (items/job-chunk-continues).
    expect(chunk).toBeGreaterThan(TRIED);
    expect(unwritten).toHaveLength(TRIED);
    expect(written).toHaveLength(rows - TRIED);
    expect(job.matched).toBe(rows);
    expect(job.errored).toBe(TRIED);
    expect(job.succeeded).toBe(rows - TRIED);
    // The errors the job lists are a sample, which the server may cut short,
    // so each one only has to name an item of the failed chunk, once.
    const failed = errors.map((entry) => entry.id);
    expect(failed.length).toBeGreaterThan(0);
    expect(new Set(failed).size).toBe(failed.length);
    for (const id of failed) expect(unwritten).toContain(id);

    // The cause is the fault's own, in the form every report takes: the
    // database failure and its code, and nothing of the statement or the values
    // it was bound to.
    for (const entry of errors) {
      expect(entry.code).toBe("internal_error");
      expect(entry.message).toContain("Database operation failed");
      expect(entry.message).toContain("SQLITE_IOERR");
      expect(entry.message).not.toContain("Failed query");
      expect(entry.message).not.toContain("disk I/O error");
    }
  });
});

describe("a fault that stops a job's write", () => {
  const FINISH = "fail:commit=items.bulk_action.finish";
  /** About twice the time the last case takes to end its job failed. */
  const OUTLASTS_TRIES_MS = 10_000;

  it("tries the write again from the job's checkpoint, unasked, and the job ends completed", async () => {
    const tag = "finish-once";
    await seed(client, tag, 3);

    await server.setFault(FINISH);
    const { job, errors } = await run(tag, `${tag}-written`);
    const acted = (await server.faults()).find(
      (fault) => fault.name === "fail:commit",
    );
    // The witness that the job's last step failed once before it ended.
    expect(acted?.fired).toBe(1);
    expect(job.status, job.error).toBe("completed");
    expect(errors).toEqual([]);
    expect(job).toMatchObject({ matched: 3, processed: 3, succeeded: 3 });
    expect(await idsWith(client, `${tag}-written`)).toHaveLength(3);
  });

  it("waits out its pause before each try, so jobs queued and canceled meanwhile spend none of its tries", async () => {
    const tag = "finish-stalled";
    await seed(client, tag, 3);

    await server.setFault(`${FINISH}@always`);
    const id = await mark(client, tag, `${tag}-written`);
    await firedAtLeast("fail:commit", 1);
    // Each queue and cancel wakes the worker. The pauses before the job's
    // tries add up to seconds, far longer than these requests take.
    for (let other = 0; other < 4; other += 1) {
      const queued = await mark(client, `${tag}-matches-none`, "unused");
      expect((await client.bulkActionCancel(queued)).ok).toBe(true);
    }
    await server.clearFault();

    const job = await client.pollBulkActionToTerminal(id);
    expect(job.status, job.error).toBe("completed");
    expect(await idsWith(client, `${tag}-written`)).toHaveLength(3);
  });

  it("reads its jobs again, unasked, once a read fault that outlasted its tries clears", async () => {
    const tag = "read-fault";
    await seed(client, tag, 3);

    // The job is queued while reads still answer, and the worker it wakes
    // meets the fault.
    await server.setFault(HOLD.selected);
    const queued = mark(client, tag, `${tag}-written`);
    await server.waitForHold(HOLD.selected);
    await server.setFault("refuse:read");
    await server.clearFault(HOLD.selected);
    const id = await queued;
    await firedAtLeast("refuse:read", 1);
    // Longer than the tries the last case gives a job before it ends failed.
    await new Promise((resolveWait) =>
      setTimeout(resolveWait, OUTLASTS_TRIES_MS),
    );
    await server.clearFault("refuse:read");

    const job = await client.pollBulkActionToTerminal(id);
    expect(job.status, job.error).toBe("completed");
    expect(await idsWith(client, `${tag}-written`)).toHaveLength(3);
  }, 120_000);

  it("ends the job failed, with an error and the result it gathered, when the write fails every time it is tried", async () => {
    const tag = "finish-always";
    await seed(client, tag, 3);

    await server.setFault(`${FINISH}@always`);
    const { job } = await run(tag, `${tag}-written`);
    const acted = (await server.faults()).find(
      (fault) => fault.name === "fail:commit",
    );
    expect(acted?.fired).toBeGreaterThan(1);
    expect(job.status).toBe("failed");
    expect(job.error).toEqual(expect.any(String));
    expect(job.result).toMatchObject({ matched: 3, succeeded: 3, errored: 0 });
    expect(await idsWith(client, `${tag}-written`)).toHaveLength(3);
  });
});
