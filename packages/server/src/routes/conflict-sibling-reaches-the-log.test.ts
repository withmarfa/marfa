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
import { itemWrites } from "../storage/item-writes.js";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  TEST_API_KEY_SALT,
  type TestContext,
} from "../test-utils.js";
import { initEventLog, __resetEventLogForTests } from "../pubsub.js";
import { credentialScopedKey } from "../middleware/idempotency.js";
import { hashApiKey } from "../middleware/auth.js";

let ctx: TestContext;
/** The working key's id, the credential its idempotency keys belong to. */
let workingKeyId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  const working = await ctx.storage.keys.validate(
    hashApiKey(ctx.workingKey, TEST_API_KEY_SALT),
  );
  if (!working) throw new Error("the working key does not resolve");
  workingKeyId = working.id;
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

  it("appends a created row for each edge the sibling was given, after the sibling's", async () => {
    const { id, base } = await collidingNote();
    const parent = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { body: "the parent" } },
    });
    const parentId = ((await parent.json()) as { item: { id: string } }).item
      .id;
    const edge = await request(ctx.app, "POST", "/edges", {
      key: ctx.workingKey,
      body: { source_id: parentId, target_id: id, edge_type: "parent-of" },
    });
    expect(edge.status).toBe(201);
    const cursor = await logCursor();

    const res = await request(ctx.app, "PATCH", `/items/${id}?conflict=auto`, {
      key: ctx.workingKey,
      body: {
        properties: { body: "a losing edit with a parent" },
        version: base,
      },
    });
    expect(res.status).toBe(200);
    const siblingId = (
      (await res.json()) as {
        conflict_resolution?: { conflicted_copy_id?: string };
      }
    ).conflict_resolution?.conflicted_copy_id;

    const rows = await logSince(cursor);
    const siblingAt = rows.findIndex(
      (r) => r.item_id === siblingId && r.event_type === "created",
    );
    const edgeRows = rows.filter((r) => {
      if (!r.event_type.startsWith("edge")) return false;
      const payload = JSON.parse(r.payload) as {
        edge?: { source_id: string; target_id: string };
      };
      return (
        payload.edge?.source_id === parentId &&
        payload.edge.target_id === siblingId
      );
    });
    expect(
      edgeRows.map((r) => r.event_type),
      "the edge the sibling was given never reached the log",
    ).toEqual(["edge_created"]);
    expect(rows.indexOf(edgeRows[0]!)).toBeGreaterThan(siblingAt);
  });

  it("does not put the resolution report on the published item", async () => {
    const { id, base } = await collidingNote();
    const cursor = await logCursor();

    await request(ctx.app, "PATCH", `/items/${id}?conflict=auto`, {
      key: ctx.workingKey,
      body: { properties: { body: "report stays off the row" }, version: base },
    });

    const rows = await logSince(cursor);
    const items = rows.flatMap((row) => {
      const payload = JSON.parse(row.payload) as {
        item?: Record<string, unknown>;
      };
      return payload.item === undefined
        ? []
        : [{ event_type: row.event_type, item: payload.item }];
    });
    // The witness: the sibling's create and the original's update.
    expect(items.map((row) => row.event_type).sort()).toEqual([
      "created",
      "updated",
    ]);
    for (const row of items) {
      // The row has no such column, so a stream subscriber must not see a
      // field that no HTTP read of the item returns.
      expect(
        "conflict_resolution" in row.item,
        `${row.event_type} carried the resolution report on its item`,
      ).toBe(false);
      expect("conflict_sibling" in row.item).toBe(false);
    }
  });

  it("appends the edge linking the sibling to its original between the two", async () => {
    const { id, base } = await collidingNote();
    const cursor = await logCursor();

    const res = await request(ctx.app, "PATCH", `/items/${id}?conflict=auto`, {
      key: ctx.workingKey,
      body: { properties: { body: "a losing edit to link" }, version: base },
    });
    expect(res.status).toBe(200);
    const siblingId = (
      (await res.json()) as {
        conflict_resolution?: { conflicted_copy_id?: string };
      }
    ).conflict_resolution?.conflicted_copy_id;
    if (siblingId === undefined) throw new Error("no conflicted copy written");

    const rows = await logSince(cursor);
    const order = rows.map((r) => {
      const payload = JSON.parse(r.payload) as {
        edge?: { source_id: string; target_id: string; edge_type: string };
      };
      if (payload.edge === undefined) return `${r.event_type} ${r.item_id}`;
      const { source_id, edge_type, target_id } = payload.edge;
      return `${r.event_type} ${source_id} ${edge_type} ${target_id}`;
    });
    expect(
      order,
      "the link from the sibling to its original was not announced between the sibling's create and the original's update",
    ).toEqual([
      `created ${siblingId}`,
      `edge_created ${siblingId} derived-from ${id}`,
      `updated ${id}`,
    ]);
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
    const again = await itemWrites(ctx.storage).update(id, {
      writer: null,
      properties: { body: "retried edit" },
      version: base,
      may_read_type: () => true,
      conflict_mode: "auto",
      idempotency_key: credentialScopedKey(workingKeyId, key),
    });
    expect("error" in again).toBe(false);
    expect(
      "conflict_sibling" in (again as unknown as Record<string, unknown>),
      "a retry that wrote no row still offered one to announce",
    ).toBe(false);
    expect(await logSince(cursor)).toHaveLength(0);
  });

  it("gives a retry no second copy of an edge the sibling was given", async () => {
    const { id, base } = await collidingNote();
    const parent = await request(ctx.app, "POST", "/items", {
      key: ctx.workingKey,
      body: { type: "core.note", properties: { body: "the retried parent" } },
    });
    const parentId = ((await parent.json()) as { item: { id: string } }).item
      .id;
    const edge = await request(ctx.app, "POST", "/edges", {
      key: ctx.workingKey,
      body: { source_id: parentId, target_id: id, edge_type: "parent-of" },
    });
    expect(edge.status).toBe(201);
    const key = `retry-edge-${Math.random().toString(36).slice(2, 10)}`;

    const first = await request(
      ctx.app,
      "PATCH",
      `/items/${id}?conflict=auto`,
      {
        key: ctx.workingKey,
        headers: { "Idempotency-Key": key },
        body: { properties: { body: "retried edit, parented" }, version: base },
      },
    );
    expect(first.status).toBe(200);
    const siblingId = (
      (await first.json()) as {
        conflict_resolution?: { conflicted_copy_id?: string };
      }
    ).conflict_resolution?.conflicted_copy_id;
    const parentsOf = async () =>
      (await ctx.storage.edges.listToTarget(siblingId!)).data.filter(
        (held) => held.edge_type === "parent-of",
      );
    const originalsOf = async () =>
      (await ctx.storage.edges.listFromSource(siblingId!)).data.filter(
        (held) => held.edge_type === "derived-from",
      );
    // The witness: the first execution gave the sibling its parent and its
    // link to the original.
    expect(await parentsOf()).toHaveLength(1);
    expect((await originalsOf()).map((held) => held.target_id)).toEqual([id]);

    const cursor = await logCursor();
    const again = await itemWrites(ctx.storage).update(id, {
      writer: null,
      properties: { body: "retried edit, parented" },
      version: base,
      may_read_type: () => true,
      conflict_mode: "auto",
      idempotency_key: credentialScopedKey(workingKeyId, key),
      may_copy_edge: () => true,
    });
    expect("error" in again).toBe(false);
    expect(
      await parentsOf(),
      "a retry gave the sibling a second copy of its parent edge",
    ).toHaveLength(1);
    expect(
      await originalsOf(),
      "a retry gave the sibling a second link to its original",
    ).toHaveLength(1);
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
