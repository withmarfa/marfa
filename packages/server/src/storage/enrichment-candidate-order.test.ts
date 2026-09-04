/**
 * The extraction queue is ordered by how long a file has been waiting.
 *
 * Candidacy is decided by the enrichment-state anti-join, so an item already
 * extracted is reordered rather than re-offered and the ordering never
 * mattered to it. An item that has NOT been extracted is a different case:
 * ordering it by when it last changed means any write moves its place in the
 * queue, and once a tag write started moving the modification time, ordinary
 * tagging of a file waiting for extraction delayed it. Repeated tagging
 * delayed it without bound.
 *
 * The queue never fails or errors, so the symptom is a file that simply
 * never gets its contents extracted, with nothing anywhere reporting a
 * problem. That is what makes an ordering test worth having: nothing else
 * would notice.
 *
 * Runs against whichever dialect the suite is running, so both are held to
 * one contract rather than one of them being covered.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

const isPg = (): boolean => (process.env.DB_DIALECT ?? "sqlite") === "pg";

const SIGNATURE = JSON.stringify({ max_blob_bytes: 1, ocr: false });

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

/**
 * Force both timestamps, because every write path stamps `now` and the
 * question here is about the gap between them. Contrived past values are
 * the only way to make "did this item move" have a stable answer.
 */
async function forceTimes(
  itemId: string,
  createdAt: string,
  updatedAt: string,
): Promise<void> {
  if (isPg()) {
    const s = ctx.storage as unknown as {
      __pgClient: (q: string, params?: unknown[]) => Promise<unknown[]>;
    };
    await s.__pgClient(
      `UPDATE items SET created_at = $1, updated_at = $2 WHERE id = $3`,
      [createdAt, updatedAt, itemId],
    );
    return;
  }
  const s = ctx.storage as unknown as {
    __sqliteRun: (sql: string, params: unknown[]) => Promise<unknown>;
  };
  await s.__sqliteRun(
    "UPDATE items SET created_at = ?, updated_at = ? WHERE id = ?",
    [createdAt, updatedAt, itemId],
  );
}

async function createFileItem(name: string): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.adminKey,
    body: {
      type: "core.file",
      properties: {
        blob_ref: `sha256:${name.padEnd(64, "0")}`,
        mime_type: "text/plain",
        title: name,
      },
    },
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

async function queue(): Promise<string[]> {
  const rows = await ctx.storage.enrichment.listCandidates(1, 3, 50, SIGNATURE);
  return rows.map((r) => r.item_id);
}

describe("the extraction queue", () => {
  it("does not move an unextracted file when it is tagged", async () => {
    const first = await createFileItem("aaa");
    const middle = await createFileItem("bbb");
    const last = await createFileItem("ccc");

    // Three files that arrived in order and have never been touched since.
    await forceTimes(
      first,
      "2001-01-01T00:00:00.000Z",
      "2001-01-01T00:00:00.000Z",
    );
    await forceTimes(
      middle,
      "2001-01-02T00:00:00.000Z",
      "2001-01-02T00:00:00.000Z",
    );
    await forceTimes(
      last,
      "2001-01-03T00:00:00.000Z",
      "2001-01-03T00:00:00.000Z",
    );

    const before = await queue();
    expect(before).toEqual([first, middle, last]);

    // An ordinary tag write, through the door a person uses.
    const tagged = await request(ctx.app, "POST", `/items/${middle}/tags`, {
      key: ctx.adminKey,
      body: { tags: ["receipts"] },
    });
    expect(tagged.status, await tagged.clone().text()).toBe(200);

    // The write really did move the modification time — otherwise this test
    // would pass for a reason that has nothing to do with the ordering.
    const after = await ctx.storage.items.get(middle);
    expect(after?.updated_at).not.toBe("2001-01-02T00:00:00.000Z");

    // And the queue is unchanged: the file has been waiting exactly as long
    // as it was before somebody tagged it.
    expect(await queue()).toEqual([first, middle, last]);
  });

  it("still offers the file that has waited longest first", async () => {
    const older = await createFileItem("ddd");
    const newer = await createFileItem("eee");
    await forceTimes(
      older,
      "2002-01-01T00:00:00.000Z",
      "2002-06-01T00:00:00.000Z",
    );
    await forceTimes(
      newer,
      "2002-02-01T00:00:00.000Z",
      "2002-03-01T00:00:00.000Z",
    );

    const order = await queue();
    expect(order.indexOf(older)).toBeLessThan(order.indexOf(newer));
  });
});
