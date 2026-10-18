import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { BulkActionJob } from "../../client/types.js";
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

async function seed(tag: string, rows: number): Promise<void> {
  for (let done = 0; done < rows; done += 500) {
    const page = await client.bulkItems({
      atomic: false,
      items: Array.from({ length: Math.min(500, rows - done) }, (_, index) => ({
        type: "core.note",
        properties: { body: `${tag}-${String(done + index)}` },
        tags: [tag],
      })),
    });
    expect(page.ok, JSON.stringify(page.error)).toBe(true);
  }
}

async function idsWith(tag: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listItems({ tags: [tag], limit: 200, cursor });
    expect(page.status).toBe(200);
    ids.push(...page.data.data.map((item) => item.id));
    cursor = page.data.next_cursor ?? undefined;
  } while (cursor !== undefined);
  return ids;
}

async function run(tag: string, marker: string) {
  const queued = await client.bulkAction({
    action: "update_tags",
    add: [marker],
    filter: { tags: [tag] },
  });
  expect(queued.status, JSON.stringify(queued.error)).toBe(202);
  const job = await client.pollBulkActionToTerminal(
    (queued.data as BulkActionJob).id,
  );
  return { job, errors: job.result?.errors ?? [] };
}

/** How many rows the job's first chunk took, from the audit entries of its chunks. */
async function firstChunkRows(jobId: string): Promise<number> {
  const entries = await client.listAudit({
    action: "items.bulk_action.chunk",
    limit: 200,
  });
  const first = entries.data.data.find(
    (entry) => entry.resource_id === jobId && entry.details.from_offset === 0,
  );
  return first?.details.to_offset as number;
}

/** Rows enough that a job takes more than one chunk, and the size of its first. */
async function rowsAndChunk(): Promise<{ rows: number; chunk: number }> {
  for (let rows = 250; rows <= 4000; rows *= 2) {
    const tag = `chunk-learn-${String(rows)}`;
    await seed(tag, rows);
    const { job } = await run(tag, `${tag}-done`);
    expect(job.status).toBe("completed");
    const chunk = await firstChunkRows(job.id);
    if (chunk < rows) return { rows, chunk };
  }
  throw new Error("a job took one chunk for every number of rows tried");
}

describe("a fault that ends a job's write partway through a chunk", () => {
  it("reports the chunk's unwritten items in the job's errors with the fault's own cause, and goes on to the next chunk", async () => {
    const { rows, chunk } = await rowsAndChunk();
    const tag = "chunk-fault";
    await seed(tag, rows);

    await server.setFault("fail:job-row=2");
    const { job, errors } = await run(tag, "written");
    const acted = (await server.faults()).find(
      (fault) => fault.name === "fail:job-row",
    );
    // The witness that the fault acted once, on a row.
    expect(acted?.fired).toBe(1);

    const written = await idsWith("written");
    const failed = errors.map((entry) => entry.id);
    // The chunk's rows are reported, none of them written, and nothing else is
    // (items/job-chunk-fault): the rows written before the failed one went
    // with the chunk's transaction.
    expect(failed).toHaveLength(chunk);
    expect(new Set(failed).size).toBe(failed.length);
    expect(failed.filter((id) => written.includes(id))).toEqual([]);
    // The chunks after it were written (items/job-chunk-continues).
    expect(written).toHaveLength(rows - chunk);
    expect(job.matched).toBe(rows);
    expect(job.succeeded).toBe(written.length);
    expect(job.errored).toBe(failed.length);

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
