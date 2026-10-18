import { expect } from "vitest";
import type { MarfaClient } from "../client/api.js";
import type {
  BulkActionInput,
  BulkActionJob,
  BulkItemInput,
} from "../client/types.js";
import type { FreshServer } from "./fresh-server.js";

/**
 * What the fixtures that hold or restart a bulk-action job share: rows seeded
 * under a tag, a job queued and read back, and the chunk size, which the
 * contract states nowhere and a fixture learns from the job's own audit
 * entries (`events/audit-job-chunk`).
 */

/** The points a fixture holds a bulk-action job at, as `hold:` faults. */
export const HOLD = {
  /** A request selecting the job's items, before its last check. */
  selected: "hold:bulk-job:selected",
  /** The worker has taken the job and not yet written a row. */
  claimed: "hold:bulk-job:claimed",
  /** A chunk's rows are written and its checkpoint is not. */
  inChunk: "hold:bulk-job:in-chunk",
  /** A chunk is committed and the job has more. */
  betweenChunks: "hold:bulk-job:between-chunks",
} as const;

/** Creates `rows` items of `type` carrying `tag`, 500 to a request. */
export async function seed(
  client: MarfaClient,
  tag: string,
  rows: number,
  options: {
    /** One type for every row, or the type of the row at an index. */
    type?: string | ((index: number) => string);
  } = {},
): Promise<void> {
  for (let done = 0; done < rows; done += 500) {
    const items: BulkItemInput[] = Array.from(
      { length: Math.min(500, rows - done) },
      (_, index) => {
        const at = done + index;
        const type =
          typeof options.type === "function"
            ? options.type(at)
            : (options.type ?? "core.note");
        return {
          type,
          properties:
            type === "core.bookmark"
              ? { url: `https://example.com/${tag}/${String(at)}` }
              : { body: `${tag}-${String(at)}` },
          tags: [tag],
        };
      },
    );
    const page = await client.bulkItems({ atomic: false, items });
    expect(page.ok, JSON.stringify(page.error)).toBe(true);
    expect(page.data.counts.created).toBe(items.length);
  }
}

/** The ids of every active item carrying `tag`. */
export async function idsWith(
  client: MarfaClient,
  tag: string,
): Promise<string[]> {
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

/** Queues a job and answers its id. */
export async function queue(
  client: MarfaClient,
  input: BulkActionInput,
): Promise<string> {
  const queued = await client.bulkAction(input);
  expect(queued.status, JSON.stringify(queued.error)).toBe(202);
  return (queued.data as BulkActionJob).id;
}

/** Queues `update_tags` adding `marker` to every item carrying `tag`. */
export function mark(
  client: MarfaClient,
  tag: string,
  marker: string,
): Promise<string> {
  return queue(client, {
    action: "update_tags",
    add: [marker],
    filter: { tags: [tag] },
  });
}

/** Reads a job as the client that may read it. */
export async function jobOf(
  client: MarfaClient,
  id: string,
): Promise<BulkActionJob> {
  const read = await client.bulkActionStatus(id);
  expect(read.status, JSON.stringify(read.error)).toBe(200);
  return read.data;
}

/** Waits until `ready` holds for the job, reading it every 100 ms. */
export async function jobWhen(
  client: MarfaClient,
  id: string,
  what: string,
  ready: (job: BulkActionJob) => boolean,
  timeoutMs = 30_000,
): Promise<BulkActionJob> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await jobOf(client, id);
    if (ready(job)) return job;
    if (Date.now() > deadline) {
      throw new Error(
        `${what}: the job was still ${job.status} after ${String(timeoutMs)}ms with ${String(job.processed)} processed`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Holds the worker at the start of a job nothing else claims, so a job
 * queued behind it stays queued. Releases it by clearing the fault.
 */
export async function holdWorker(
  server: FreshServer,
  client: MarfaClient,
  tag: string,
): Promise<string> {
  await server.setFault(HOLD.claimed);
  const id = await mark(client, tag, `${tag}-held`);
  await server.waitForHold(HOLD.claimed);
  expect((await jobOf(client, id)).status).toBe("in_progress");
  return id;
}

/** How many rows the job's first chunk took, from the audit entries of its chunks. */
export async function firstChunkRows(
  client: MarfaClient,
  jobId: string,
): Promise<number> {
  const entries = await client.listAudit({
    action: "items.bulk_action.chunk",
    limit: 200,
  });
  const first = entries.data.data.find(
    (entry) => entry.resource_id === jobId && entry.details.from_offset === 0,
  );
  return first?.details.to_offset as number;
}

/**
 * Rows enough that a job takes more than one chunk, and the size of its
 * first. A job of fewer rows than a chunk would have nothing to hold between.
 */
export async function rowsAndChunk(
  client: MarfaClient,
): Promise<{ rows: number; chunk: number }> {
  for (let rows = 250; rows <= 4000; rows *= 2) {
    const tag = `chunk-learn-${String(rows)}`;
    await seed(client, tag, rows);
    const queued = await mark(client, tag, `${tag}-done`);
    const job = await client.pollBulkActionToTerminal(queued);
    expect(job.status).toBe("completed");
    const chunk = await firstChunkRows(client, job.id);
    if (chunk < rows) return { rows, chunk };
  }
  throw new Error("a job took one chunk for every number of rows tried");
}
