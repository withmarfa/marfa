import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { AuditEntry, BulkActionJob } from "../../client/types.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";

/**
 * What the audit log keeps of work that runs as a job, and what it does not
 * keep of a housekeeping run.
 *
 * A server of its own, for two reasons. A job needs rows to act on, and a
 * few thousand of them left in the run's shared dataset would outlive the
 * file. And the claim that a request writes nothing is a claim about the
 * whole log, which on the shared server every sibling file is writing to.
 */
let server: FreshServer | undefined;
let client: MarfaClient;
let operator: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("audit-jobs");
  client = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  operator = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.managementKey,
  });
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(stopFreshServers, 2 * FRESH_SERVER_TIMEOUT_MS);

/** Every entry the log holds, newest first. */
async function wholeLog(
  filter: { action?: string } = {},
): Promise<AuditEntry[]> {
  const entries: AuditEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listAudit({ ...filter, limit: 200, cursor });
    expect(page.ok, JSON.stringify(page.error)).toBe(true);
    entries.push(...page.data.data);
    cursor = page.data.next_cursor ?? undefined;
  } while (cursor !== undefined);
  return entries;
}

async function seedTagged(count: number, tag: string): Promise<void> {
  const page = await client.bulkItems({
    atomic: false,
    items: Array.from({ length: count }, (_, i) => ({
      type: "core.note",
      properties: { title: `${tag}-${String(i)}`, body: "audit-jobs" },
      tags: [tag],
    })),
  });
  expect(page.ok, JSON.stringify(page.error)).toBe(true);
  expect(page.data.counts.created).toBe(count);
}

function queued(response: {
  status: number;
  data: unknown;
  error?: unknown;
}): BulkActionJob {
  expect(response.status, JSON.stringify(response.error)).toBe(202);
  return response.data as BulkActionJob;
}

describe("the audit log of a bulk action", () => {
  it("records the enqueue and each committed chunk of a job, and nothing for a dry run", async () => {
    const tag = "audit-job-chunks";
    await seedTagged(250, tag);
    const filter = { tags: [tag] };

    const dry = await client.bulkAction({
      action: "update_tags",
      add: ["dry"],
      filter,
      dry_run: true,
    });
    expect(dry.status).toBe(200);
    expect(await wholeLog({ action: "items.bulk_action" })).toEqual([]);

    const job = queued(
      await client.bulkAction({ action: "update_tags", add: ["run"], filter }),
    );
    const final = await client.pollBulkActionToTerminal(job.id);
    expect(final.status).toBe("completed");
    expect(final.succeeded).toBe(250);

    const enqueued = await wholeLog({ action: "items.bulk_action" });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.resource_type).toBe("items.bulk_action");
    expect(enqueued[0]!.key_id).toBe((await client.getCurrentKey()).data.id);
    expect(enqueued[0]!.details).toEqual({
      sub_action: "update_tags",
      matched: 250,
      job_id: job.id,
    });

    // One entry for each slice the job committed, which together walk the
    // matched rows from the first to the last with nothing between them
    // and nothing twice.
    const chunks = (
      await wholeLog({ action: "items.bulk_action.chunk" })
    ).filter((entry) => entry.resource_id === job.id);
    expect(chunks.length).toBeGreaterThan(0);
    const walked = chunks
      .map((entry) => entry.details)
      .sort((a, b) => (a.from_offset as number) - (b.from_offset as number));
    let next = 0;
    for (const chunk of walked) {
      expect(chunk.from_offset).toBe(next);
      expect(chunk.to_offset as number).toBeGreaterThan(next);
      expect(chunk.sub_action).toBe("update_tags");
      expect(chunk.errored_total).toBe(0);
      next = chunk.to_offset as number;
      expect(chunk.succeeded_total).toBe(next);
    }
    expect(next).toBe(250);
    for (const entry of chunks) {
      expect(entry.resource_type).toBe("items.bulk_action");
      expect(entry.key_id).toBe(enqueued[0]!.key_id);
    }
  });

  it("records the cancellation of a queued job, and none for a cancel that changes nothing", async () => {
    // The worker takes jobs in turn, so a job queued behind a long one is
    // still queued when it is cancelled: the first job is large enough that
    // it is running for far longer than the request that cancels the second
    // takes. The check after the cancel names the arrangement failing, so a
    // host fast enough to finish the first job first reads as that and not
    // as a missing audit entry.
    await seedTagged(5000, "audit-job-long");
    await seedTagged(3, "audit-job-short");
    const first = queued(
      await client.bulkAction({
        action: "update_tags",
        add: ["long"],
        filter: { tags: ["audit-job-long"] },
        max_items: 5000,
      }),
    );
    const second = queued(
      await client.bulkAction({
        action: "update_tags",
        add: ["short"],
        filter: { tags: ["audit-job-short"] },
      }),
    );
    expect(second.status).toBe("queued");

    const cancelled = await client.bulkActionCancel(second.id);
    expect(cancelled.status).toBe(200);
    const firstNow = (await client.bulkActionStatus(first.id)).data;
    expect(
      ["completed", "failed", "canceled"],
      "the first job finished before the second was cancelled, so the second was not held queued behind it",
    ).not.toContain(firstNow.status);
    expect(cancelled.data.status).toBe("canceled");

    const entries = (
      await wholeLog({ action: "items.bulk_action.cancel" })
    ).filter((entry) => entry.resource_id === second.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.resource_type).toBe("items.bulk_action");
    expect(entries[0]!.key_id).toBe((await client.getCurrentKey()).data.id);

    // A second cancel finds it already canceled and changes nothing.
    const again = await client.bulkActionCancel(second.id);
    expect(again.status).toBe(200);
    expect(again.data.status).toBe("canceled");
    const afterAgain = (
      await wholeLog({ action: "items.bulk_action.cancel" })
    ).filter((entry) => entry.resource_id === second.id);
    expect(afterAgain).toHaveLength(1);

    const settled = await client.pollBulkActionToTerminal(first.id, {
      timeoutMs: 120_000,
    });
    expect(settled.status).toBe("completed");
  }, 300_000);
});

describe("the audit log of a housekeeping run", () => {
  it("is not written to by POST /housekeeping/{name}/run, which runs a job the operator named", async () => {
    const jobs = await operator.listHousekeeping();
    expect(jobs.ok, JSON.stringify(jobs.error)).toBe(true);
    const names = ["trash-purge", "event-log-cleanup", "audit-cleanup"];
    for (const name of names) {
      expect(jobs.data.data.map((job) => job.name)).toContain(name);
    }

    // The witness: the log is read in whole, and a write between the reads
    // shows in it, so an identical log is a run that wrote nothing.
    const before = await wholeLog();
    expect(before.length).toBeGreaterThan(0);
    for (const name of names) {
      const run = await operator.runHousekeeping(name);
      expect(run.status, name).toBe(200);
      expect(run.data.outcome, name).toBe("ok");
    }
    const after = await wholeLog();
    expect(after.map((entry) => entry.id)).toEqual(
      before.map((entry) => entry.id),
    );

    const marked = await client.createItem({
      type: "core.note",
      properties: { title: "audit-jobs-witness", body: "x" },
    });
    expect(marked.ok).toBe(true);
    expect((await wholeLog()).length).toBe(before.length + 1);
  });
});
