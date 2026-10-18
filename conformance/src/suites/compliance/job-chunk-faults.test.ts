import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { BulkActionJob } from "../../client/types.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * A fault that ends a bulk-action job's write of one chunk of its matched
 * items. The job writes a chunk in one transaction with the chunk's audit
 * entry, so a fault in the chunk's write rolls the whole chunk back, and the
 * fixture sets the target's `fail:audit` fault on the second chunk's entry
 * (`items.bulk_action.chunk@2`), which ends that chunk's write after its
 * items are written and before it commits.
 */
let server: FreshServer;
let client: MarfaClient;

/** Three chunks at the reference server's 100-row chunk size. */
const ROWS = 250;

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

async function seed(tag: string): Promise<void> {
  const page = await client.bulkItems({
    atomic: false,
    items: Array.from({ length: ROWS }, (_, index) => ({
      type: "core.note",
      properties: { body: `${tag}-${String(index)}` },
      tags: [tag],
    })),
  });
  expect(page.ok, JSON.stringify(page.error)).toBe(true);
  expect(page.data.counts.created).toBe(ROWS);
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

async function run(
  tag: string,
  marker: string,
): Promise<{
  job: BulkActionJob;
  errors: NonNullable<BulkActionJob["result"]>["errors"];
}> {
  const queued = await client.bulkAction({
    action: "update_tags",
    add: [marker],
    filter: { tags: [tag] },
  });
  expect(queued.status, JSON.stringify(queued.error)).toBe(202);
  const job = await client.pollBulkActionToTerminal(
    (queued.data as BulkActionJob).id,
  );
  return { job, errors: job.result?.errors };
}

describe("a fault that ends a job's write of one chunk", () => {
  it("reports the chunk's unwritten items in the job's errors with the fault's own cause, and goes on to the next chunk", async () => {
    const tag = "chunk-fault";
    await seed(tag);

    await server.setFault("fail:audit=items.bulk_action.chunk@2");
    const { job, errors } = await run(tag, "written");
    const acted = (await server.faults()).find(
      (fault) => fault.name === "fail:audit",
    );
    // The witness that the fault ended one chunk's write and no other.
    expect(acted?.fired).toBe(1);

    const written = await idsWith("written");
    const failed = (errors ?? []).map((entry) => entry.id);
    // The chunk's items are reported, none of them written, and nothing else is
    // reported (items/job-chunk-fault).
    expect(failed.length).toBeGreaterThan(0);
    expect(new Set(failed).size).toBe(failed.length);
    expect(failed.filter((id) => written.includes(id))).toEqual([]);
    // The chunks around it were written: every other matched item carries the
    // tag, the third chunk's included (items/job-chunk-continues).
    expect(written.length + failed.length).toBe(ROWS);
    expect(written.length).toBeGreaterThan(failed.length);
    expect(job.succeeded).toBe(written.length);
    expect(job.errored).toBe(failed.length);
    expect(job.matched).toBe(ROWS);

    // The cause is the fault's own, in the form every report takes: the
    // database failure and its code, and nothing of the statement or the values
    // it was bound to.
    for (const entry of errors ?? []) {
      expect(entry.code).toBe("internal_error");
      expect(entry.message).toContain("Database operation failed");
      expect(entry.message).toContain("SQLITE_IOERR");
      expect(entry.message).not.toContain("audit_log");
      expect(entry.message).not.toContain("disk I/O error");
    }

    // The rolled-back chunk left no audit entry, and the chunks that landed
    // each left theirs, which together walk the items that were written.
    const chunks = await client.listAudit({
      action: "items.bulk_action.chunk",
      limit: 200,
    });
    const mine = chunks.data.data.filter(
      (entry) => entry.resource_id === job.id,
    );
    expect(
      mine.reduce(
        (sum, entry) =>
          sum +
          ((entry.details.to_offset as number) -
            (entry.details.from_offset as number)),
        0,
      ),
    ).toBe(written.length);
  });

  it("writes every item when no fault is set, which is what the fault took from the chunk", async () => {
    const tag = "chunk-control";
    await seed(tag);
    const { job, errors } = await run(tag, "control-written");
    expect(errors ?? []).toEqual([]);
    expect(job.succeeded).toBe(ROWS);
    expect(await idsWith("control-written")).toHaveLength(ROWS);
  });
});
