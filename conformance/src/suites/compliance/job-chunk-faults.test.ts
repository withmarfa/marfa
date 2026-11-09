import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { idsWith, mark, rowsAndChunk, seed } from "../../utils/bulk-jobs.js";
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

async function run(tag: string, marker: string) {
  const job = await client.pollBulkActionToTerminal(
    await mark(client, tag, marker),
  );
  return { job, errors: job.result?.errors ?? [] };
}

describe("a fault that ends a job's write partway through a chunk", () => {
  it("reports the chunk's unwritten items in the job's errors with the fault's own cause, and goes on to the next chunk", async () => {
    const { rows, chunk } = await rowsAndChunk(client);
    const tag = "chunk-fault";
    await seed(client, tag, rows);

    await server.setFault("fail:job-row=2");
    const { job, errors } = await run(tag, "written");
    const acted = (await server.faults()).find(
      (fault) => fault.name === "fail:job-row",
    );
    // The witness that the fault acted once, on a row.
    expect(acted?.fired).toBe(1);

    const written = await idsWith(client, "written");
    const everyone = await idsWith(client, tag);
    const unwritten = everyone.filter((id) => !written.includes(id));
    // The job's counters cover the whole chunk (items/job-chunk-fault): the
    // rows written before the failed one went with the chunk's transaction,
    // so every row of the chunk is counted as failed, and the chunks after it
    // were written (items/job-chunk-continues).
    expect(unwritten).toHaveLength(chunk);
    expect(written).toHaveLength(rows - chunk);
    expect(job.matched).toBe(rows);
    expect(job.errored).toBe(chunk);
    expect(job.succeeded).toBe(rows - chunk);
    // The errors the job lists are a sample, which the server may cut short,
    // so each one only has to name a row of the failed chunk, once.
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
