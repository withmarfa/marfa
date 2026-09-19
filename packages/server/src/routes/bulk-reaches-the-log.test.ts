/**
 * Every bulk write reaches the event log.
 *
 * A durable client rebuilds its state by replaying `event_log` forward from
 * the last id it holds, so a write with no row in that log is one it can
 * never learn about — not on the next poll, not on reconnect, not ever.
 * `publish` is what appends the row, so a door that publishes conditionally
 * is a supported way to write invisibly.
 *
 * These assert on the log rather than on the emitter deliberately. The
 * emitter is what a live subscriber happens to be attached to; the log is
 * what a client that was offline reads, and it is the one a catch-up
 * depends on. A test that watched only the emitter would pass on an
 * implementation that emitted without persisting.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createTestContext,
  request,
  runBulkActionAsync,
  type TestContext,
} from "../test-utils.js";
import { initEventLog, __resetEventLogForTests } from "../pubsub.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
  // `createTestContext` does not wire the log — the server's bootstrap
  // does. Without this, `publish` appends nothing and every assertion
  // below would read an empty log whatever the routes did.
  initEventLog(ctx.storage.eventLog);
});

afterAll(async () => {
  __resetEventLogForTests();
  await ctx.cleanup();
});

/** Highest id in the log right now, so a case reads only its own rows. */
async function logCursor(): Promise<bigint> {
  const rows = await ctx.storage.eventLog.getAfter(0n, 100_000);
  return rows.reduce((max, r) => (r.id > max ? r.id : max), 0n);
}

async function logSince(cursor: bigint) {
  return ctx.storage.eventLog.getAfter(cursor, 100_000);
}

const uniq = () => Math.random().toString(36).slice(2, 10);

async function note(body: string, tags?: string[]): Promise<string> {
  const res = await request(ctx.app, "POST", "/items", {
    key: ctx.workingKey,
    body: {
      type: "core.note",
      properties: { body },
      source_id: `log-${uniq()}`,
      ...(tags ? { tags } : {}),
    },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { item: { id: string } }).item.id;
}

describe("POST /items/bulk reaches the event log", () => {
  it("logs one replayable row per written item with no flag set", async () => {
    const suffix = uniq();
    const cursor = await logCursor();

    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "first" },
            source_id: `reach-${suffix}-1`,
          },
          {
            type: "core.note",
            properties: { body: "second" },
            source_id: `reach-${suffix}-2`,
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    const written = (
      (await res.json()) as { results: { id?: string }[] }
    ).results
      .map((r) => r.id)
      .filter((id): id is string => Boolean(id));
    expect(written).toHaveLength(2);

    const rows = await logSince(cursor);
    const logged = rows.filter((r) => written.includes(r.item_id ?? ""));
    expect(logged.map((r) => r.item_id).sort()).toEqual(written.slice().sort());

    // Replayable, not merely present: a client rebuilds from the payload,
    // so a row naming an id it cannot resolve is no better than no row.
    for (const row of logged) {
      const payload = JSON.parse(row.payload) as {
        type: string;
        item: { id: string; type: string; properties: { body?: string } };
      };
      expect(payload.type).toBe("item.created");
      expect(payload.item.type).toBe("core.note");
      expect(payload.item.properties.body).toMatch(/first|second/);
    }
  });

  it("logs an update when a bulk upsert lands on an existing row", async () => {
    const suffix = uniq();
    const first = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "before" },
            source_id: `upsert-${suffix}`,
          },
        ],
      },
    });
    expect(first.status).toBe(200);

    const cursor = await logCursor();
    const second = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "after" },
            source_id: `upsert-${suffix}`,
          },
        ],
      },
    });
    expect(second.status).toBe(200);

    const rows = await logSince(cursor);
    const updates = rows.filter((r) => r.event_type === "updated");
    expect(updates).toHaveLength(1);
    const payload = JSON.parse(updates[0]!.payload) as {
      item: { properties: { body?: string } };
    };
    expect(payload.item.properties.body).toBe("after");
  });

  it("logs an inline edge alongside the item that carried it", async () => {
    const target = await note("inline target");
    const cursor = await logCursor();

    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: { body: "carries an edge" },
            source_id: `inline-${uniq()}`,
            edges: { references: [target] },
          },
        ],
      },
    });
    expect(res.status).toBe(200);

    const rows = await logSince(cursor);
    expect(rows.filter((r) => r.event_type === "edge_created")).toHaveLength(1);
  });
});

describe("POST /edges/bulk reaches the event log", () => {
  it("logs edge.created and edge.updated with no flag set", async () => {
    const a = await note("edge source");
    const b = await note("edge target");

    const createCursor = await logCursor();
    const created = await request(ctx.app, "POST", "/edges/bulk", {
      key: ctx.workingKey,
      body: {
        edges: [{ source_id: a, target_id: b, edge_type: "references" }],
      },
    });
    expect(created.status).toBe(200);
    const createdRows = await logSince(createCursor);
    expect(
      createdRows.filter((r) => r.event_type === "edge_created"),
    ).toHaveLength(1);

    // An upsert that replaces properties is an edit, and a subscriber
    // cannot tell it from one made through PATCH /edges/{id}.
    const updateCursor = await logCursor();
    const updated = await request(ctx.app, "POST", "/edges/bulk", {
      key: ctx.workingKey,
      body: {
        edges: [
          {
            source_id: a,
            target_id: b,
            edge_type: "references",
            properties: { note: "edited" },
          },
        ],
      },
    });
    expect(updated.status).toBe(200);
    const updatedRows = await logSince(updateCursor);
    expect(
      updatedRows.filter((r) => r.event_type === "edge_updated"),
    ).toHaveLength(1);
  });
});

describe("POST /items/bulk-actions reaches the event log", () => {
  it("logs a state change for every item a transition moved", async () => {
    const tag = `tr-${uniq()}`;
    const moved = await note("to archive", [tag]);
    const cursor = await logCursor();

    const run = await runBulkActionAsync(
      ctx,
      { action: "transition", state: "archived", filter: { tags: [tag] } },
      ctx.workingKey,
    );
    expect(run.result?.succeeded).toBe(1);

    const rows = await logSince(cursor);
    const changed = rows.filter(
      (r) => r.event_type === "state_changed" && r.item_id === moved,
    );
    expect(changed).toHaveLength(1);
    const payload = JSON.parse(changed[0]!.payload) as {
      item: { state: string };
    };
    expect(payload.item.state).toBe("archived");
  });

  it("logs the edges a purge cascaded", async () => {
    const tag = `pg-${uniq()}`;
    const doomed = await note("doomed", [tag]);
    const other = await note("survivor");
    const edge = await request(ctx.app, "POST", "/edges", {
      key: ctx.workingKey,
      body: { source_id: doomed, target_id: other, edge_type: "references" },
    });
    expect(edge.status).toBe(201);

    await runBulkActionAsync(
      ctx,
      { action: "transition", state: "trashed", filter: { tags: [tag] } },
      ctx.workingKey,
    );

    const cursor = await logCursor();
    const run = await runBulkActionAsync(
      ctx,
      {
        action: "purge",
        confirm: "PURGE",
        filter: { tags: [tag], state: "trashed" },
      },
      ctx.workingKey,
    );
    expect(run.result?.succeeded).toBe(1);

    const rows = await logSince(cursor);
    expect(rows.filter((r) => r.event_type === "edge_deleted")).toHaveLength(1);
  });

  it("logs a metadata change for every item update_tags touched", async () => {
    const tag = `tg-${uniq()}`;
    const tagged = await note("gets a tag", [tag]);
    const cursor = await logCursor();

    const run = await runBulkActionAsync(
      ctx,
      {
        action: "update_tags",
        add: ["added-by-bulk"],
        filter: { tags: [tag] },
      },
      ctx.workingKey,
    );
    expect(run.result?.succeeded).toBe(1);

    const rows = await logSince(cursor);
    const changed = rows.filter(
      (r) => r.event_type === "metadata_changed" && r.item_id === tagged,
    );
    expect(changed).toHaveLength(1);
    const payload = JSON.parse(changed[0]!.payload) as {
      metadata?: { tags?: string[] };
    };
    expect(payload.metadata?.tags).toContain("added-by-bulk");
  });

  it("logs a metadata change when update_tags lands on a trashed item", async () => {
    // `addTags` has no trashed guard, so the write lands and the id is
    // reported as succeeded. The publish read excluded trashed rows by
    // default, so the event never happened — a write with no log row,
    // reachable two ways: this filter, and any item trashed between the
    // match set being frozen and the worker running.
    const tag = `tt-${uniq()}`;
    const doomed = await note("tagged while trashed", [tag]);

    // A soft delete is the transition to trashed.
    const trashed = await request(ctx.app, "DELETE", `/items/${doomed}`, {
      key: ctx.workingKey,
    });
    expect(trashed.status).toBeLessThan(300);

    const cursor = await logCursor();
    const run = await runBulkActionAsync(
      ctx,
      {
        action: "update_tags",
        add: ["added-while-trashed"],
        filter: { tags: [tag], state: "trashed" },
      },
      ctx.workingKey,
    );
    expect(run.result?.succeeded).toBe(1);

    const rows = await logSince(cursor);
    const changed = rows.filter(
      (r) => r.event_type === "metadata_changed" && r.item_id === doomed,
    );
    expect(changed).toHaveLength(1);
    const payload = JSON.parse(changed[0]!.payload) as {
      metadata?: { tags?: string[] };
    };
    expect(payload.metadata?.tags).toContain("added-while-trashed");
  });

  it("logs an update for every item update_tier moved", async () => {
    const tag = `ti-${uniq()}`;
    const item = await note("retiered", [tag]);
    const cursor = await logCursor();

    const run = await runBulkActionAsync(
      ctx,
      { action: "update_tier", tier: "feed", filter: { tags: [tag] } },
      ctx.workingKey,
    );
    expect(run.result?.succeeded).toBe(1);

    const rows = await logSince(cursor);
    const changed = rows.filter(
      (r) => r.event_type === "updated" && r.item_id === item,
    );
    expect(changed).toHaveLength(1);
    const payload = JSON.parse(changed[0]!.payload) as {
      item: { tier?: string };
    };
    expect(payload.item.tier).toBe("feed");
  });

  it("logs an update for every item update_properties patched", async () => {
    const tag = `pr-${uniq()}`;
    const item = await note("patched", [tag]);
    const cursor = await logCursor();

    const run = await runBulkActionAsync(
      ctx,
      {
        action: "update_properties",
        patch: { body: "patched by bulk" },
        filter: { tags: [tag] },
      },
      ctx.workingKey,
    );
    expect(run.result?.succeeded).toBe(1);

    const rows = await logSince(cursor);
    const changed = rows.filter(
      (r) => r.event_type === "updated" && r.item_id === item,
    );
    expect(changed).toHaveLength(1);
    const payload = JSON.parse(changed[0]!.payload) as {
      item: { properties: { body?: string } };
    };
    expect(payload.item.properties.body).toBe("patched by bulk");
  });

  it("logs an update for every item update_occurred_at restamped", async () => {
    const tag = `ts-${uniq()}`;
    const item = await note("restamped", [tag]);
    const cursor = await logCursor();
    const when = "2021-03-04T05:06:07.000Z";

    const run = await runBulkActionAsync(
      ctx,
      {
        action: "update_occurred_at",
        occurred_at: when,
        filter: { tags: [tag] },
      },
      ctx.workingKey,
    );
    expect(run.result?.succeeded).toBe(1);

    const rows = await logSince(cursor);
    const changed = rows.filter(
      (r) => r.event_type === "updated" && r.item_id === item,
    );
    expect(changed).toHaveLength(1);
    const payload = JSON.parse(changed[0]!.payload) as {
      item: { occurred_at: string };
    };
    expect(payload.item.occurred_at).toBe(when);
  });
});

describe("the response carries the wire shape and nothing more", () => {
  /**
   * The written row travels beside the wire entry so the publish loop does
   * not read back what it just wrote. It must not travel *in* it: a
   * response is documented rather than validated, so nothing strips an
   * extra key, and five thousand entries each carrying a full item would
   * more than undo the saving that motivated carrying it at all.
   */
  it("does not return the written item on a bulk entry", async () => {
    const res = await request(ctx.app, "POST", "/items/bulk", {
      key: ctx.workingKey,
      body: {
        items: [
          {
            type: "core.note",
            properties: {
              body: "secret enough to notice",
              huge: "x".repeat(64),
            },
            source_id: `wire-${uniq()}`,
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Record<string, unknown>[];
    };
    expect(body.results).toHaveLength(1);
    const entry = body.results[0]!;
    expect(entry.outcome).toBe("created");
    expect(entry.id).toBeDefined();
    expect(Object.hasOwn(entry, "item")).toBe(false);
    // Named explicitly as well as by key count: an entry that gained the
    // row under some other name is the same leak.
    expect(Object.keys(entry).sort()).toEqual(["id", "index", "outcome"]);
  });
});

describe("the flag governs fan-out, not the log", () => {
  /**
   * The control that separates the two possible fixes.
   *
   * "Delete the filter" and "invert the flag's meaning" both make the
   * cases above pass. They differ here: if the flag were deleted rather
   * than repurposed, asking for fan-out and declining it would produce
   * different numbers of log rows. Setting it must change nothing about
   * what is logged.
   */
  it("logs the same rows whether or not fan-out is asked for", async () => {
    const countFor = async (enable: boolean): Promise<number> => {
      const cursor = await logCursor();
      const res = await request(ctx.app, "POST", "/items/bulk", {
        key: ctx.workingKey,
        body: {
          enable_fanout: enable,
          items: [
            {
              type: "core.note",
              properties: { body: `fanout ${String(enable)}` },
              source_id: `fan-${uniq()}`,
            },
            {
              type: "core.note",
              properties: { body: `fanout ${String(enable)} again` },
              source_id: `fan-${uniq()}`,
            },
          ],
        },
      });
      expect(res.status).toBe(200);
      return (await logSince(cursor)).filter((r) => r.event_type === "created")
        .length;
    };

    expect(await countFor(false)).toBe(2);
    expect(await countFor(true)).toBe(2);
  });
});
