/**
 * A purge job reports what it actually did.
 *
 * Purge is the terminal step after a soft delete, so every id it is handed is
 * trashed. The runner's pre-fetch used `items.getMany`, which excludes trashed
 * rows because every read surface treats a soft-deleted item as gone — so the
 * map came back empty, every id fell into the "not found at purge time"
 * branch, and `bulkPurge` deleted them regardless.
 *
 * The result was the worst available shape: an operator saw `succeeded: 0,
 * errored: 4100` and concluded nothing had happened, on a job that had removed
 * four thousand one hundred rows. It also emptied the blob-hash collection, so
 * the hashes those items referenced were never reported for collection.
 *
 * Found by running a real cleanup against staging, which is the only way it
 * could have been found: the counts are self-consistent and nothing else reads
 * them.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  runBulkActionAsync,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

async function createTrashedNote(title: string): Promise<string> {
  const created = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: { type: "core.note", properties: { title, body: title } },
  });
  expect(created.status).toBe(201);
  const id = ((await created.json()) as { item: { id: string } }).item.id;
  const trashed = await request(ctx.app, "POST", `/items/${id}/transition`, {
    key: ctx.workingKey,
    body: { state: "trashed" },
  });
  expect(trashed.status).toBe(200);
  return id;
}

describe("bulk purge reporting", () => {
  it("REGRESSION: counts the rows it removed as succeeded, not as errors", async () => {
    const marker = `purge-report-${Math.random().toString(36).slice(2, 8)}`;
    const ids = [
      await createTrashedNote(`${marker}-1`),
      await createTrashedNote(`${marker}-2`),
    ];

    const outcome = await runBulkActionAsync(
      ctx,
      {
        action: "purge",
        confirm: "PURGE",
        filter: {
          state: "trashed",
          filter: `properties.title starts_with "${marker}"`,
        },
      },
      ctx.workingKey,
    );

    const job = outcome.job;
    expect(job).toBeDefined();
    expect(job!.matched).toBe(ids.length);
    expect(job!.succeeded).toBe(ids.length);
    expect(job!.errored).toBe(0);

    // And the rows really are gone, so the report and the outcome agree.
    for (const id of ids) {
      const res = await request(ctx.app, "GET", `/items/${id}`, {
        key: ctx.workingKey,
      });
      expect(res.status).toBe(404);
    }
  });
});
