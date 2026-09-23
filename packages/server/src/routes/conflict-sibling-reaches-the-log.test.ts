/**
 * A conflicted copy reaches the event log, the search index, and nothing else.
 *
 * The sibling is written inside the update's transaction rather than through
 * `POST /items`, so it does not get a create's announcement or indexing for
 * free — it gets them only because this path does them deliberately.
 *
 * Both matter for the same reason. A write with no row in `event_log` is one a
 * client can never learn about (see `bulk-reaches-the-log.test.ts`), so a
 * second device would never receive the conflicted copy: not on the next poll,
 * not on reconnect, not ever. That is the loss this feature exists to prevent,
 * arriving through the feature's own mechanism. And a row missing from the
 * search index is one the ordinary way of going looking for a conflicted copy
 * does not find.
 *
 * Asserted on the log rather than the emitter, deliberately: the emitter is
 * what a live subscriber happens to be attached to, the log is what a client
 * that was offline reads.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request, type TestContext } from "../test-utils.js";
import { initEventLog, __resetEventLogForTests } from "../pubsub.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
  // `createTestContext` does not wire the log — the server's bootstrap does.
  // Without this, `publish` appends nothing and every assertion below reads
  // an empty log whatever the routes did.
  initEventLog(ctx.storage.eventLog);
});

afterAll(async () => {
  __resetEventLogForTests();
  await ctx.cleanup();
});

async function logCursor(): Promise<bigint> {
  const rows = await ctx.storage.eventLog.getAfter(0n, 100_000);
  return rows.reduce((max, r) => (r.id > max ? r.id : max), 0n);
}

interface LogRow {
  id: bigint;
  event_type: string;
  item_id: string;
  payload: string;
}

async function logSince(cursor: bigint): Promise<LogRow[]> {
  return (await ctx.storage.eventLog.getAfter(cursor, 100_000)) as LogRow[];
}

/** A note whose next stale write at `base` collides on `body`. */
async function collidingNote(): Promise<{ id: string; base: number }> {
  const created = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: {
      type: "core.note",
      properties: { title: "shared title", body: "shared body" },
    },
  });
  const { item } = (await created.json()) as {
    item: { id: string; version: number };
  };
  const winner = await request(ctx.app, "PATCH", `/items/${item.id}`, {
    key: ctx.workingKey,
    body: {
      properties: { title: "winner title", body: "winner body" },
      version: item.version,
    },
  });
  expect(winner.status).toBe(200);
  return { id: item.id, base: item.version };
}

describe("a conflicted copy is observable to a client that was not the writer", () => {
  it("appends a created row for the sibling as well as the update", async () => {
    const { id, base } = await collidingNote();
    const cursor = await logCursor();

    const res = await request(ctx.app, "PATCH", `/items/${id}?conflict=auto`, {
      key: ctx.workingKey,
      body: { properties: { body: "the losing edit" }, version: base },
    });
    expect(res.status).toBe(200);
    const siblingId = (
      (await res.json()) as {
        conflict_resolution?: { conflicted_copy_id?: string };
      }
    ).conflict_resolution?.conflicted_copy_id;
    expect(siblingId).toBeDefined();

    const rows = await logSince(cursor);
    const forSibling = rows.filter((r) => r.item_id === siblingId);
    // Exactly the shape `POST /items` would have produced, because a client
    // replaying the log has no way to learn about the row otherwise.
    expect(
      forSibling.map((r) => r.event_type),
      "the conflicted copy never reached the event log, so a second device can never learn it exists",
    ).toEqual(["created"]);
    // And the original's update is still announced.
    expect(
      rows.filter((r) => r.item_id === id).map((r) => r.event_type),
    ).toContain("updated");

    // The losing text travels with it, or a replaying client rebuilds a
    // sibling with nothing in it.
    const payload = JSON.parse(forSibling[0]!.payload) as {
      item: { properties: Record<string, unknown> };
    };
    expect(payload.item.properties.body).toBe("the losing edit");
  });

  it("does not put the resolution report on the published item", async () => {
    const { id, base } = await collidingNote();
    const cursor = await logCursor();

    await request(ctx.app, "PATCH", `/items/${id}?conflict=auto`, {
      key: ctx.workingKey,
      body: { properties: { body: "report stays off the row" }, version: base },
    });

    const rows = await logSince(cursor);
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as {
        item: Record<string, unknown>;
      };
      // The row has no such column, so a stream subscriber must not see a
      // field that no HTTP read of the item returns.
      expect(
        "conflict_resolution" in payload.item,
        `${row.event_type} carried the resolution report on its item`,
      ).toBe(false);
      expect("conflict_sibling" in payload.item).toBe(false);
    }
  });

  it("announces nothing extra when a retry writes no new sibling", async () => {
    const { id, base } = await collidingNote();
    const key = `retry-${Math.random().toString(36).slice(2, 10)}`;

    const first = await request(
      ctx.app,
      "PATCH",
      `/items/${id}?conflict=auto`,
      {
        key: ctx.workingKey,
        headers: { "Idempotency-Key": key },
        body: { properties: { body: "retried edit" }, version: base },
      },
    );
    expect(first.status).toBe(200);

    // A second execution of the same write. The sibling already exists, so
    // announcing again would report a create that did not happen.
    const cursor = await logCursor();
    const again = await ctx.storage.items.update(id, {
      properties: { body: "retried edit" },
      version: base,
      conflict_mode: "auto",
      idempotency_key: key,
    });
    expect("error" in again).toBe(false);
    expect(
      "conflict_sibling" in (again as unknown as Record<string, unknown>),
      "a retry that wrote no row still offered one to announce",
    ).toBe(false);
    expect(await logSince(cursor)).toHaveLength(0);
  });
});

describe("a conflicted copy is findable", () => {
  it("is indexed for search like any other create", async () => {
    const { id, base } = await collidingNote();
    const needle = `zqxfindable${Math.random().toString(36).slice(2, 8)}`;

    // The control: an ordinary create, indexed by the path this one bypasses.
    const control = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { body: `${needle} control` } },
    });
    expect(control.status).toBe(201);
    const controlId = ((await control.json()) as { item: { id: string } }).item
      .id;

    const res = await request(ctx.app, "PATCH", `/items/${id}?conflict=auto`, {
      key: ctx.workingKey,
      body: { properties: { body: `${needle} sibling` }, version: base },
    });
    expect(res.status).toBe(200);
    const siblingId = (
      (await res.json()) as {
        conflict_resolution?: { conflicted_copy_id?: string };
      }
    ).conflict_resolution?.conflicted_copy_id;

    const found = await request(
      ctx.app,
      "GET",
      `/search?q=${encodeURIComponent(needle)}`,
      { key: ctx.workingKey },
    );
    expect(found.status).toBe(200);
    const ids = (
      (await found.json()) as { data: { item: { id: string } }[] }
    ).data.map((r) => r.item.id);
    // The control proves the query and the harness work, so a missing
    // sibling is the sibling's problem rather than the search's.
    expect(ids).toContain(controlId);
    expect(
      ids,
      "the conflicted copy was never indexed, so searching for the losing text does not find it",
    ).toContain(siblingId);
  });
});
